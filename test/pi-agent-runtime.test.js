// Scripted operations verify lifecycle, not model intelligence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=stripTypeScriptTypes(readFileSync(new URL('../plugin/pi-agent/controlled-runtime.ts',import.meta.url),'utf8'),{mode:'transform'});
const {createControlledRuntime}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(overrides={}){
 const calls={execute:0,abort:0,dispose:0};
 const runtime=createControlledRuntime({execute:async task=>{calls.execute++;return task;},partial:()=>'',abort:async()=>{calls.abort++;},dispose:async()=>{calls.dispose++;},...overrides});
 return {calls,start:(extra={})=>runtime.start({task:'one instruction',cwd:process.cwd(),signal:new AbortController().signal,...extra})};
}
test('completed result remains stable through repeated wait, cancel and disposal',async()=>{
 const f=fixture(),h=f.start(),r=await h.result;
 assert.deepEqual(r,{text:'one instruction',stopReason:'completed',partial:false,diagnostics:[]});
 assert.equal(await h.wait(),r);assert.equal(await h.wait(1),r);
 await Promise.all([h.cancel(),h.dispose(),h.dispose()]);assert.deepEqual(f.calls,{execute:1,abort:0,dispose:1});
});
test('failed execution preserves partial evidence without retry or leaking provider error',async()=>{
 const f=fixture({execute:async()=>{f.calls.execute++;throw Error('PRIVATE_PROVIDER_KEY');},partial:()=> 'file already written'});
 const h=f.start(),r=await h.result;
 assert.equal(r.stopReason,'error');assert.equal(r.text,'file already written');assert.equal(r.partial,true);
 assert.deepEqual(r.diagnostics,[{stage:'turn',message:'Controlled SDK task failed'}]);assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
 await h.dispose();assert.equal(f.calls.execute,1);assert.equal(f.calls.dispose,1);
});
test('abort failure remains diagnostic and does not skip disposal or lose partial',async()=>{
 const done=deferred();const f=fixture({execute:()=>done.promise,partial:()=> 'partial',abort:async()=>{f.calls.abort++;done.reject(Error('late provider secret'));throw Error('abort secret');}});
 const h=f.start();await h.cancel();const r=await h.result;
 assert.equal(r.stopReason,'aborted');assert.equal(r.text,'partial');assert.equal(r.partial,true);
 assert.ok(r.diagnostics.some(d=>d.stage==='abort'));assert.doesNotMatch(JSON.stringify(r),/secret/);assert.equal(f.calls.dispose,1);
});
test('terminal completion survives cancel during cleanup and removes signal subscription',async()=>{
 const cleanup=deferred(),controller=new AbortController();let adds=0,removes=0;
 const signal={get aborted(){return controller.signal.aborted;},addEventListener(...args){adds++;controller.signal.addEventListener(...args);},removeEventListener(...args){removes++;controller.signal.removeEventListener(...args);}};
 const f=fixture({dispose:async()=>{f.calls.dispose++;await cleanup.promise;}}),h=f.start({signal});
 await new Promise(r=>setImmediate(r));controller.abort();const cancel=h.cancel();cleanup.resolve();await cancel;
 assert.equal((await h.result).stopReason,'completed');assert.equal(f.calls.abort,0);assert.equal(f.calls.dispose,1);assert.equal(adds,1);assert.equal(removes,1);
});
test('invalid launch cannot execute or acquire resources',()=>{
 const f=fixture();
 for(const extra of [{task:' '},{cwd:' '}])assert.throws(()=>f.start(extra),/required/);
 assert.deepEqual(f.calls,{execute:0,abort:0,dispose:0});
});
