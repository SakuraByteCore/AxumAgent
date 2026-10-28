import test from 'node:test';
import assert from 'node:assert/strict';
import { armExecutionDeadline, throwIfDispatchDeadline, DispatchDeadlineError, promptChildUntilSettled } from '../plugin/pi-agent/child-recovery.ts';
import { AgentStopError, isDispatchDeadlineFailure, getPartialAssistantText } from '../plugin/pi-agent/final-response.ts';
const state = () => ({ status:'starting', finished:new Promise(()=>{}) });
test('absolute cutoff includes startup and guards a late-created session', t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 const agent=state(); armExecutionDeadline(agent,100,1050);
 t.mock.timers.tick(50); assert.equal(agent.stopCause,'deadline');
 agent.session={abort:()=>assert.fail('no new execution'),steer:()=>{}};
 assert.throws(()=>throwIfDispatchDeadline(agent),DispatchDeadlineError);
});
test('slow wait remains covered without collector timeouts stopping work', async t => {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 let settle,aborts=0; const agent=state(); agent.status='recovering';
 agent.session={prompt:async()=>{},waitForIdle:()=>new Promise(r=>settle=r),abort:()=>{aborts++},steer:()=>{}};
 armExecutionDeadline(agent,100); const pending=promptChildUntilSettled(agent.session,'task');
 await Promise.resolve(); t.mock.timers.tick(99); assert.equal(aborts,0);
 t.mock.timers.tick(1); assert.equal(aborts,1); settle(); await pending;
});
test('completion wins cutoff race even before finished promise resolves', t=>{
 t.mock.timers.enable({apis:['setTimeout']}); const agent=state();
 armExecutionDeadline(agent,100); agent.completedAt=1;t.mock.timers.tick(100);
 assert.equal(agent.stopCause,undefined);
});
test('cancel and rejected finished both clear timers',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const agent=state();const cancel=armExecutionDeadline(agent,100);cancel();cancel();
 t.mock.timers.tick(100);assert.equal(agent.timeoutMs,undefined);assert.equal(agent.cancelDeadline,undefined);
 const failed={...state(),finished:Promise.reject(new Error('failure'))};armExecutionDeadline(failed,100);
 await Promise.resolve();t.mock.timers.tick(100);assert.equal(failed.timeoutMs,undefined);
});
test('abort and steer sync/async failures are observed',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const errors=[]; const agent=state();
 agent.session={isStreaming:true,steer:()=>{throw Error('steer')},abort:async()=>{throw Error('abort')}};
 armExecutionDeadline(agent,100,Date.now()+100,(event,error)=>errors.push(error.message));
 t.mock.timers.tick(100);await Promise.resolve();assert.deepEqual(errors,['steer','abort']);
});
test('real execution failures are not reclassified as deadline partials',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const agent=state();agent.error='provider failed';
 armExecutionDeadline(agent,100);t.mock.timers.tick(100);assert.equal(agent.timeoutMs,undefined);
 agent.stopCause='deadline';assert.equal(isDispatchDeadlineFailure(agent,new Error('provider failed')),false);
 assert.equal(isDispatchDeadlineFailure(agent,new AgentStopError({stopReason:'error'})),false);
 assert.equal(isDispatchDeadlineFailure(agent,new AgentStopError({stopReason:'aborted'})),true);
 assert.equal(isDispatchDeadlineFailure(agent,new DispatchDeadlineError()),true);
 const session={agent:{state:{messages:[{role:'assistant',content:[{type:'text',text:'partial'}],stopReason:'aborted'}]}}};
 assert.equal(getPartialAssistantText(session,0),'partial');session.agent.state.messages[0].stopReason='error';
 assert.throws(()=>getPartialAssistantText(session,0),AgentStopError);
});
