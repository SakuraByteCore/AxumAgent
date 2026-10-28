import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,rmSync,symlinkSync,existsSync,readFileSync,writeFileSync,chmodSync,watch} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileExtensionPackage} from '../src/compile-bundled-extensions.js';
const modules=[process.env.AXUM_INTEGRATION_NODE_MODULES,resolve('../../refs/axum-validation/pi-cache/node_modules'),resolve('node_modules')].filter(Boolean).find(p=>existsSync(join(p,'@earendil-works/pi-coding-agent/package.json')));

test('default production dispatch: real OAR Codex transport, owned integration, independent tasks and fail closed', {skip:!modules,timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'axum-oar-default-'));
 const pkg=join(root,'plugin'),cwd=join(root,'project'),log=join(root,'wire.jsonl');
 const saved=Object.fromEntries(['PI_CODING_AGENT_DIR','PI_OFFLINE','AXUM_DESKTOP_PET'].map(k=>[k,process.env[k]]));
 let parent,captured;const commands=new Map(),records=[];
 try{
  mkdirSync(cwd);mkdirSync(join(root,'node_modules'));
  Object.assign(process.env,{PI_CODING_AGENT_DIR:join(root,'agent'),PI_OFFLINE:'1',AXUM_DESKTOP_PET:'0'});
  for(const name of ['@earendil-works','typebox','@mariozechner'])if(existsSync(join(modules,name)))symlinkSync(join(modules,name),join(root,'node_modules',name),'dir');
  for(const name of ['which','cross-spawn']){const p=join(modules,'@earendil-works/pi-coding-agent/node_modules',name);symlinkSync(existsSync(p)?p:join(modules,name),join(root,'node_modules',name),'dir');}
  cpSync(resolve('plugin/pi-agent'),pkg,{recursive:true});compileExtensionPackage({packageRoot:pkg});
  // ONLY the compiled deployment launcher export is replaced. Real production
  // index/dispatch/runner, OAR kernel/projection/turn selection/stdio are intact.
  cpSync(join(pkg,'oar-codex.js'),join(pkg,'oar-codex-real.js'));
  const executable=join(root,'codex');cpSync(resolve('test/fixtures/oar-default-codex.cjs'),executable);chmodSync(executable,0o700);
  writeFileSync(join(pkg,'oar-codex.js'),
   'import {createCodingTransport,loadOarCodingRuntime as production} from "./oar-codex-real.js";\n'+
   'export async function loadOarCodingRuntime(o){if(globalThis.__oarDefaultMissing)return production({...o,deployment:{image:"",apiKey:"",baseUrl:"",model:""}});if(globalThis.__oarDefaultStartup)await globalThis.__oarDefaultStartup;return createCodingTransport({kind:"available",via:"executable",command:'+JSON.stringify(executable)+'},o.writable,{OAR_DEFAULT_LOG:'+JSON.stringify(log)+',HOME:'+JSON.stringify(root)+',CODEX_HOME:'+JSON.stringify(root)+'});}');
  const sdk=await import(pathToFileURL(join(modules,'@earendil-works/pi-coding-agent/dist/index.js')).href);
  const ai=await import(pathToFileURL(join(modules,'@earendil-works/pi-ai/dist/index.js')).href);
  const plugin=(await import(pathToFileURL(join(pkg,'index.js')).href)).default;
  const runtime=await sdk.ModelRuntime.create({modelsPath:null,authPath:join(root,'agent/auth.json'),refreshOnCreate:false});
  let providerCalls=0;
  runtime.registerProvider('default-fixture',{api:'openai-completions',apiKey:'offline',baseUrl:'http://invalid.local',models:[{id:'fixed',name:'fixed',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}],streamSimple:()=>{providerCalls++;throw Error('Pi fallback forbidden');}});
  const settings=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const loader=new sdk.DefaultResourceLoader({cwd,agentDir:join(root,'agent'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[pi=>{plugin({...pi,registerCommand:(name,definition)=>{commands.set(name,definition);pi.registerCommand(name,definition);}});pi.registerTool({name:'capture_context',label:'capture',description:'capture context',parameters:{type:'object',properties:{}},execute:async(_id,_args,_signal,_update,ctx)=>{captured=ctx;return {content:[{type:'text',text:'captured'}]};}});} ]});await loader.reload();
  ({session:parent}=await sdk.createAgentSession({cwd,agentDir:join(root,'agent'),modelRuntime:runtime,model:runtime.getModel('default-fixture','fixed'),settingsManager:settings,sessionManager:sdk.SessionManager.inMemory(cwd),resourceLoader:loader,tools:['read','write','dispatch_agent','manage_agent','capture_context']}));
  await parent.bindExtensions({mode:'print'});
  let turn=0;
  parent.agent.streamFunction=async m=>{
   const message={role:'assistant',content:turn++===0?[{type:'toolCall',name:'capture_context',id:'capture',arguments:{}}]:[{type:'text',text:'ready'}],api:m.api,provider:m.provider,model:m.id,stopReason:turn===1?'toolUse':'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
   const stream=new ai.AssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason,message});stream.end(message);return stream;
  };
  await parent.prompt('Capture production context only');assert.ok(captured);
  const tool=async(name,args)=>{const out=await captured.executeTool(name,args);return out.result;};
  const dispatch=(spec,extra={})=>tool('dispatch_agent',{task:JSON.stringify(spec),squash:false,batchId:'default',...extra});
  const wait=async id=>{const out=await tool('manage_agent',{action:'wait',agentId:id,timeoutMs:10000});assert.equal(out.details.timedOut,false,JSON.stringify(out));const record=out.details.records.find(r=>r.id===id);records.push(record);return record;};
  const a=await dispatch({files:{'a.mjs':'export const a=1;\n'},check:'a.mjs',delay:400},{writeScope:['a.mjs']});
  const b=await dispatch({files:{'b.mjs':'export const b=2;\n'},check:'b.mjs',delay:400},{writeScope:['b.mjs']});
  assert.ok(a.details.agentId,JSON.stringify(a));assert.ok(b.details.agentId,JSON.stringify(b));
  const short=await tool('manage_agent',{action:'wait',agentId:a.details.agentId,timeoutMs:1});assert.equal(short.details.timedOut,true);
  const [ar,br]=await Promise.all([wait(a.details.agentId),wait(b.details.agentId)]);
  for(const record of [ar,br]){assert.equal(record.backend,'oar-codex');assert.equal(record.state,'completed',JSON.stringify(record));assert.match(record.response,/native test evidence/);}
  assert.equal(readFileSync(join(cwd,'a.mjs'),'utf8'),'export const a=1;\n');assert.ok(existsSync(join(cwd,'b.mjs')));
  const integrated=await captured.executeTool('write',{path:'index.mjs',content:"export {a} from './a.mjs'; export {b} from './b.mjs';\n"});assert.equal(integrated.isError,false);
  assert.match(readFileSync(join(cwd,'index.mjs'),'utf8'),/export/);
  const outside=await dispatch({files:{'owned.txt':'owned','outside.txt':'bad'}},{writeScope:['owned.txt']});
  assert.match(JSON.stringify(await wait(outside.details.agentId)),/Outside writeScope/);assert.equal(existsSync(join(cwd,'owned.txt')),false);assert.equal(existsSync(join(cwd,'outside.txt')),false);
  const readonly=await dispatch({files:{'read-only.txt':'bad'}});assert.match(JSON.stringify(await wait(readonly.details.agentId)),/Outside writeScope/);assert.equal(existsSync(join(cwd,'read-only.txt')),false);
  const tests=await dispatch({}, {writeScope:['a.mjs'],testCommands:['node --check a.mjs']});assert.match(tests.details.error,/cannot enforce exact testCommands/);
  const conflict=await dispatch({files:{'a.mjs':'child'},delay:400},{writeScope:['a.mjs']});
  // Observe the app-server's actual partial frame, not a guessed startup sleep.
  await new Promise((resolve,reject)=>{
   const ready=()=>readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.partial).length===5;
   const watcher=watch(log,()=>{if(ready()){clearTimeout(timer);watcher.close();resolve();}});
   const timer=setTimeout(()=>{watcher.close();reject(Error('fixture startup missing'));},5000);
   if(ready()){clearTimeout(timer);watcher.close();resolve();}
  });
  writeFileSync(join(cwd,'a.mjs'),'parent');assert.match(JSON.stringify(await wait(conflict.details.agentId)),/Parent conflict/);assert.equal(readFileSync(join(cwd,'a.mjs'),'utf8'),'parent');
  const slow=await dispatch({hold:true});
  await new Promise((resolve,reject)=>{
   const ready=()=>readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.partial).length===6;
   const watcher=watch(log,()=>{if(ready()){clearTimeout(timer);watcher.close();resolve();}});
   const timer=setTimeout(()=>{watcher.close();reject(Error('partial native turn missing'));},5000);
   if(ready()){clearTimeout(timer);watcher.close();resolve();}
  });
  // Let the transport consume the already-written pipe frame before interrupt.
  await new Promise(r=>setTimeout(r,30));
  const observed=await tool('manage_agent',{action:'wait',agentId:slow.details.agentId,timeoutMs:1});assert.equal(observed.details.timedOut,true);
  await tool('manage_agent',{action:'interrupt',agentId:slow.details.agentId});
  const cancelled=await wait(slow.details.agentId);assert.equal(cancelled.state,'cancelled');assert.match(cancelled.response,/native test evidence/);assert.equal(cancelled.runtimeResult.partial,true);assert.equal(cancelled.runtimeResult.cleanupFailure,undefined);
  let release;globalThis.__oarDefaultStartup=new Promise(r=>{release=r;});
  const starting=await dispatch({files:{'startup.txt':'bad'}},{writeScope:['startup.txt']});
  const interrupt=tool('manage_agent',{action:'interrupt',agentId:starting.details.agentId});release();await interrupt;delete globalThis.__oarDefaultStartup;
  assert.equal((await wait(starting.details.agentId)).state,'cancelled');assert.equal(existsSync(join(cwd,'startup.txt')),false);
  const beforeSlash=await tool('manage_agent',{action:'status'});
  const known=new Set(beforeSlash.details.records.map(r=>r.id));
  await commands.get('agent').handler(JSON.stringify({files:{'slash.txt':'bad'}}),{...captured,executeTool:undefined});
  const afterSlash=await tool('manage_agent',{action:'status'});
  const slash=afterSlash.details.records.find(r=>!known.has(r.id));assert.ok(slash,JSON.stringify(afterSlash));
  const slashResult=await wait(slash.id);assert.equal(slashResult.backend,'oar-codex');assert.match(JSON.stringify(slashResult),/Outside writeScope/);assert.equal(existsSync(join(cwd,'slash.txt')),false);
  globalThis.__oarDefaultMissing=true;
  const missing=await dispatch({});const mr=await wait(missing.details.agentId);assert.notEqual(mr.state,'completed');assert.match(JSON.stringify(mr),/digest-pinned|provider|Docker|ENOENT/i);delete globalThis.__oarDefaultMissing;
  const frames=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(frames.filter(x=>x.method==='turn/start').length,7,'no startup-interrupted task, fallback, duplicate dispatch or retry');
  assert.equal(frames.filter(x=>x.check&&x.status===0).length,2,'real offline node --check evidence');
  assert.equal(frames.slice(0,frames.findIndex(x=>x.completed)).filter(x=>x.partial).length,2,'both disjoint workers run before either completes');
  for(const frame of frames.filter(x=>x.partial)){
   const retained=records.some(r=>JSON.stringify(r).includes('Snapshot retained at '+frame.cwd));
   assert.equal(existsSync(frame.cwd),retained,'snapshot cleaned unless failure explicitly preserves evidence '+JSON.stringify(frame));
  }
  assert.equal(providerCalls,0,'native default never calls a Pi child model');
 }finally{
  delete globalThis.__oarDefaultMissing;delete globalThis.__oarDefaultStartup;
  if(parent){try{if(captured)await captured.executeTool('manage_agent',{action:'close',batchId:'default'});}finally{await parent.abort();parent.dispose();}}
  for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  // Failure snapshots intentionally retained by production remain test-owned.
  if(existsSync(log))for(const frame of readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)){
   if(frame.partial&&frame.cwd.startsWith(join(tmpdir(),'axum-oar-workspace-')))rmSync(frame.cwd,{recursive:true,force:true});
  }
  rmSync(root,{recursive:true,force:true});
 }
});
