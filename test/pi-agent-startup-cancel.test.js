import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileExtensionPackage} from '../src/compile-bundled-extensions.js';
// Real runner/widget startup path; only loader delay is injected. Not a native provider test.
test('UI interrupt before OAR loader resolves starts no native session/prompt and records aborted, not empty success',async()=>{
 const root=mkdtempSync(join(tmpdir(),'axum-oar-startup-'));const posts=[];let release,starts=0;
 globalThis.__axumOarDelayed=new Promise(r=>release=r);globalThis.__axumOarStart=()=>{starts++;throw new Error('cancelled task must not start');};
 try{
  symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');cpSync('plugin/pi-agent',join(root,'plugin'),{recursive:true});compileExtensionPackage({packageRoot:join(root,'plugin')});
  writeFileSync(join(root,'plugin/oar.js'),'export function assertOarRequest(){}; export async function loadOarTextRuntime(){await globalThis.__axumOarDelayed;return {start:globalThis.__axumOarStart};}');
  const {startUserAgent,registryFor}=await import(pathToFileURL(join(root,'plugin/runner.js')).href);
  const {UserAgentWidget}=await import(pathToFileURL(join(root,'plugin/widget.js')).href);
  const agents=new Set();const widget={update(){},addCompleted(a,m){posts.push(m);}};
  const pi={sendMessage(m){posts.push(m);},appendEntry(){}};
  const agent=await startUserAgent(pi,agents,widget,new Set(),()=>false,()=>1,'agent','-i -s complete goal','dispatch_agent: complete goal',{cwd:root,hasUI:false},undefined,undefined,{backend:'oar-claude-text'});
  assert.equal(agent.runHandle,undefined);assert.equal(agent.status,'running');
  UserAgentWidget.prototype.interruptRunning.call({update(){}},agent);assert.equal(agent.aborted,true);
  release();await agent.finished;
  assert.equal(starts,0);assert.equal(agent.runtimeResult.stopReason,'aborted');assert.equal(registryFor(agents).snapshot()[0].state,'cancelled');
  assert.match(agent.error,/aborted during initialization/);assert.equal(posts.filter(p=>p.details?.ok===true).length,0);assert.equal(agents.size,0);
 }finally{release?.();delete globalThis.__axumOarDelayed;delete globalThis.__axumOarStart;rmSync(root,{recursive:true,force:true});}
});
