import { armDispatchDeadline } from "./dispatch.ts";
import { Type } from "typebox";
import type { ExtensionAPI, RunningAgent } from "./shared.js";
import { AgentRegistry } from "./registry.ts";
export function registerAgentManagement(pi: ExtensionAPI, registry: AgentRegistry, agents: Set<RunningAgent>): void {
 pi.registerTool({name:"manage_agent",label:"Manage Agent",description:"Inspect agent/batch ledger, wait without cancelling, send input, interrupt a turn, or close a child. Main-turn cancellation only cancels a wait; close explicitly stops a child.",
 parameters:Type.Object({action:Type.Union(["status","wait","send","interrupt","close"].map(x=>Type.Literal(x))),agentId:Type.Optional(Type.String()),batchId:Type.Optional(Type.String()),input:Type.Optional(Type.String()),timeoutMs:Type.Optional(Type.Integer({minimum:1,maximum:60000}))}),
 async execute(_id,params,signal){
  const record=params.agentId?registry.records.get(params.agentId):undefined;
  const targets=record?[record]:params.batchId?[...registry.records.values()].filter(r=>r.batchId===params.batchId):[...registry.records.values()];
  if(params.agentId&&!record)throw new Error("Unknown agent id");
  if(params.action==="wait"){
   const result=await registry.wait(targets.map(r=>r.id),params.timeoutMs??10000,signal);
   return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
  }
  if(params.action!=="status"){
   if(!record && !params.batchId)throw new Error("Specify agentId or batchId");
   for(const r of targets){const a=r.agent;if(!a){if(params.action==="close"){r.state="closed";continue;}throw new Error("Child is still starting; retry input/interrupt after startup");}
    if(params.action==="send"){
     if(!params.input?.trim())throw new Error("Non-empty input required");
     if(a.resume){
      registry.refresh();
      if([...registry.records.values()].filter(x=>x.state==="running"||x.state==="pending").length>=registry.limit)throw new Error("Background agent concurrency limit reached");
      a.resume(params.input);r.state="running";a.status="running";
      armDispatchDeadline(a,params.timeoutMs??300000);
     }
     else if(a.session?.isStreaming)await a.session.steer(params.input);
     else throw new Error("Child has no live session; /agent resume explicitly redispatches legacy failures");
    }else if(params.action==="interrupt"){
     a.interruptRequested=true;await a.session?.abort();
    }else{
     a.aborted=true;a.cancelDeadline?.();a.retire?.();await a.session?.abort();r.state="closed";
    }
   }registry.changed();
  }
  const result=registry.snapshot(params.batchId);return {content:[{type:"text",text:JSON.stringify(result)}],details:{records:result}};
 }});
}
