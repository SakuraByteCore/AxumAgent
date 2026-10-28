import type { RunningAgent } from "./shared.js";

export type ManagedState = "pending" | "running" | "completed" | "partial" | "failed" | "cancelled" | "closed";
export type AgentRecord = { id: string; releaseScope?:()=>void; acquireScope?:()=>void; batchId?: string; state: ManagedState; agent?: RunningAgent; error?: string; response?: string };
/** Session-local ledger. Waiting is observation only; it never cancels execution. */
export class AgentRegistry {
 generation = 0;
 readonly pendingStarts = new Set<Promise<unknown>>();
 shutdown(): void {this.generation++;for(const r of this.records.values())if(r.state==="pending")r.state="closed";this.changed();}
 readonly records = new Map<string, AgentRecord>();
 private listeners = new Set<() => void>();
 readonly limit: number;
 constructor(limit = 6) {this.limit=limit;}
 reserve(id: string, batchId?: string): AgentRecord {
  this.refresh();
  if(this.records.has(id))throw new Error("Duplicate agent id");
  if ([...this.records.values()].filter(r => r.state === "pending" || r.state === "running" || !!r.agent?.runtimeResult?.cleanupFailure).length >= this.limit) throw new Error("Background agent concurrency limit reached; wait for a lane to finish");
  const record: AgentRecord = {id, batchId, state:"pending"}; this.records.set(id,record); this.changed(); return record;
 }
 attach(record: AgentRecord, agent: RunningAgent): void { if(record.state==="closed")throw new Error("Child closed during startup"); record.agent=agent; record.state="running"; this.changed(); }
 settle(record: AgentRecord): void {
  if(!record.agent?.runtimeResult?.cleanupFailure){record.releaseScope?.();record.releaseScope=undefined;}
  const agent=record.agent; if (!agent || record.state === "closed" || record.state === "cancelled") return;
  record.response=agent.responseText; record.error=agent.error;
  record.state=agent.aborted ? "cancelled" : agent.timeoutMs !== undefined ? "partial" : agent.error ? "failed" : "completed"; this.changed();
 }
 fail(record: AgentRecord, error: unknown): void {if(!record.agent?.runtimeResult?.cleanupFailure){record.releaseScope?.();record.releaseScope=undefined;}if(record.state==="closed")return;record.state="failed";record.error=String(error);this.changed();}
 refresh(): void {for(const record of this.records.values()){const a=record.agent;if(a?.status==="idle" && record.state==="running")this.settle(record);}}
 snapshot(batchId?: string) { this.refresh(); return [...this.records.values()].filter(r=>batchId===undefined || r.batchId===batchId) .map(({agent,releaseScope,acquireScope,...r})=>({...r,agentId:agent?.id,status:agent?.status,response:agent?.responseText ?? r.response,error:agent?.error ?? r.error,backend:agent?.backend,capabilities:{oneShot:!!agent?.oneShot,send:false,resume:false,rebase:!agent?.oneShot},runtimeResult:agent?.runtimeResult})); }
 async wait(ids: string[], timeoutMs: number, signal?: AbortSignal): Promise<{timedOut:boolean; records: ReturnType<AgentRegistry["snapshot"]>}> {
  const complete=()=>{this.refresh();return ids.every(id=>{const r=this.records.get(id);return r && r.state!=="pending" && r.state!=="running";});};
  if (!complete()) await new Promise<void>((resolve,reject)=>{
   let timer: ReturnType<typeof setTimeout>;
   const cleanup=()=>{clearTimeout(timer);this.listeners.delete(check);signal?.removeEventListener("abort",abort);};
   const check=()=>{if(complete()){cleanup();resolve();}};
   const abort=()=>{cleanup();reject(new Error("Wait cancelled; agents continue running"));};
   this.listeners.add(check);timer=setTimeout(()=>{cleanup();resolve();},timeoutMs);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();else check();
  });
  return {timedOut:!complete(),records:this.snapshot().filter(r=>ids.includes(r.id))};
 }
 changed(): void {for(const listener of [...this.listeners])listener();}
}
