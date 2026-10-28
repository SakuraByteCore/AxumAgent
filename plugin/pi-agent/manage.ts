import { Type } from "typebox";
import type { ExtensionAPI, RunningAgent } from "./shared.js";
import { AgentRegistry } from "./registry.ts";
export function registerAgentManagement(pi: ExtensionAPI, registry: AgentRegistry, agents: Set<RunningAgent>): void {
 pi.registerTool({name:"manage_agent",label:"Manage Agent",description:"Inspect or wait for one-shot agent/batch tasks. wait expiry never cancels execution. interrupt/close cancel the owned task; no send/resume/rebase. For new requirements inspect existing results and dispatch a new incremental task; never automatically retry side effects.",
 parameters:Type.Object({action:Type.Union(["status","wait","interrupt","close"].map(x=>Type.Literal(x))),agentId:Type.Optional(Type.String()),batchId:Type.Optional(Type.String()),timeoutMs:Type.Optional(Type.Integer({minimum:1,maximum:86400000}))}),
 async execute(_id,params,signal){
  if(!["status","wait","interrupt","close"].includes(params.action))throw new Error("One-shot tasks do not support send/resume/rebase. Inspect current results and use dispatch_agent for a new incremental task; do not retry side effects automatically.");
  const record=params.agentId?registry.records.get(params.agentId):undefined;
  const targets=record?[record]:params.batchId?[...registry.records.values()].filter(r=>r.batchId===params.batchId):[...registry.records.values()];
  if(params.agentId&&!record)throw new Error("Unknown agent id");
  if(params.action==="wait"){
   const result=await registry.wait(targets.map(r=>r.id),params.timeoutMs??10000,signal);
   return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
  }
  if(params.action!=="status"){
   if(!record&&!params.batchId)throw new Error("Specify agentId or batchId");
   await Promise.all(targets.map(async r=>{
    const a=r.agent;
    if(!a){r.releaseScope?.();r.releaseScope=undefined;r.state="closed";return;}
    if(a.status!=="running"&&r.state!=="running")return;
    a.aborted=true;a.interruptRequested=params.action==="interrupt";a.cancelDeadline?.();a.retire?.();
    // Keep scope ownership until execution AND cleanup settle, not merely until cancel was requested.
    if(a.runHandle)await a.runHandle.cancel();else await a.session?.abort();
    await a.finished;
    r.state=params.action==="close"?"closed":"cancelled";
   }));registry.changed();
  }
  const result=registry.snapshot(params.batchId);return {content:[{type:"text",text:JSON.stringify(result)}],details:{records:result}};
 }});
}
