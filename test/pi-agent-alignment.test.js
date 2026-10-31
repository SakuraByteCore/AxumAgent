import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileOutputSchema,outputSchemaInstruction} from '../plugin/pi-agent/structured-output.ts';
import {TaskHistory} from '../plugin/pi-agent/history.ts';
import {AgentRegistry} from '../plugin/pi-agent/registry.ts';
import {bridgedChildTools,inheritedToolCeiling} from '../plugin/pi-agent/permissions.ts';
import {buildAgentCommandRequest,buildDispatchArgs,registerDispatch} from '../plugin/pi-agent/dispatch.ts';

test('output contract checks nested evidence, preserves false/null and rejects invalid JSON',()=>{
 const schema={type:'object',required:['conclusion','evidence','unresolved'],additionalProperties:false,properties:{conclusion:{type:'string'},evidence:{type:'array',items:{type:'string'}},unresolved:{type:'array',items:{type:'string'}}}};
 const check=compileOutputSchema(schema),value={conclusion:'done',evidence:['test passed'],unresolved:[]};
 assert.deepEqual(check(JSON.stringify(value)),{valid:true,value,errors:[]});
 assert.equal(check('```json\n'+JSON.stringify(value)+'\n```').valid,true);
 assert.equal(check('{"conclusion":1}').valid,false);
 assert.equal(check('done').valid,false);
 assert.deepEqual(compileOutputSchema({type:'null'})('null').value,null);
 assert.equal(compileOutputSchema(false)('{}').valid,false);
 assert.match(outputSchemaInstruction(schema),/never replayed/);
 assert.throws(()=>compileOutputSchema({type:'not-a-json-type'}));
});

test('full tools bridge forwards custom MCP/web/write/bash and honors live parent revocation',async()=>{
 let active=['read','write','bash','web_search','mcp','dispatch_agent','manage_agent'],calls=[];
 const tools=active.map(name=>({name,parameters:{type:'object'},description:name,sourceInfo:{source:'extension',path:'/plugins/'+name}}));
 const bridge={tools,getActiveTools:()=>active,executeTool:async(name,args)=>{calls.push({name,args});return {result:{content:[{type:'text',text:'ok'}]},isError:false};}};
 const ceiling=inheritedToolCeiling(active,undefined,[],false,true,true);
 assert.deepEqual(ceiling,['read','write','bash','web_search','mcp']);
 const proxies=bridgedChildTools(bridge,ceiling,[],process.cwd(),[],true);
 for(const proxy of proxies)await proxy.execute('call',{path:'any.txt',command:'arbitrary command'});
 assert.equal(calls.length,ceiling.length);
 active=[];await assert.rejects(proxies[0].execute('revoked',{}),/no longer active/);
 assert.deepEqual(inheritedToolCeiling(['mcp','bash'],undefined,[],false,false,true),[]);
});

test('/agent requests exactly one bridged dispatch preserving literal flags and task',()=>{
 const args='-m provider/model --tools read,bash -P inspect "a b"';
 const request=buildAgentCommandRequest(args),params=JSON.parse(request.split('\n').at(-1));
 assert.equal(params.fullTools,true);assert.equal(params.agentArgs,args);
 assert.equal(buildDispatchArgs(params),args);
});

test('dispatch rejects unsupported schema before executing child effects',async()=>{
 let tool,starts=0;
 registerDispatch({registerTool:t=>tool=t,registerCommand:()=>{}},{isShuttingDown:()=>false,startAgent:async()=>{starts++;}});
 const result=await tool.execute('',{task:'task',outputSchema:{type:'invalid'}},undefined,undefined,{});
 assert.equal(starts,0);assert.ok(result.details.error);
});

test('persisted results survive registry restart, retain structured output and never restore workers',()=>{
 const root=mkdtempSync(join(tmpdir(),'axum-history-'));
 try {
  const ledger=new AgentRegistry();ledger.bindHistory(root,root,'parent');
  const pending=ledger.reserve('user-1','batch');
  ledger.attach(pending,{id:'user-1',task:'inspect',status:'running'});
  const complete=ledger.reserve('user-2','batch');
  ledger.attach(complete,{id:'user-2',status:'idle',task:'implement',responseText:'{"done":true}',structuredResult:{valid:true,value:{done:true},errors:[]}});
  ledger.refresh();assert.equal(ledger.historyError,undefined);
  const history=new TaskHistory(root,root,'next-parent');
  const records=history.read({batchId:'batch'});
  assert.equal(records.find(r=>r.id==='user-1').state,'unknown_after_restart');
  const done=records.find(r=>r.id==='user-2');assert.equal(done.state,'completed');assert.deepEqual(done.structuredResult.value,{done:true});assert.equal(done.live,false);
  const restarted=new AgentRegistry();restarted.bindHistory(root,root,'parent');restarted.reserve('user-1');
  assert.equal(history.read().length,3,'same-parent restart does not overwrite previous user-1');
  mkdirSync(join(root,'other'));assert.deepEqual(new TaskHistory(root,join(root,'other'),'parent').read(),[]);
  assert.equal(history.read({limit:1}).length,1);
 } finally {rmSync(root,{recursive:true,force:true});}
});


test('batch dispatch admits independent roles concurrently in one tool call',async()=>{
 let tool,release;const started=[];const ready=new Promise(resolve=>release=resolve);
 registerDispatch({registerTool:t=>tool=t,registerCommand:()=>{}},{isShuttingDown:()=>false,startAgent:async(args,_inv,_ctx,deadline,batchId,permissions)=>{
  started.push({args,deadline,batchId,role:permissions.role});await ready;
  return {id:args.includes('first')?'a':'b',modelLabel:'current',task:args,status:'running'};
 }});
 const pending=tool.execute('batch',{batchId:'parallel',tasks:[{task:'first',role:'fixer'},{task:'second',role:'explorer'}]},undefined,undefined,{});
 assert.equal(started.length,2,'both starts run before either admission resolves');
 assert.deepEqual(started.map(x=>x.role),['fixer','explorer']);assert.ok(started.every(x=>x.deadline===undefined));
 release();const result=await pending;assert.deepEqual(result.details.records.map(r=>r.agentId),['a','b']);
 assert.ok(result.details.records.every(r=>r.batchId==='parallel'));
 await assert.rejects(tool.execute('',{tasks:[{task:'bad',role:'unknown'}]},undefined,undefined,{}),/Unknown agent role/);
 assert.equal(started.length,2);
});


test('scoped research inherits verified LSP without a workspace write lock',async()=>{
 const tools=[{name:'lsp',parameters:{type:'object'},sourceInfo:{source:'extension',path:fileURLToPath(new URL('../plugin/pi-agent/index.ts',import.meta.url))}}];
 let calls=0;const bridge={tools,getActiveTools:()=>['lsp'],executeTool:async()=>{calls++;return {result:{content:[]}};}};
 const names=inheritedToolCeiling(['lsp'],undefined,[],false,true);
 const proxies=bridgedChildTools(bridge,names,[],process.cwd());assert.equal(proxies.length,1);
 await proxies[0].execute('query',{action:'status'});assert.equal(calls,1);
});
