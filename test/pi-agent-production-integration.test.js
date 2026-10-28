import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync,symlinkSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileExtensionPackage} from '../src/compile-bundled-extensions.js';

const modules=process.env.AXUM_INTEGRATION_NODE_MODULES || resolve('../../refs/axum-validation/pi-cache/node_modules');
const available=existsSync(join(modules,'@earendil-works/pi-coding-agent/package.json'));
// Deterministic model decisions; the SDK, index extension, runner and tools are real.
test('production index dispatch: SDK child, scoped tools, live bridge, send and close', {skip:!available,timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'axum-production-sdk-'));
 const saved=Object.fromEntries(['PI_CODING_AGENT_DIR','PI_OFFLINE','AXUM_DESKTOP_PET'].map(k=>[k,process.env[k]]));
 Object.assign(process.env,{PI_CODING_AGENT_DIR:join(root,'agent'),PI_OFFLINE:'1',AXUM_DESKTOP_PET:'0'});
 let parent,api,captured;
 try{
  symlinkSync(modules,join(root,'node_modules'),'dir');
  cpSync(resolve('plugin/pi-agent'),join(root,'plugin'),{recursive:true});
  compileExtensionPackage({packageRoot:join(root,'plugin')});
  const sdk=await import(pathToFileURL(join(modules,'@earendil-works/pi-coding-agent/dist/index.js')).href);
  const ai=await import(pathToFileURL(join(modules,'@earendil-works/pi-ai/dist/index.js')).href);
  const plugin=(await import(pathToFileURL(join(root,'plugin/index.js')).href)).default;
  const runtime=await sdk.ModelRuntime.create({modelsPath:null,authPath:join(root,'agent/auth.json'),refreshOnCreate:false});
  const events=[],childContexts=[];
  const command='node --check module.mjs';
  let dispatchReturned=false,releaseChild;
  const barrier=new Promise(r=>{releaseChild=r;});
  const call=(name,args,id=name)=>({type:'toolCall',name,id,arguments:args});
  function response(m,content){
   const message={role:'assistant',content:content.length?content:[{type:'text',text:'verified'}],api:m.api,provider:m.provider,model:m.id,stopReason:content.length?'toolUse':'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
   const s=new ai.AssistantMessageEventStream();s.push({type:'done',reason:message.stopReason,message});s.end(message);return s;
  }
  runtime.registerProvider('production-fixture',{api:'openai-completions',apiKey:'fixture-only',baseUrl:'http://invalid.local',models:[{id:'fixed',name:'fixed',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}],streamSimple:(m,c)=>{
   const s=new ai.AssistantMessageEventStream();
   void (async()=>{
    await barrier;childContexts.push(c);
    const lastUser=c.messages.findLastIndex(x=>x.role==='user');
    const followup=JSON.stringify(c.messages[lastUser]).includes('FOLLOWUP');
    const already=c.messages.slice(lastUser+1).some(x=>x.role==='assistant');
    const content=already?[]:followup?[call('write',{path:'module.mjs',content:'export const value = 2;\n'},'followup-write')]:[
     call('write',{path:'module.mjs',content:'export const value = 1;\n'}),
     call('write',{path:'escape.txt',content:'bad'},'escape'),
     call('write',{path:'blocked.mjs',content:'bad'},'hook-denied'),
     call('bash',{command},'test'),
     call('bash',{command:'node --version'},'not-authorized')];
    const result=await response(m,content).result();s.push({type:'done',reason:result.stopReason,message:result});s.end(result);
   })().catch(e=>s.end({role:'assistant',content:[],stopReason:'error',errorMessage:String(e)}));return s;
  }});
  const model=runtime.getModel('production-fixture','fixed');assert.ok(model);
  const settings=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const extension=pi=>{
   api=pi;plugin(pi);
   pi.on('tool_call',e=>{events.push({name:e.toolName,input:e.input,afterDispatch:dispatchReturned});if(e.toolName==='write'&&e.input.path==='blocked.mjs')return {block:true,reason:'production parent hook denied'};});
   pi.registerTool({name:'capture_context',label:'capture',description:'Capture real durable tool context',parameters:{type:'object',properties:{}},execute:async(_id,_args,_signal,_update,ctx)=>{captured=ctx;return {content:[{type:'text',text:'captured'}]};}});
  };
  const loader=new sdk.DefaultResourceLoader({cwd:root,agentDir:join(root,'agent'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});await loader.reload();
  ({session:parent}=await sdk.createAgentSession({cwd:root,agentDir:join(root,'agent'),modelRuntime:runtime,model,settingsManager:settings,sessionManager:sdk.SessionManager.inMemory(root),resourceLoader:loader,tools:['read','write','bash','dispatch_agent','manage_agent','capture_context']}));
  await parent.bindExtensions({mode:'print'});
  let turn=0;
  parent.agent.streamFunction=async(m)=>response(m,turn++===0?[call('capture_context',{}),call('dispatch_agent',{task:'Implement module',writeScope:['module.mjs','blocked.mjs'],testCommands:[command],squash:false,batchId:'production'})]:[]);
  await parent.prompt('Implement and verify one module using a child.');dispatchReturned=true;
  const dispatch=parent.agent.state.messages.find(x=>x.role==='toolResult'&&x.toolName==='dispatch_agent');
  assert.ok(dispatch&&!dispatch.isError,JSON.stringify(parent.agent.state.messages));
  const id=dispatch.details.agentId;assert.ok(id,JSON.stringify({dispatch,tools:api.getAllTools().filter(t=>['write','read','bash'].includes(t.name)).map(t=>({name:t.name,sourceInfo:t.sourceInfo}))}));assert.ok(captured);
  async function manage(action,extra={}){const out=await captured.executeTool('manage_agent',{action,agentId:id,...extra});assert.equal(out.isError,false,JSON.stringify(out));return out.result;}
  releaseChild();
  const waited=await manage('wait',{timeoutMs:10000});assert.equal(waited.details.timedOut,false,JSON.stringify(waited));
  assert.equal(readFileSync(join(root,'module.mjs'),'utf8'),'export const value = 1;\n');
  assert.equal(existsSync(join(root,'escape.txt')),false);assert.equal(existsSync(join(root,'blocked.mjs')),false);
  assert.ok(events.some(e=>e.name==='write'&&e.input.path==='module.mjs'&&e.afterDispatch));
  assert.ok(events.some(e=>e.name==='write'&&e.input.path==='blocked.mjs'));
  assert.deepEqual(events.filter(e=>e.name==='bash').map(e=>e.input.command),[command]);
  assert.ok(childContexts.some(c=>c.messages.some(x=>x.role==='toolResult'&&x.isError)));
  await manage('send',{input:'FOLLOWUP change value',timeoutMs:10000});await manage('wait',{timeoutMs:10000});
  assert.equal(readFileSync(join(root,'module.mjs'),'utf8'),'export const value = 2;\n');
  const state=await manage('status');assert.equal(state.details.records[0].id,id);
  api.setActiveTools(api.getActiveTools().filter(n=>n!=='write'));
  const writesBeforeRevocation=events.filter(e=>e.name==='write').length;
  await manage('send',{input:'FOLLOWUP revoked write',timeoutMs:10000});
  await manage('wait',{timeoutMs:10000});
  assert.equal(events.filter(e=>e.name==='write').length,writesBeforeRevocation,'revoked child tool never reaches parent execution');
  assert.equal(readFileSync(join(root,'module.mjs'),'utf8'),'export const value = 2;\n');
  const revoked=await captured.executeTool('write',{path:'revoked.txt',content:'bad'});assert.equal(revoked.isError,true);assert.equal(existsSync(join(root,'revoked.txt')),false);
  await manage('close');const closed=await manage('status');assert.equal(closed.details.records[0].state,'closed');
  parent.dispose();parent=undefined;
  await assert.rejects(captured.executeTool('read',{path:'module.mjs'}),/inactive|disposed|active|stale after session replacement or reload/i);
 }finally{
  if(parent){try{if(captured)await captured.executeTool('manage_agent',{action:'close',batchId:'production'});}finally{await parent.abort();parent.dispose();}}
  for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  rmSync(root,{recursive:true,force:true});
 }
});
