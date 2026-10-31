import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,cpSync,rmSync,symlinkSync,existsSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileExtensionPackage} from '../src/compile-bundled-extensions.js';

const modules=process.env.AXUM_INTEGRATION_NODE_MODULES || resolve('../../refs/axum-validation/pi-cache/node_modules');
const available=existsSync(join(modules,'@earendil-works/pi-coding-agent/package.json'));
// Scripted offline model decisions, not evidence of real model intelligence.
// The SDK, production index extension, runner and tools are real; no backend override, CLI or network key.
test('production index dispatch: SDK child, scoped tools, live bridge, independent tasks and cleanup', {skip:!available,timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'axum-production-sdk-'));
 const saved=Object.fromEntries(['PI_CODING_AGENT_DIR','PI_OFFLINE','AXUM_DESKTOP_PET'].map(k=>[k,process.env[k]]));
 Object.assign(process.env,{PI_CODING_AGENT_DIR:join(root,'agent'),PI_OFFLINE:'1',AXUM_DESKTOP_PET:'0'});
 let parent,api,captured;
 try{
  symlinkSync(modules,join(root,'node_modules'),'junction');
  cpSync(resolve('plugin/pi-agent'),join(root,'plugin'),{recursive:true,filter:source=>!source.split(/[\\/]/).some(part=>['node_modules','assets','desktop-pet-cubism-source','desktop-pet-love','__pycache__','dist','build'].includes(part))&&(statSync(source).isDirectory() || /\.(ts|js|json)$/.test(source))});
  symlinkSync(resolve('plugin/pi-agent/node_modules'),join(root,'plugin/node_modules'),'junction');
  compileExtensionPackage({packageRoot:join(root,'plugin')});
  const sdk=await import(pathToFileURL(join(modules,'@earendil-works/pi-coding-agent/dist/index.js')).href);
  const ai=await import(pathToFileURL(join(modules,'@earendil-works/pi-ai/dist/index.js')).href);
  const plugin=(await import(pathToFileURL(join(root,'plugin/index.js')).href)).default;
  const runtime=await sdk.ModelRuntime.create({modelsPath:null,authPath:join(root,'agent/auth.json'),refreshOnCreate:false});
  const events=[],childContexts=[],childModels=[];
  const command='node --check module.mjs';
  let dispatchReturned=false,releaseChild,interrupted=false;
  const barrier=new Promise(r=>{releaseChild=r;});
  const call=(name,args,id=name)=>({type:'toolCall',name,id,arguments:args});
  function response(m,content){
   const message={role:'assistant',content:content.length?content:[{type:'text',text:'verified'}],api:m.api,provider:m.provider,model:m.id,stopReason:content.some(x=>x.type==='toolCall')?'toolUse':'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
   const s=new ai.AssistantMessageEventStream();s.push({type:'done',reason:message.stopReason,message});s.end(message);return s;
  }
  runtime.registerProvider('production-fixture',{api:'openai-completions',apiKey:'fixture-only',baseUrl:'http://invalid.local',models:[{id:'fixed',name:'fixed',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}],streamSimple:(m,c)=>{
   const s=new ai.AssistantMessageEventStream();
   void (async()=>{
    await barrier;childContexts.push(c);childModels.push([m.provider,m.id]);
    const lastUser=c.messages.findLastIndex(x=>x.role==='user');
    const followup=JSON.stringify(c.messages[lastUser]).includes('FOLLOWUP');
    const already=c.messages.slice(lastUser+1).some(x=>x.role==='assistant');
    const second=JSON.stringify(c.messages[lastUser]).includes('Implement second');
    const readOnly=JSON.stringify(c.messages[lastUser]).includes('READONLY');
    const full=JSON.stringify(c.messages[lastUser]).includes('FULLTOOLS');
    if(full){
     const invalid=JSON.stringify(c.messages[lastUser]).includes('INVALIDRESULT');
     const content=already?[{type:'text',text:JSON.stringify({conclusion:invalid?123:'checked',evidence:['custom tool and bash'],unresolved:[]})}]:[
      call('fixture_lookup',{query:'evidence'}),call('bash',{command:'node --version'}),
      call('write',{path:'full.mjs',content:'export const full = true;\n'}),call('write',{path:'blocked.mjs',content:'blocked'})];
     const result=await response(m,content).result();s.push({type:'done',reason:result.stopReason,message:result});s.end(result);return;
    }
    if(readOnly&&already&&!interrupted){
     interrupted=true;const failure={...(await response(m,[]).result()),stopReason:'error',errorMessage:'terminated',content:[]};
     s.push({type:'error',reason:'error',error:failure});s.end(failure);return;
    }
    const content=already?[]:readOnly?[call('read',{path:'module.mjs'}),call('grep',{path:'module.mjs',pattern:'export'})]:second?[call('write',{path:'second.mjs',content:'export const second = 2;\n'})]:followup?[call('write',{path:'module.mjs',content:'export const value = 2;\n'},'followup-write')]:[
     call('write',{path:'module.mjs',content:'export const value = 1;\n'}),
     call('write',{path:'escape.txt',content:'bad'},'escape'),
     call('write',{path:'blocked.mjs',content:'bad'},'hook-denied'),
     call('bash',{command},'test'),
     call('bash',{command:'node --version'},'not-authorized')];
    const result=await response(m,content).result();s.push({type:'done',reason:result.stopReason,message:result});s.end(result);
   })().catch(e=>s.end({role:'assistant',content:[],stopReason:'error',errorMessage:String(e)}));return s;
  }});
  const model=runtime.getModel('production-fixture','fixed');assert.ok(model);
  mkdirSync(join(root,'agent'),{recursive:true});writeFileSync(join(root,'agent/settings.json'),JSON.stringify({retry:{enabled:true,maxRetries:1,baseDelayMs:1,fixedDelayMs:1}}));
  const settings=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const extension=pi=>{
   api=pi;plugin(pi);
   pi.registerTool({name:'fixture_lookup',label:'lookup',description:'Custom external-tool fixture',parameters:{type:'object',properties:{query:{type:'string'}}},execute:async()=>({content:[{type:'text',text:'independent evidence'}]})});
   pi.on('tool_call',e=>{events.push({name:e.toolName,input:e.input,afterDispatch:dispatchReturned});if(e.toolName==='write'&&(e.input.path==='blocked.mjs'||e.input.content?.includes('blockedRename')))return {block:true,reason:'production parent hook denied'};});
   pi.registerTool({name:'capture_context',label:'capture',description:'Capture real durable tool context',parameters:{type:'object',properties:{}},execute:async(_id,_args,_signal,_update,ctx)=>{captured=ctx;return {content:[{type:'text',text:'captured'}]};}});
  };
  const loader=new sdk.DefaultResourceLoader({cwd:root,agentDir:join(root,'agent'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,additionalExtensionPaths:[join(modules,'pi-hashline-edit-pro/index.js')],extensionFactories:[extension]});await loader.reload();
  ({session:parent}=await sdk.createAgentSession({cwd:root,agentDir:join(root,'agent'),modelRuntime:runtime,model,settingsManager:settings,sessionManager:sdk.SessionManager.inMemory(root),resourceLoader:loader}));
  await parent.bindExtensions({mode:'print'});
  let turn=0;
  parent.agent.streamFunction=async(m)=>response(m,turn++===0?[call('capture_context',{}),call('dispatch_agent',{batchId:'production',tasks:[{task:'Implement module',role:'fixer',writeScope:['module.mjs','blocked.mjs']},{task:'Implement second independent module',role:'fixer',writeScope:['second.mjs'],squash:false}]})]:[]);
  // An ordinary request enters the real parent loop; scripted tool calls are the model contract.
  await parent.prompt('Add two independent modules and integrate their exports, then verify the result.');dispatchReturned=true;
  const dispatch=parent.agent.state.messages.find(x=>x.role==='toolResult'&&x.toolName==='dispatch_agent');
  assert.ok(dispatch&&!dispatch.isError,JSON.stringify(parent.agent.state.messages));
  assert.equal(dispatch.details.records.length,2);
  const id=dispatch.details.records[0].agentId;assert.ok(id,JSON.stringify({dispatch,tools:api.getAllTools().filter(t=>['write','read','bash'].includes(t.name)).map(t=>({name:t.name,sourceInfo:t.sourceInfo}))}));assert.ok(captured);
  async function manage(action,extra={}){const out=await captured.executeTool('manage_agent',{action,agentId:id,...extra});assert.equal(out.isError,false,JSON.stringify(out));return out.result;}
  const before=await manage('wait',{timeoutMs:5});assert.equal(before.details.timedOut,true);
  const locked=await captured.executeTool('dispatch_agent',{task:'Too early exact tests',writeScope:['.'],testCommands:[command],squash:false});assert.match(locked.result.details.error,/conflict/i);
  releaseChild();
  const waited=await manage('wait',{timeoutMs:10000});assert.equal(waited.details.timedOut,false,JSON.stringify(waited));
  const all=await captured.executeTool('manage_agent',{action:'wait',batchId:'production',timeoutMs:10000});assert.equal(all.result.details.timedOut,false);
  assert.equal(readFileSync(join(root,'second.mjs'),'utf8'),'export const second = 2;\n');
  assert.ok(childContexts.some(c=>JSON.stringify(c.messages).includes('[Role: fixer]')));
  assert.ok(childModels.length>=2);assert.ok(childModels.every(([provider,id])=>provider==='production-fixture'&&id==='fixed'),'children use only the configured parent provider/model');
  assert.equal(childContexts.some(c=>JSON.stringify(c).includes('Add two independent modules and integrate their exports, then verify the result.')),false,'no inherited parent transcript');
  const integrated=await captured.executeTool('write',{path:'index.mjs',content:'export { value } from \'./module.mjs\'; export { second } from \'./second.mjs\';\n'});assert.equal(integrated.isError,false);
  assert.equal(readFileSync(join(root,'module.mjs'),'utf8'),'export const value = 1;\n');
  assert.ok(parent.agent.state.messages.some(m=>m.role==='custom' && JSON.stringify(m).includes('user-1')),'default squash automatically returns child result into parent conversation');
  assert.ok(parent.agent.state.messages.some(m=>m.role==='custom'&&typeof m.content==='string'&&m.content.includes('Address this task explicitly in your next user-visible response')),'actual parent context receives the handoff directive');
  assert.equal(existsSync(join(root,'escape.txt')),false);assert.equal(existsSync(join(root,'blocked.mjs')),false);
  assert.ok(events.some(e=>e.name==='write'&&e.input.path==='module.mjs'&&e.afterDispatch));
  assert.ok(events.some(e=>e.name==='write'&&e.input.path==='blocked.mjs'));
  assert.deepEqual(events.filter(e=>e.name==='bash'),[]);
  assert.ok(childContexts.some(c=>c.messages.some(x=>x.role==='toolResult'&&x.isError)));
  for(const action of ['send','resume','rebase']){
   const rejected=await captured.executeTool('manage_agent',{action,agentId:id,input:'FOLLOWUP'});assert.equal(rejected.isError,true,JSON.stringify(rejected));
  }
  const state=await manage('status');assert.equal(state.details.records[0].id,id);assert.equal(state.details.records[0].capabilities.oneShot,true);
  const checked=await captured.executeTool('dispatch_agent',{task:'Run exact checks',writeScope:['.'],testCommands:[command],squash:false,batchId:'production'});
  assert.equal(checked.isError,false);assert.ok(checked.result.details.agentId,JSON.stringify(checked));
  await captured.executeTool('manage_agent',{action:'wait',agentId:checked.result.details.agentId,timeoutMs:10000});
  assert.deepEqual(events.filter(e=>e.name==='bash').map(e=>e.input.command),[command]);
  // Fresh default installation includes hashline overrides, not only native SDK tools.
  const reader=await captured.executeTool('dispatch_agent',{task:'READONLY inspect module.mjs',squash:false,batchId:'production'});
  assert.ok(reader.result.details.agentId,JSON.stringify(reader));
  const readResult=await captured.executeTool('manage_agent',{action:'wait',agentId:reader.result.details.agentId,timeoutMs:10000});
  assert.equal(readResult.result.details.timedOut,false);
  assert.ok(api.getAllTools().find(t=>t.name==='read').sourceInfo.path.includes('pi-hashline-edit-pro'));
  const readerContext=childContexts.findLast(c=>JSON.stringify(c.messages).includes('READONLY'));
  assert.match(JSON.stringify(readerContext.messages),/Available tools: (read, grep|grep, read)/);
  for(const name of ['read','grep'])assert.ok(readerContext.messages.some(m=>m.role==='toolResult'&&m.toolName===name&&!m.isError&&JSON.stringify(m.content).includes('export const value')));
  assert.match(JSON.stringify(readerContext.messages),/Shell is unavailable for this task/);
  assert.ok(events.some(e=>e.name==='read'&&e.input.path==='module.mjs'));
  assert.ok(events.some(e=>e.name==='grep'&&e.input.path==='module.mjs'));
  const recovered=await captured.executeTool('manage_agent',{action:'status',agentId:reader.result.details.agentId});
  assert.equal(recovered.result.details.records.find(r=>r.id===reader.result.details.agentId).state,'completed',JSON.stringify(recovered));assert.equal(interrupted,true);
  assert.equal(events.filter(e=>e.name==='read'&&e.input.path==='module.mjs').length,1);
  const parentTools=api.getActiveTools();api.setActiveTools(['dispatch_agent','manage_agent','capture_context']);
  const empty=await captured.executeTool('dispatch_agent',{task:'READONLY must not run without tools',squash:false});
  assert.match(empty.result.details.error,/No parent-authorized read\/search tools/);
  api.setActiveTools(parentTools);


  const outputSchema={type:'object',required:['conclusion','evidence','unresolved'],properties:{conclusion:{type:'string'},evidence:{type:'array',items:{type:'string'}},unresolved:{type:'array',items:{type:'string'}}}};
  for(const valid of [true,false]){
   const task='FULLTOOLS '+(valid?'VALIDRESULT':'INVALIDRESULT');
   const result=await captured.executeTool('dispatch_agent',{task,agentArgs:'-s '+task,fullTools:true,outputSchema});
   assert.ok(result.result.details.agentId,JSON.stringify(result));
   const wait=await captured.executeTool('manage_agent',{action:'wait',agentId:result.result.details.agentId,timeoutMs:10000});
   const record=wait.result.details.records[0];
   assert.equal(record.state,valid?'completed':'failed',JSON.stringify(record));
   assert.equal(record.structuredResult.valid,valid);
   const delivered=parent.agent.state.messages.find(m=>m.role==='custom'&&m.details?.agentId===record.id);
   assert.ok(delivered);assert.equal(delivered.details.structuredResult.valid,valid);assert.equal(delivered.details.ok,valid);
  }
  assert.equal(events.filter(e=>e.name==='fixture_lookup').length,2,'invalid output does not replay side effects');
  assert.ok(events.some(e=>e.name==='bash'&&e.input.command==='node --version'));
  assert.match(readFileSync(join(root,'full.mjs'),'utf8'),/full = true/);assert.equal(existsSync(join(root,'blocked.mjs')),false);
  const history=await captured.executeTool('manage_agent',{action:'history',limit:100});
  assert.equal(history.isError,false,JSON.stringify(history));assert.ok(history.result.details.records.some(r=>r.structuredResult?.valid===false));

  await parent.waitForIdle();
  parent.agent.streamFunction=async(m,c)=>{
   const last=c.messages.findLastIndex(x=>x.role==='user');
   const text=c.messages[last]?.content;const body=typeof text==='string'?text:text?.find(x=>x.type==='text')?.text;
   return response(m,body?.startsWith('[Agent command request]')&&!c.messages.slice(last+1).some(x=>x.role==='assistant')?[call('dispatch_agent',JSON.parse(body.split('\n').at(-1)))]:[]);
  };
  const commandDispatched=new Promise(resolve=>{
   const unsubscribe=parent.subscribe(event=>{if(event.type==='message_end'&&event.message.role==='toolResult'&&event.message.toolName==='dispatch_agent'){unsubscribe();resolve(event.message);}});
  });
  await parent.prompt('/agent -s FULLTOOLS VALIDRESULT');
  const commandDispatch=await commandDispatched;
  assert.ok(commandDispatch.details.agentId,JSON.stringify(commandDispatch));
  const commandWait=await captured.executeTool('manage_agent',{action:'wait',agentId:commandDispatch.details.agentId,timeoutMs:10000});
  assert.equal(commandWait.result.details.records[0].state,'completed');
  await parent.waitForIdle();
  const astPreview=await captured.executeTool('ast',{action:'preview',path:'full.mjs',selector:{kind:'Identifier',name:'full'},replacement:'renamed'});
  assert.equal(astPreview.isError,false,JSON.stringify(astPreview));
  const beforeAst=readFileSync(join(root,'full.mjs'),'utf8');
  const astDenied=await captured.executeTool('ast',{action:'apply',path:'full.mjs',selector:{kind:'Identifier',name:'full'},replacement:'blockedRename',expectedHash:astPreview.result.details.hash});
  assert.equal(astDenied.isError,true);assert.equal(readFileSync(join(root,'full.mjs'),'utf8'),beforeAst);
  const astApplied=await captured.executeTool('ast',{action:'apply',path:'full.mjs',selector:{kind:'Identifier',name:'full'},replacement:'renamed',expectedHash:astPreview.result.details.hash});
  assert.equal(astApplied.isError,false,JSON.stringify(astApplied));assert.match(readFileSync(join(root,'full.mjs'),'utf8'),/renamed = true/);
  writeFileSync(join(root,'debug.cjs'),'const value = 42;\nsetInterval(()=>{},1000);\n');
  const debug=await captured.executeTool('debugger',{action:'launch',path:'debug.cjs'});
  assert.equal(debug.isError,false,JSON.stringify(debug));
  const debugId=debug.result.details.sessionId;
  const evaluated=await captured.executeTool('debugger',{action:'evaluate',sessionId:debugId,expression:'6 * 7'});
  assert.equal(evaluated.isError,false,JSON.stringify(evaluated));assert.equal(evaluated.result.details.result.result.value,42);
  const stopped=await captured.executeTool('debugger',{action:'stop',sessionId:debugId});assert.equal(stopped.isError,false);
  // A simple request may be answered inline with no dispatch or new child.
  const childrenBefore=childContexts.length;
  const dispatchesBefore=parent.agent.state.messages.filter(x=>x.role==='toolResult'&&x.toolName==='dispatch_agent').length;
  parent.agent.streamFunction=async m=>response(m,[]);
  await parent.prompt('What is two plus two? Answer directly.');
  assert.equal(childContexts.length,childrenBefore);
  assert.equal(parent.agent.state.messages.filter(x=>x.role==='toolResult'&&x.toolName==='dispatch_agent').length,dispatchesBefore);
  api.setActiveTools(api.getActiveTools().filter(n=>n!=='write'));
  const revoked=await captured.executeTool('write',{path:'revoked.txt',content:'bad'});assert.equal(revoked.isError,true);assert.equal(existsSync(join(root,'revoked.txt')),false);
  await manage('close');const closed=await manage('status');assert.equal(closed.details.records[0].state,'completed');
  parent.dispose();parent=undefined;
  await assert.rejects(captured.executeTool('read',{path:'module.mjs'}),/inactive|disposed|active|stale after session replacement or reload/i);
 }finally{
  if(parent){try{if(captured)await captured.executeTool('manage_agent',{action:'close',batchId:'production'});}finally{await parent.abort();parent.dispose();}}
  for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  rmSync(root,{recursive:true,force:true});
 }
});
