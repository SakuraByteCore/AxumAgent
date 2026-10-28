import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentRegistry} from '../plugin/pi-agent/registry.ts';
import {inheritedToolCeiling,guardChildTools} from '../plugin/pi-agent/permissions.ts';
import {registerAgentManagement} from '../plugin/pi-agent/manage.ts';
test('batch ledger preserves pending, out-of-order completion and failures; slots release',()=>{
 const r=new AgentRegistry(2),a=r.reserve('a','batch'),b=r.reserve('b','batch');
 assert.throws(()=>r.reserve('c'),/concurrency/);r.attach(a,{id:'a',status:'running',responseText:''});
 r.attach(b,{id:'b',status:'idle',error:'auth',responseText:''});r.refresh();
 assert.equal(r.snapshot('batch')[1].state,'failed');r.reserve('c');
 a.agent.status='idle';a.agent.timeoutMs=20;a.agent.responseText='partial';r.refresh();
 assert.equal(r.snapshot()[0].state,'partial');assert.equal(r.snapshot()[0].response,'partial');
});
test('wait timeout and abort only stop observation; slow agent stays running',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const r=new AgentRegistry(),a=r.reserve('a');r.attach(a,{status:'running'});
 const wait=r.wait(['a'],100);t.mock.timers.tick(100);assert.equal((await wait).timedOut,true);assert.equal(a.state,'running');
 const controller=new AbortController();const aborted=r.wait(['a'],100,controller.signal);controller.abort();await assert.rejects(aborted,/continue/);assert.equal(a.state,'running');
 const done=r.wait(['a'],100);a.agent.status='idle';r.refresh();assert.equal((await done).timedOut,false);
});
test('permission ceiling denies write, bash, custom and recursive tools even on attempted widening',async()=>{
 const tools=inheritedToolCeiling(['read','bash','write','dispatch_agent','custom'],['read','write','ls']);assert.deepEqual(tools,['read']);
 let active,called=0;const session={setActiveToolsByName:n=>active=n,extensionRunner:{emitToolCall:async()=>{called++;}}};
 guardChildTools(session,tools);assert.deepEqual(active,['read']);
 assert.equal((await session.extensionRunner.emitToolCall({toolName:'bash'})).block,true);
 await session.extensionRunner.emitToolCall({toolName:'read'});assert.equal(called,1);
 assert.deepEqual(inheritedToolCeiling(['read'],undefined,[],true),[]);
});
test('one-shot management rejects continuation and awaits cancellation cleanup',async()=>{
 const r=new AgentRegistry(),record=r.reserve('a','batch');let cancels=0,retired=0,resolve;
 const a={id:'a',status:'running',oneShot:true,finished:new Promise(r=>resolve=r),retire:()=>retired++,runHandle:{cancel:async()=>{cancels++;a.status='idle';resolve();}}};r.attach(record,a);
 let tool;registerAgentManagement({registerTool:t=>tool=t},r,new Set([a]));
 for(const action of ['send','resume','rebase'])await assert.rejects(tool.execute('',{action,agentId:'a',input:'continue'}),/One-shot/);
 await tool.execute('',{action:'interrupt',agentId:'a'});assert.equal(a.interruptRequested,true);assert.equal(cancels,1);assert.equal(retired,1);assert.equal(record.state,'cancelled');
 await tool.execute('',{action:'close',batchId:'batch'});assert.equal(cancels,1);
});

test('pending close is terminal and shutdown generation fences late startup',async()=>{
 const r=new AgentRegistry(),pending=r.reserve('pending');let tool;registerAgentManagement({registerTool:t=>tool=t},r,new Set());
 await tool.execute('',{action:'close',agentId:'pending'});assert.equal(pending.state,'closed');
 assert.throws(()=>r.attach(pending,{id:'pending'}),/closed/);
 const another=r.reserve('other');const generation=r.generation;r.shutdown();
 assert.notEqual(r.generation,generation);assert.equal(another.state,'closed');assert.throws(()=>r.attach(another,{}),/closed/);
});

test('real AgentSession pre-tool hook enforces ceiling without companion handlers',async()=>{
 const {AgentSession}=await import('@earendil-works/pi-coding-agent');
 const runner={hasHandlers:()=>false,emitToolCall:async()=>undefined};
 const agent={};const session={agent,_extensionRunner:runner,extensionRunner:runner,setActiveToolsByName:()=>{}};
 session._beforeToolCall=AgentSession.prototype._beforeToolCall;
 AgentSession.prototype._installAgentToolHooks.call(session);
 guardChildTools(session,['read']);
 const denied=await agent.beforeToolCall({toolCall:{id:'x',name:'bash'},args:{command:'echo denied'}});
 assert.equal(denied.block,true);
 assert.equal(await agent.beforeToolCall({toolCall:{id:'y',name:'read'},args:{path:'a'}}),undefined);
});

test('partial cancellation retains evidence and scope until native cleanup settles',async()=>{
 const r=new AgentRegistry(),record=r.reserve('partial');let tool,released=0,cleanup;
 const finished=new Promise(resolve=>cleanup=resolve);
 const a={id:'partial',status:'running',responseText:'partial evidence',oneShot:true,finished,runHandle:{cancel:()=>finished},retire:()=>{}};
 record.releaseScope=()=>released++;r.attach(record,a);
 registerAgentManagement({registerTool:t=>tool=t},r,new Set([a]));
 const closing=tool.execute('',{action:'close',agentId:a.id});await Promise.resolve();
 assert.equal(released,0);assert.equal(record.state,'running');
 a.status='idle';cleanup();await closing;r.refresh();
 assert.equal(record.state,'closed');assert.equal(r.snapshot()[0].response,'partial evidence');
});
