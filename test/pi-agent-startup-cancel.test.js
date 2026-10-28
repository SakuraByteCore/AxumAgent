import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=stripTypeScriptTypes(readFileSync(new URL('../plugin/pi-agent/controlled-runtime.ts',import.meta.url),'utf8'),{mode:'transform'});
const {createControlledRuntime}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
// Controlled operations model async session creation; this is not a real SDK startup test.
test('cancel during startup waits for late owned resource and disposes without prompting',async()=>{
 const startup=deferred();let stopped=false,resource,prompts=0,disposals=0;
 const controller=new AbortController();
 const h=createControlledRuntime({execute:async()=>{resource=await startup.promise;if(stopped)return '';prompts++;return 'unexpected';},partial:()=>'',abort:async()=>{stopped=true;},dispose:async()=>{if(resource){disposals++;resource.dispose();}}}).start({task:'one',cwd:process.cwd(),signal:controller.signal});
 controller.abort();const cancel=h.cancel();let settled=false;h.result.then(()=>settled=true);
 await new Promise(r=>setImmediate(r));assert.equal(settled,false,'cancel retains ownership of pending initialization');
 let closed=0;startup.resolve({dispose(){closed++;}});await cancel;
 assert.equal((await h.result).stopReason,'aborted');assert.equal((await h.result).partial,false);
 assert.equal(prompts,0);assert.equal(disposals,1);assert.equal(closed,1);await h.dispose();assert.equal(closed,1);
});
