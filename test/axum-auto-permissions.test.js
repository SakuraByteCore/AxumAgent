import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bridgedChildTools,inheritedToolCeiling,WriteScopeLocks} from '../plugin/pi-agent/permissions.ts';
test('bridge intersects active parent and excludes recursive delegation',()=>{
 assert.deepEqual(inheritedToolCeiling(['read'],['write','read'],[],false,true),['read']);
 assert.deepEqual(inheritedToolCeiling(['read','write','dispatch_agent'],undefined,[],false,true),['read','write']);
});
test('write and edit enter parent executor, scope escapes and approval denial fail closed',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'axum-permissions-'));let calls=0;
 const bridge={tools:['write','edit','bash'].map(name=>({name,sourceInfo:{source:"builtin",path:`builtin:${name}`},parameters:{type:'object'},description:name})),getActiveTools:()=>['write','edit','bash'],executeTool:async(name,args)=>{calls++;if(name==='bash')return {isError:true,result:{content:[{type:'text',text:'approval denied'}]}};writeFileSync(args.path,args.content);return {result:{content:[]}};}};
 const tools=bridgedChildTools(bridge,['write','edit','bash'],[join(cwd,'owned')],cwd,['npm test']);
 await tools[0].execute('',{path:join(cwd,'owned'),content:'ok'});assert.equal(readFileSync(join(cwd,'owned'),'utf8'),'ok');
 await assert.rejects(tools[1].execute('',{path:join(cwd,'other'),content:'no'}),/outside/);assert.equal(calls,1);
 symlinkSync(join(cwd,'other'),join(cwd,'link'));
 await assert.rejects(tools[0].execute('',{path:join(cwd,'link'),content:'no'}),/outside|Dangling/);
 await assert.rejects(tools[2].execute('',{command:'npm test'}),/approval denied/);
 await assert.rejects(bridgedChildTools(bridge,['bash'],[],cwd)[0].execute('',{}),/testCommands/);
});
test('overlapping scope locks reject and release is idempotent',()=>{
 const locks=new WriteScopeLocks();const release=locks.acquire('a',['src'],process.cwd());
 assert.throws(()=>locks.acquire('b',['src/file'],process.cwd()),/conflicts/);
 locks.acquire('c',['test'],process.cwd())();release();release();locks.acquire('b',['src'],process.cwd())();
});
test('real SDK nested executor uses parent hooks rather than raw write implementation',async(t)=>{
 const {AgentSession}=await import(process.env.AXUM_PERMISSION_SDK ?? '@earendil-works/pi-coding-agent');
 if(!AgentSession.prototype._executeNestedToolCall){t.skip('Installed legacy SDK has no nested parent executor; supply AXUM_PERMISSION_SDK for modern SDK verification');return;}
 let checked=0,executed=0;
 const tool={name:'write',sourceInfo:{source:'builtin',path:'builtin:write'},description:'write',parameters:{type:'object',properties:{path:{type:'string'}}},execute:async()=>{executed++;return {content:[]};}};
 const parent={agent:{toolExecution:'parallel',state:{messages:[],tools:[tool]}},_getCallableTools:()=>[tool],_findLastAssistantMessage:()=>({role:'assistant',content:[],api:'openai-completions',provider:'test',model:'test',usage:{},stopReason:'toolUse',timestamp:0}),_beforeToolCall:async()=>{checked++;return {block:true,reason:'parent approval denied'};},_afterToolCall:async()=>{},_extensionRunner:{emit:async()=>{}},_emit:()=>{}};
 const bridge={tools:[tool],getActiveTools:()=>["write"],executeTool:(name,args,options)=>AgentSession.prototype._executeNestedToolCall.call(parent,'dispatch-1',name,args,options)};
 const child=bridgedChildTools(bridge,['write'],[process.cwd()],process.cwd())[0];
 await assert.rejects(child.execute('',{path:join(process.cwd(),'example')},new AbortController().signal),/parent approval denied/);
 assert.equal(checked,1);assert.equal(executed,0);
});

