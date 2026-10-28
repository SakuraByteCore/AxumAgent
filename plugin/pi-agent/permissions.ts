import * as path from "node:path";
import { realpathSync } from "node:fs";
/** Legacy command contexts have no nested executor: never silently grant raw tools. */
export const SAFE_CHILD_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const BUILTIN_CHILD_TOOLS = new Set([...SAFE_CHILD_TOOLS, "write", "edit", "bash"]);
const DELEGATION = new Set(["dispatch_agent", "manage_agent", "orchestrate", "quick", "agent"]);
export type ParentToolBridge = { tools: readonly any[]; getActiveTools?:()=>readonly string[]; validate?:()=>void; executeTool(name:string,args:unknown,options?:any):Promise<any> };
export type ChildPermissions = { writeScope?: string[]; testCommands?: string[]; bridge?: ParentToolBridge };
export function inheritedToolCeiling(parentTools: readonly string[], requested?: readonly string[], excluded: readonly string[] = [], noTools = false, bridged = false): string[] {
 if(noTools)return [];
 const parent=new Set(parentTools), deny=new Set(excluded);
 return [...new Set(requested ?? parentTools)].filter(name=>parent.has(name)&&!DELEGATION.has(name)&&(bridged ? BUILTIN_CHILD_TOOLS.has(name) : SAFE_CHILD_TOOLS.has(name))&&!deny.has(name));
}
/** Resolve existing ancestors too, preventing symlink and ../ scope escapes. */
export function canonicalScope(value:string,cwd:string):string {
 let current=path.resolve(cwd,value),tail:string[]=[];
 while(true){try{return path.join(realpathSync(current),...tail);}catch(error:any){if(error.code!=="ENOENT")throw error;const parent=path.dirname(current);if(parent===current)throw error;tail.unshift(path.basename(current));current=parent;}}
}
function contains(root:string,target:string){const relative=path.relative(root,target);return relative===""||(!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative));}
export class WriteScopeLocks {
 private owners=new Map<string,string[]>();
 acquire(owner:string,scopes:readonly string[],cwd:string):()=>void {
  const roots=scopes.map(s=>canonicalScope(s,cwd));
  if(roots.some(root=>!contains(canonicalScope(cwd,cwd),root)))throw new Error("writeScope must remain within cwd");
  for(const [id,held] of this.owners)if(id!==owner&&roots.some(a=>held.some(b=>contains(a,b)||contains(b,a))))throw new Error("Write scope conflicts with active agent "+id);
  this.owners.set(owner,roots);let released=false;
  return ()=>{if(!released){released=true;this.owners.delete(owner);}};
 }
}
/** No tool implementation is invoked directly: every operation re-enters parent hooks/approval. */
export function bridgedChildTools(bridge:ParentToolBridge,allowed:readonly string[],scopes:readonly string[],cwd:string,testCommands:readonly string[]=[]){
 const ceiling=new Set(allowed);
 return bridge.tools.filter(tool=>ceiling.has(tool.name)&&BUILTIN_CHILD_TOOLS.has(tool.name)&&tool.sourceInfo?.source==="builtin"&&tool.sourceInfo?.path===`builtin:${tool.name}`).map(tool=>({
  name:tool.name,label:tool.label??tool.name,description:tool.description,parameters:tool.parameters,
  async execute(_id:string,args:any,signal:AbortSignal,onUpdate:any){
   bridge.validate?.();
   if(!bridge.getActiveTools?.().includes(tool.name))throw new Error("Parent tool no longer active");
   if(scopes.some(root=>!contains(canonicalScope(cwd,cwd),canonicalScope(root,cwd))))throw new Error("writeScope must remain within cwd");
   if(tool.name==="bash" && (typeof args?.command!=="string" || !testCommands.includes(args.command)))throw new Error("Shell command not in explicitly authorized testCommands (not sandboxed)");
   if(tool.name==="write"||tool.name==="edit"){
    if(typeof args?.path!=="string"||!scopes.some(root=>contains(canonicalScope(root,cwd),canonicalScope(args.path,cwd))))throw new Error("Write outside assigned writeScope");
   }
   // Shell cannot be path-sandboxed by a string allowlist. It remains parent-policy mediated;
   // writable scopes take a workspace-wide lock while bash is enabled.
   if(!SAFE_CHILD_TOOLS.has(tool.name)&&scopes.length===0)throw new Error("Mutating tools require explicit writeScope");
   if(!bridge.tools.some(t=>t.name===tool.name&&t.sourceInfo?.source==="builtin"&&t.sourceInfo?.path==="builtin:"+tool.name))throw new Error("Parent tool no longer available");
   const outcome=await bridge.executeTool(tool.name,args,{signal,onUpdate});
   if(outcome.isError)throw new Error(outcome.result.content?.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n")||"Parent tool denied");
   return outcome.result;
  }
 }));
}
export function guardChildTools(session: {setActiveToolsByName(names:string[]):void; extensionRunner: {hasHandlers?: (event:string)=>boolean; emitToolCall: (...args:any[])=>Promise<any>}}, allowed: readonly string[]): void {
 const ceiling=new Set(allowed);session.setActiveToolsByName([...ceiling]);
 const hasHandlers=session.extensionRunner.hasHandlers?.bind(session.extensionRunner);
 if(hasHandlers)session.extensionRunner.hasHandlers=(event)=>event==="tool_call" || hasHandlers(event);
 const original=session.extensionRunner.emitToolCall.bind(session.extensionRunner);
 session.extensionRunner.emitToolCall=async(event)=>{
  if(!ceiling.has(event.toolName))return {block:true,reason:"Blocked by inherited background-agent tool ceiling"};
  return original(event);
 };
}
