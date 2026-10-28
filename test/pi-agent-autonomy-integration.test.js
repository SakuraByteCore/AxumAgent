import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync,symlinkSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileExtensionPackage} from '../src/compile-bundled-extensions.js';

// Fixed fake-model decisions prove SDK/tool wiring, not autonomous model quality.
const sdkModules=process.env.AXUM_INTEGRATION_NODE_MODULES || resolve('../../refs/axum-validation/pi-cache/node_modules');
const available=existsSync(join(sdkModules,'@earendil-works/pi-coding-agent/package.json'));
test('real SDK: ordinary goal, policy hook, dispatch, scoped writes, observation and cleanup', {skip:!available,timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'axum-sdk-integration-'));
 const sessions=[];
 try{
  symlinkSync(sdkModules,join(root,'node_modules'),'dir');
  cpSync(resolve('plugin/pi-agent'),join(root,'plugin'),{recursive:true});
  compileExtensionPackage({packageRoot:join(root,'plugin')});
  const sdk=await import(pathToFileURL(join(sdkModules,'@earendil-works/pi-coding-agent/dist/index.js')).href);
  const ai=await import(pathToFileURL(join(sdkModules,'@earendil-works/pi-ai/dist/index.js')).href);
  const {registerAutonomousPolicy}=await import(pathToFileURL(join(root,'plugin/autonomous.js')).href);
  const {registerDispatch}=await import(pathToFileURL(join(root,'plugin/dispatch.js')).href);
  const {bridgedChildTools,inheritedToolCeiling,WriteScopeLocks}=await import(pathToFileURL(join(root,'plugin/permissions.js')).href);
  const {AgentRegistry}=await import(pathToFileURL(join(root,'plugin/registry.js')).href);
  const runtime=await sdk.ModelRuntime.create({modelsPath:null,refreshOnCreate:false});
  const model=runtime.getModels().find(m=>m.provider==='openai');assert.ok(model,'offline catalog model required');
  runtime.hasConfiguredAuth=()=>true;
  runtime.getAuth=async()=>({auth:{apiKey:'local-fake-no-network'}});
  const ledger=new AgentRegistry(),locks=new WriteScopeLocks(),runs=[],events=[];
  let parentBridge,policySeen=false;
  const childProxyCounts=[];
  function stream(calls){return async(m,context)=>{
   const content=typeof calls==='function'?calls(context):[];
   const message={role:'assistant',content:content.length?content:[{type:'text',text:'verified'}],api:m.api,provider:m.provider,model:m.id,stopReason:content.length?'toolUse':'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
   const s=new ai.AssistantMessageEventStream();s.push({type:'done',reason:message.stopReason,message});s.end(message);return s;
  };}
  async function session(customTools,extensions=[]){
   const settings=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
   const loader=new sdk.DefaultResourceLoader({cwd:root,agentDir:join(root,'config'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:extensions});await loader.reload();
   const {session:s}=await sdk.createAgentSession({cwd:root,agentDir:join(root,'config'),modelRuntime:runtime,model,settingsManager:settings,sessionManager:sdk.SessionManager.inMemory(root),resourceLoader:loader,customTools,tools:['write','read',...(extensions.length?['dispatch_agent']:[]),...customTools.map(t=>t.name)]});
   sessions.push(s);await s.bindExtensions({});return s;
  }
  function first(context){return !context.messages.some(m=>m.role==='assistant');}
  const extension=pi=>{
   registerAutonomousPolicy(pi);
   pi.on('tool_call',e=>{events.push(e.toolName);if(e.toolName==='write'&&e.input.path==='denied.txt')return {block:true,reason:'parent read-only policy'};});
   registerDispatch(pi,{isShuttingDown:()=>false,startAgent:async(_args,_invocation,ctx,_deadline,batch,permissions)=>{
    parentBridge=permissions.bridge;const id=String(ledger.records.size+1),record=ledger.reserve(id,batch),scope=permissions.writeScope;
    const release=locks.acquire(id,scope,root);
    const bridge=permissions.bridge;
    assert.ok(bridge,'dispatch supplies a parent permission bridge');
    assert.equal(typeof bridge.getActiveTools,'function');
    assert.equal(typeof bridge.validate,'function');
    const write=bridge.tools.find(t=>t.name==='write');
    assert.equal(write?.sourceInfo?.source,'builtin');
    assert.equal(write?.sourceInfo?.path,'builtin:write');
    const allowed=inheritedToolCeiling(bridge.getActiveTools(),['write','read'],[],false,true);
    const proxies=bridgedChildTools(bridge,allowed,scope,root,permissions.testCommands);
    assert.deepEqual(proxies.map(t=>t.name).sort(),['read','write'],'child must use parent-mediated custom tools, never raw builtin fallback');
    childProxyCounts.push(proxies.length);
    const child=await session(proxies);
    const file=scope[0];child.agent.streamFunction=stream(c=>first(c)?[{type:'toolCall',id:'write-'+id,name:'write',arguments:{path:file,content:'export const value = '+id+';\n'}}]:[]);
    const agent={id,modelLabel:'fixed-fake',task:file,status:'running',responseText:'',session:child};
    ledger.attach(record,agent);const run=child.prompt('Implement assigned module').then(()=>{agent.status='idle';agent.responseText='done';ledger.refresh();}).finally(release);runs.push(run);return agent;
   }});
  };
  const parent=await session([], [extension]);
  parent.agent.streamFunction=stream(c=>{policySeen ||= JSON.stringify(c).includes('Autonomous delivery policy');return first(c)?['a.mjs','b.mjs'].map((path,i)=>({type:'toolCall',id:'dispatch-'+i,name:'dispatch_agent',arguments:{task:'Implement '+path,writeScope:[path],batchId:'goal',squash:false}})):[];});
  await parent.prompt('Deliver two independent modules and verify their values.');await Promise.all(runs);
  assert.equal(policySeen,true);assert.equal(runs.length,2,JSON.stringify(parent.agent.state.messages));assert.deepEqual(childProxyCounts,[2,2]);assert.deepEqual(ledger.snapshot().map(r=>r.state),['completed','completed']);
  assert.equal((await import(pathToFileURL(join(root,'a.mjs')).href)).value,1);assert.equal((await import(pathToFileURL(join(root,'b.mjs')).href)).value,2);
  assert.equal(events.filter(n=>n==='write').length,2,'worker writes re-enter real parent tool hooks');
  const bridge=parentBridge;
  const guarded=bridgedChildTools(bridge,['write'],['a.mjs'],root)[0];
  await assert.rejects(guarded.execute('escape',{path:'escape.txt',content:'bad'}),/outside/);assert.equal(existsSync(join(root,'escape.txt')),false);
  const denied=bridgedChildTools(bridge,['write'],['denied.txt'],root)[0];await assert.rejects(denied.execute('denied',{path:'denied.txt',content:'bad'}),/parent read-only/);assert.equal(existsSync(join(root,'denied.txt')),false);
  assert.ok(readFileSync(join(root,'a.mjs'),'utf8').includes('value'));
  // Real SDK streaming remains active after collector timeout; close aborts it.
  const slow=await session([]);let finish,aborted=false;
  slow.agent.streamFunction=async(m,_context,options)=>{
   const output=new ai.AssistantMessageEventStream();
   const complete=()=>{const message={role:'assistant',content:[{type:'text',text:'slow done'}],api:m.api,provider:m.provider,model:m.id,stopReason:aborted?'aborted':'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};output.push({type:'done',reason:message.stopReason,message});output.end(message);};
   finish=complete;options.signal.addEventListener('abort',()=>{aborted=true;complete();},{once:true});return output;
  };
  const slowRecord=ledger.reserve('slow'),slowAgent={id:'slow',status:'running',session:slow,responseText:''};ledger.attach(slowRecord,slowAgent);
  const slowRun=slow.prompt('slow local model').then(()=>{slowAgent.status='idle';ledger.refresh();});
  while(!finish)await new Promise(r=>setTimeout(r,1));
  assert.equal((await ledger.wait(['slow'],5)).timedOut,true);assert.equal(aborted,false);assert.equal(slow.isStreaming,true);
  finish();await slowRun;assert.equal((await ledger.wait(['slow'],50)).timedOut,false);
  const {registerAgentManagement}=await import(pathToFileURL(join(root,'plugin/manage.js')).href);
  let management;registerAgentManagement({registerTool:t=>management=t},ledger,new Set([slowAgent]));
  slowAgent.status='running';slowRecord.state='running';slowAgent.retire=()=>{};
  finish=undefined;const cancelledRun=slow.prompt('another slow turn');while(!finish)await new Promise(r=>setTimeout(r,1));
  await management.execute('close',{action:'close',agentId:'slow'});await cancelledRun;
  assert.equal(aborted,true);assert.equal(slow.isStreaming,false);assert.equal(slowRecord.state,'closed');
 }finally{for(const s of sessions){await s.abort();s.dispose();}rmSync(root,{recursive:true,force:true});}
});
