import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileExtensionPackage} from '../src/compile-bundled-extensions.js';

test('compiled runner preserves original task and partial metadata when clock beats timer during startup',async()=>{
 const root=mkdtempSync(join(process.cwd(),'test/e2e-runner-'));
 try{
  cpSync('plugin/pi-agent',join(root,'pi-agent'),{recursive:true});compileExtensionPackage({packageRoot:join(root,'pi-agent')});
  const {runChildTurns}=await import(pathToFileURL(join(root,'pi-agent/runner.js')).href);
  const {formatResultMessage,formatErrorMessage}=await import(pathToFileURL(join(root,'pi-agent/transcript.js')).href);
  const {PLAN_RESULT_DIRECTIVE}=await import(pathToFileURL(join(root,'pi-agent/result-message.js')).href);
  const {mainContextLabel}=await import(pathToFileURL(join(root,'pi-agent/shared.js')).href);
  assert.deepEqual(['will-squash','squashed','separate'].map(mainContextLabel),['等待回传主线程','已回传主线程，待汇总',undefined]);
  for(const oneShot of [true,false]){
   const task={oneShot,id:'a',backend:'controlled-pi',model:'fixture',invocation:'/agent compare projects',task:'compare projects',responseText:'missing upstream evidence',planMode:true,conversationMessages:[{role:'user',content:'compare projects'},{role:'assistant',content:'missing upstream evidence'}]};
   const success=formatResultMessage(task),failure=formatErrorMessage(task,'network failed');
   for(const text of [success,failure]){assert.match(text,/Address this task explicitly in your next user-visible response/);assert.match(text,/essential evidence is missing/);}
   assert.ok(success.includes(PLAN_RESULT_DIRECTIVE));assert.ok(!failure.includes(PLAN_RESULT_DIRECTIVE));
   assert.match(success,/missing upstream evidence/);assert.match(failure,/Report failure or partial completion explicitly/);
  }
  const messages=[],posts=[],prompts=[];
  const session={agent:{state:{messages}},prompt:async text=>{prompts.push(text);messages.push({role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop'});},waitForIdle:async()=>{}};
  const a={id:'a',sessionId:'s',command:'agent',task:'original requirement',model:'m',modelLabel:'m',notifyMainAgent:true,status:'running',deadlineAt:Date.now()-1,executionTimeoutMs:123,responseText:'',toolUses:0,turnCount:0,turnStartedAt:Date.now(),startedAt:Date.now(),activeTools:new Map(),conversationMessages:[],finished:new Promise(()=>{})};
  const running=runChildTurns({sendMessage:m=>posts.push(m)},()=>false,'original requirement',session,a,{update(){},addCompleted(){}});
  await Promise.resolve();assert.equal(prompts.length,0);assert.equal(a.status,'idle');assert.equal(a.timeoutMs,123);assert.equal(posts[0].details.partial,true);assert.match(a.error,/123ms/);
  a.resume('continue');for(let i=0;i<8;i++)await Promise.resolve();
  assert.match(prompts[0],/original requirement/);assert.match(prompts[0],/continue/);assert.equal(a.status,'idle');a.retire();await running;
 }finally{rmSync(root,{recursive:true,force:true});}
});