test('unknown custom tools and forged builtin sources are excluded',()=>{
 const bridge={tools:[{name:'custom'},{name:'write',sourceInfo:{source:'extension'}},...['read','grep'].map(name=>({name,sourceInfo:{source:'cli',path:join(process.cwd(),'untrusted/pi-hashline-edit-pro/index.js')}}))]};
 assert.deepEqual(bridgedChildTools(bridge,['custom','write','read','grep'],[process.cwd()],process.cwd()),[]);
 assert.deepEqual(inheritedToolCeiling(['custom','write'],undefined,[],false,true),['write']);
});
test('live parent revocation and exact shell capability reject before executor',async()=>{
 let active=['bash'],calls=0;const bridge={tools:[{name:'bash',sourceInfo:{source:'builtin',path:'builtin:bash'}}],getActiveTools:()=>active,executeTool:async()=>{calls++;return {result:{content:[]}}}};
 const tool=bridgedChildTools(bridge,['bash'],[process.cwd()],process.cwd(),['npm test'])[0];
 await assert.rejects(tool.execute('',{command:'npm test; echo bad'}),/testCommands/);
 active=[];await assert.rejects(tool.execute('',{command:'npm test'}),/no longer active/);assert.equal(calls,0);
});
test('write scopes outside cwd fail closed',()=>{assert.throws(()=>new WriteScopeLocks().acquire('x',['..'],process.cwd()),/within cwd/);});

test('completed turn releases lock and continuation reacquires atomically against sibling',async()=>{
 const {AgentRegistry}=await import('../plugin/pi-agent/registry.ts');
 const locks=new WriteScopeLocks(),registry=new AgentRegistry();
 const first=registry.reserve('a');
 first.acquireScope=()=>{first.releaseScope=locks.acquire('a',['src'],process.cwd());};first.acquireScope();
 registry.attach(first,{id:'a',status:'idle',responseText:'done'});registry.refresh();
 const sibling=locks.acquire('b',['src'],process.cwd());
 assert.throws(()=>first.acquireScope(),/conflicts/);assert.equal(first.state,'completed');
 sibling();first.acquireScope();registry.fail(first,'failed');
 locks.acquire('b',['src'],process.cwd())();
 first.acquireScope();registry.shutdown();assert.throws(()=>locks.acquire('b',['src'],process.cwd()),/conflicts/);registry.fail(first,'cleanup finished');locks.acquire('b',['src'],process.cwd())();
});

test('dangling scope and nested symlinks fail closed; aliases share locks',async()=>{
 const {mkdirSync,rmSync,existsSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'axum-dangling-')),cwd=join(root,'work');mkdirSync(cwd);
 try{
  symlinkSync('../outside',join(cwd,'owned'));
  const locks=new WriteScopeLocks();assert.throws(()=>locks.acquire('a',['owned'],cwd),/Dangling/);
  mkdirSync(join(cwd,'safe'));symlinkSync('../../outside',join(cwd,'safe','escape'));
  let calls=0;const bridge={tools:[{name:'write',sourceInfo:{source:'builtin',path:'builtin:write'}}],getActiveTools:()=>['write'],executeTool:async()=>{calls++;return {result:{content:[]}}}};
  const write=bridgedChildTools(bridge,['write'],['safe'],cwd)[0];
  await assert.rejects(write.execute('x',{path:'safe/escape',content:'bad'}),/Dangling/);
  await assert.rejects(write.execute('x',{path:'safe/escape/new',content:'bad'}),/Dangling/);
  assert.equal(calls,0);assert.equal(existsSync(join(root,'outside')),false);
  symlinkSync('safe',join(cwd,'alias'));const release=locks.acquire('a',['safe'],cwd);
  assert.throws(()=>locks.acquire('b',['alias/new'],cwd),/conflicts/);release();locks.acquire('b',['alias/new'],cwd)();
 }finally{rmSync(root,{recursive:true,force:true});}
});
