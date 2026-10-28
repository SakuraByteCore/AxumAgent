import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=stripTypeScriptTypes(readFileSync(new URL('../plugin/pi-agent/controlled-runtime.ts',import.meta.url),'utf8'),{mode:'transform'});
const {createControlledRuntime}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
test('controlled handle wait does not cancel; startup cancel preserves evidence and awaits cleanup exactly once',async()=>{
 const started=deferred(),finished=deferred(),cleaned=deferred();let executions=0,aborts=0,disposals=0;
 const runtime=createControlledRuntime({execute:async task=>{executions++;started.resolve();await finished.promise;return task;},partial:()=> 'already written file',abort:async()=>{aborts++;finished.resolve();},dispose:async()=>{disposals++;await cleaned.promise;}});
 const h=runtime.start({task:'one task',cwd:process.cwd(),signal:new AbortController().signal});await started.promise;
 assert.equal(await h.wait(1),undefined);assert.equal(aborts,0);
 const cancel=h.cancel();let settled=false;h.result.then(()=>settled=true);await new Promise(r=>setTimeout(r,1));assert.equal(settled,false);
 cleaned.resolve();const [result]=await Promise.all([h.result,cancel,h.cancel(),h.dispose()]);
 assert.equal(result.stopReason,'aborted');assert.equal(result.partial,true);assert.equal(result.text,'already written file');assert.equal(executions,1);assert.equal(aborts,1);assert.equal(disposals,1);
});
test('controlled explicit timeout differs from wait; failed cleanup stays visible and execution is never retried',async()=>{
 const finished=deferred();let calls=0;
 const h=createControlledRuntime({execute:async()=>{calls++;await finished.promise;throw new Error('provider secret');},partial:()=> 'partial',abort:async()=>finished.resolve(),dispose:async()=>{throw new Error('cleanup secret');}}).start({task:'one',cwd:process.cwd(),signal:new AbortController().signal,timeoutMs:1});
 const result=await h.result;assert.equal(result.stopReason,'timeout');assert.equal(result.partial,true);assert.equal(result.cleanupFailure.stage,'dispose');assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(result),/secret/);await h.dispose();
});
test('controlled cancelled-before-start request never executes or installs a default deadline',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 const runtime=createControlledRuntime({execute:async()=>{calls++;return 'bad';},partial:()=>'',abort:async()=>{},dispose:async()=>{}});
 const result=await runtime.start({task:'one',cwd:process.cwd(),signal:controller.signal}).result;assert.equal(calls,0);assert.equal(result.stopReason,'aborted');
 assert.throws(()=>runtime.start({task:'one',cwd:process.cwd(),signal:controller.signal,timeoutMs:0}),/timeout/);
});
