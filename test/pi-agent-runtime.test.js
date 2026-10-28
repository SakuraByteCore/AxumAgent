// SPDX-License-Identifier: Apache-2.0
// Structural fake OAR only: these tests do NOT exercise a real provider/process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(readFileSync(new URL('../plugin/pi-agent/runtime.ts', import.meta.url), 'utf8'), {mode:'transform'});
const {createOarRuntime} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const tick = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
function fake(overrides={}) {
 const done=deferred(), calls={prompt:0,abort:0,dispose:0,unsubscribe:0,session:0,installation:0};
 let listener;
 const session={id:'root',events(fn,options){listener=fn;assert.deepEqual(options,{cursor:{sessionId:'root',afterSeq:-1}});return ()=>{calls.unsubscribe++;};},async prompt(text,options){calls.prompt++;calls.task=text;calls.inputId=options.inputId;return {kind:'accepted',seq:7};},async abort(){calls.abort++;},async dispose(){calls.dispose++;},...overrides};
 const native={async installation(){calls.installation++;return {kind:'available'};},async session(i,o){calls.session++;calls.options=o;return session;}};
 const observe=async(s,seq,id)=>{assert.equal(s,session);assert.equal(seq,7);assert.equal(id,calls.inputId);return done.promise;};
 const runtime=createOarRuntime(native,observe);
 const emit=(text,extra={})=>listener({sessionId:'root',agentPath:[],kind:'text_delta',text,...extra});
 const start=(extra={})=>runtime.start({task:'task',cwd:'/workspace',signal:new AbortController().signal,...extra});
 return {done,calls,session,native,observe,runtime,emit,start};
}
test('root-only latest message, one prompt/completion, default no timeout, wait only observes',async()=>{
 const f=fake(), h=f.start();await tick();
 f.emit('old',{messageId:'a'});f.emit('ignore',{agentPath:['child']});f.emit('ignore',{sessionId:'other'});f.emit('answer',{messageId:'b'});f.emit('!',{messageId:'b'});
 assert.equal(await h.wait(5),undefined);assert.equal(f.calls.abort,0);assert.equal(f.calls.dispose,0);
 f.done.resolve({kind:'completed'});const result=await h.result;
 assert.equal(result.text,'answer!');assert.equal(result.stopReason,'completed');assert.equal(result.partial,false);
 assert.equal(await h.wait(),result);await Promise.all([h.dispose(),h.cancel(),h.dispose()]);
 assert.equal(f.calls.prompt,1);assert.equal(f.calls.abort,0);assert.equal(f.calls.dispose,1);assert.equal(f.calls.unsubscribe,1);
});
test('cancel deduplicates, partial survives independent cleanup failure, late completion ignored',async()=>{
 const f=fake({async dispose(){f.calls.dispose++;throw Error('SECRET');}}), h=f.start();await tick();f.emit('partial');
 await Promise.all([h.cancel(),h.dispose(),h.cancel()]);const r=await h.result;
 assert.equal(r.stopReason,'aborted');assert.equal(r.text,'partial');assert.equal(r.partial,true);assert.equal(r.cleanupFailure.stage,'dispose');
 assert.equal(f.calls.abort,1);assert.equal(f.calls.dispose,1);f.done.resolve({kind:'completed'});await tick();assert.equal(await h.result,r);assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('startup cancellation disposes late session without ever prompting',async()=>{
 const f=fake(), startup=deferred(), controller=new AbortController();f.native.session=async()=>{f.calls.session++;return startup.promise;};
 const h=f.start({signal:controller.signal});await tick();controller.abort();const cancel=h.cancel();startup.resolve(f.session);await cancel;
 assert.equal((await h.result).stopReason,'aborted');assert.equal(f.calls.prompt,0);assert.equal(f.calls.abort,1);assert.equal(f.calls.dispose,1);
});
test('already aborted and installation cancellation do not open session',async()=>{
 const f=fake(), controller=new AbortController();controller.abort();assert.equal((await f.start({signal:controller.signal}).result).stopReason,'aborted');assert.equal(f.calls.installation,0);
 const probe=deferred(), c=new AbortController();f.native.installation=()=>probe.promise;const h=f.start({signal:c.signal});c.abort();probe.resolve({kind:'available'});await h.result;assert.equal(f.calls.session,0);
});
test('explicit timeout preserves partial and cleans once without native completion',async()=>{
 const f=fake(),h=f.start({timeoutMs:15});await tick();f.emit('partial');const r=await h.result;assert.equal(r.stopReason,'timeout');assert.equal(r.text,'partial');assert.equal(f.calls.abort,1);assert.equal(f.calls.dispose,1);
});
test('rejection, native failure and thrown prompt are not retried',async()=>{
 for(const mode of ['reject','failed','throw']) {
  const f=fake();if(mode!=='failed')f.session.prompt=async()=>{f.calls.prompt++;if(mode==='throw')throw Error('SECRET');return {kind:'rejected',code:'busy'};};
  const h=f.start();if(mode==='failed')f.done.resolve({kind:'failed',failure:'SECRET'});const r=await h.result;
  assert.equal(r.stopReason,'error');assert.equal(f.calls.prompt,1);assert.equal(f.calls.dispose,1);assert.equal(r.diagnostics[0].stage,'turn');assert.ok(!JSON.stringify(r).includes('SECRET'));
 }
});
test('event subscription failure still disposes; installation/startup fail safely',async()=>{
 const f=fake({events(){throw Error('SECRET');}});assert.equal((await f.start().result).stopReason,'error');assert.equal(f.calls.dispose,1);
 for(const stage of ['installation','session']) {const g=fake();g.native[stage]=async()=>{throw Error('SECRET');};const r=await g.start().result;assert.equal(r.stopReason,'error');assert.equal(g.calls.prompt,0);assert.ok(!JSON.stringify(r).includes('SECRET'));}
});
test('deployment options snapshot, task cannot override launch settings, validation',async()=>{
 const f=fake(), options={env:{KEY:'fixed'},launchArgs:['safe'],model:'fixed'};
 const runtime=createOarRuntime(f.native,f.observe,options);options.env.KEY='changed';options.launchArgs.push('bad');
 const h=runtime.start({task:'task',cwd:'/workspace',signal:new AbortController().signal,env:{KEY:'injected'},launchArgs:['bad']});f.done.resolve({kind:'completed'});await h.result;
 assert.deepEqual(f.calls.options.env,{KEY:'fixed'});assert.deepEqual(f.calls.options.launchArgs,['safe']);
 for(const timeoutMs of [0,-1,NaN,Infinity,2147483648])assert.throws(()=>f.start({timeoutMs}));assert.throws(()=>f.start({task:' '}));
});
test('terminal outcome cannot be overwritten by cancellation during cleanup',async()=>{
 const cleanup=deferred(),f=fake({async dispose(){f.calls.dispose++;return cleanup.promise;}}),h=f.start();await tick();f.done.resolve({kind:'completed'});await tick();const cancel=h.cancel();assert.equal(f.calls.abort,0);cleanup.resolve();await cancel;assert.equal((await h.result).stopReason,'completed');assert.equal(f.calls.dispose,1);
});
test('timeout during startup disposes late session; late turn rejection is observed',async()=>{
 const f=fake(),startup=deferred();f.native.session=()=>startup.promise;const h=f.start({timeoutMs:5});await new Promise(r=>setTimeout(r,10));startup.resolve(f.session);assert.equal((await h.result).stopReason,'timeout');assert.equal(f.calls.prompt,0);assert.equal(f.calls.dispose,1);
 const g=fake(),j=g.start();await tick();await j.cancel();g.done.reject(Error('late'));await tick();assert.equal((await j.result).stopReason,'aborted');
});
test('abort failure is diagnostic, does not block disposal or replace partial',async()=>{
 const f=fake({async abort(){f.calls.abort++;throw Error('SECRET');}}),h=f.start();await tick();f.emit('partial');await h.cancel();const r=await h.result;assert.equal(r.text,'partial');assert.ok(r.diagnostics.some(d=>d.stage==='abort'));assert.equal(f.calls.dispose,1);
});
