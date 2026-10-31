import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildSettings, childRecoveryExtensions, promptChildUntilSettled } from '../plugin/pi-agent/child-recovery.ts';

test('children load the main companion guard exactly once and honor -ne', () => {
 const [guard] = childRecoveryExtensions({});
 assert.ok(existsSync(guard));
 assert.deepEqual(childRecoveryExtensions({extensions:[guard]}),[guard]);
 assert.deepEqual(childRecoveryExtensions({extensions:[dirname(guard)]}),[dirname(guard)]);
 assert.deepEqual(childRecoveryExtensions({noExtensions:true}),[]);
 assert.deepEqual(childRecoveryExtensions({noExtensions:true,extensions:['custom']}),['custom']);
});

test('child recovery uses the main configured error policy and respects abort and retry limit', async () => {
 const dir=mkdtempSync(join(tmpdir(),'axum-child-retry-'));
 writeFileSync(join(dir,'.pi-response-guard.json'),JSON.stringify({maxConsecutiveAutoRetries:1,retryMessage:'resume work',errorPatterns:['fetch failed']}));
 const handlers=new Map(),sent=[];
 const pi={on:(key,fn)=>{const list=handlers.get(key)||[];list.push(fn);handlers.set(key,list);},events:{on:()=>{},emit:()=>{}},registerCommand:()=>{},registerProvider:()=>{},sendUserMessage:async(text)=>{sent.push(text);}};
 const ctx={cwd:dir,hasUI:false,isIdle:()=>true,hasPendingMessages:()=>false,getContextUsage:()=>({tokens:0,contextWindow:100})};
 const emit=async(name,event)=>{for(const handler of handlers.get(name)||[]) await handler(event,ctx);};
 try {
  const {default:guard}=await import(pathToFileURL(childRecoveryExtensions({})[0]).href);guard(pi);
  for(const [stopReason,errorMessage] of [['aborted','fetch failed'],['error','401 Unauthorized'],['error','fetch failed'],['error','fetch failed']]) {
   await emit('agent_end',{messages:[{role:'assistant',stopReason,errorMessage,content:[]}],willRetry:false});
   await emit('agent_settled',{});
  }
  assert.deepEqual(sent,['resume work']);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('child delivery awaits queued recovery and never retries a rejected prompt itself', async () => {
 let settle, finished=false;
 const session={prompt:async()=>{},waitForIdle:()=>new Promise(resolve=>{settle=resolve;})};
 const result=promptChildUntilSettled(session,'task').then(()=>{finished=true;});
 await Promise.resolve();assert.equal(finished,false);settle();await result;assert.equal(finished,true);
 let attempts=0;
 await assert.rejects(promptChildUntilSettled({prompt:async()=>{attempts++;throw new Error('auth failed');},waitForIdle:()=>assert.fail('not reached')},'task'),/auth failed/);
 assert.equal(attempts,1);
});

test('child settings inherit retry policy and honor explicit project disable',()=>{
 const global={retry:{enabled:true,maxRetries:4,baseDelayMs:1000}};
 assert.deepEqual(buildChildSettings(global,{}).retry,global.retry);
 assert.deepEqual(buildChildSettings(global,{retry:{enabled:false}}).retry,{...global.retry,enabled:false});
 assert.equal(global.retry.enabled,true);
});
