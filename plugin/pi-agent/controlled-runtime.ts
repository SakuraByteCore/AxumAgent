import type { Runtime, RuntimeResult } from './runtime.js';
/** Existing parent-mediated SDK execution behind the same one-shot contract.
 * Cancellation owns cleanup, never prompts again and never retries side effects.
 * Kept free of runtime imports so it can be loaded in isolation; error kinds are matched by name.
 */
export function createControlledRuntime(ops: {
 execute(task:string):Promise<string>; partial():string;
 abort():Promise<unknown>; dispose():Promise<unknown>;
}):Runtime {
 return {start(request){
  if(!request.task.trim()||!request.cwd.trim())throw new Error("task and cwd are required");
  let done=false,stopped:'aborted'|'timeout'|undefined,cleanup:Promise<void>|undefined,abort:Promise<void>|undefined;
  const diagnostics:RuntimeResult['diagnostics'][number][]=[];
  let cleanupFailure:RuntimeResult['cleanupFailure'];
  const dispose=()=>cleanup??=Promise.resolve().then(()=>ops.dispose()).then(()=>{},()=>{cleanupFailure={stage:'dispose',message:'Controlled SDK cleanup failed'};});
  const stop=(reason:'aborted'|'timeout')=>{if(done||stopped)return;stopped=reason;abort=Promise.resolve().then(()=>ops.abort()).then(()=>{},()=>{diagnostics.push({stage:'abort',message:'Controlled SDK abort failed'});});};
  const onAbort=()=>stop('aborted');request.signal.addEventListener('abort',onAbort,{once:true});
  if(request.signal.aborted)onAbort();
  const result=(async():Promise<RuntimeResult>=>{
   let text='',stopReason:RuntimeResult['stopReason']='completed';
   try {if(!stopped)text=await ops.execute(request.task);if(stopped){text=ops.partial();stopReason=stopped;}}
   catch (error) {
    const errorName=error instanceof Error?error.name:'';
    const errorMessage=error instanceof Error?error.message:String(error);
    const agentAborted=errorName==='AgentStopError'&&(error as {stopReason?:string}).stopReason==='aborted';
    stopReason=stopped??(errorName==='DispatchDeadlineError'?'timeout':agentAborted?'aborted':'error');
    // One failure yields one diagnostic: the partial probe below must not repeat it.
    if(!stopped)diagnostics.push({stage:'turn',message:errorName==='DispatchDeadlineError'?'Controlled SDK task timed out':errorName==='AgentStopError'?errorMessage:'Controlled SDK task failed'});
    try {text=ops.partial();}
    catch (partialError) {if(partialError instanceof Error&&partialError.name==='AgentStopError')text=(partialError as {partialText?:string}).partialText||text;}
   }
   finally{done=true;request.signal.removeEventListener('abort',onAbort);await abort;await dispose();}
   return {text,stopReason,partial:stopReason!=='completed'&&!!text,diagnostics:[...diagnostics],...cleanupFailure?{cleanupFailure}:{}};
  })();
  return {result,async wait(timeoutMs){if(timeoutMs===undefined)return result;let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([result,new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),timeoutMs);})]);}finally{clearTimeout(timer!);}},async cancel(){stop('aborted');await result;},async dispose(){if(!done)stop('aborted');await result;}};
 }};
}
