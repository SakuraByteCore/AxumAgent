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
  const messages=[],posts=[],prompts=[];
  const session={agent:{state:{messages}},prompt:async text=>{prompts.push(text);messages.push({role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop'});},waitForIdle:async()=>{}};
  const a={id:'a',sessionId:'s',command:'agent',task:'original requirement',model:'m',modelLabel:'m',notifyMainAgent:true,status:'running',deadlineAt:Date.now()-1,executionTimeoutMs:123,responseText:'',toolUses:0,turnCount:0,turnStartedAt:Date.now(),startedAt:Date.now(),activeTools:new Map(),conversationMessages:[],finished:new Promise(()=>{})};
  const running=runChildTurns({sendMessage:m=>posts.push(m)},()=>false,'original requirement',session,a,{update(){},addCompleted(){}});
  await Promise.resolve();assert.equal(prompts.length,0);assert.equal(a.status,'idle');assert.equal(a.timeoutMs,123);assert.equal(posts[0].details.partial,true);assert.match(a.error,/123ms/);
  a.resume('continue');for(let i=0;i<8;i++)await Promise.resolve();
  assert.match(prompts[0],/original requirement/);assert.match(prompts[0],/continue/);assert.equal(a.status,'idle');a.retire();await running;
 }finally{rmSync(root,{recursive:true,force:true});}
});
