import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { realpathSync, lstatSync } from "node:fs";
/** Legacy command contexts have no nested executor: never silently grant raw tools. */
export const SAFE_CHILD_TOOLS = new Set(["read", "grep", "find", "ls"]);
const READ_ONLY_PARENT_TOOLS = new Set(["web_search","fetch_content","get_search_content","source_check","lsp"]);
export const BUILTIN_CHILD_TOOLS = new Set([...SAFE_CHILD_TOOLS, "write", "edit", "bash"]);
const DELEGATION = new Set(["dispatch_agent", "manage_agent", "orchestrate", "quick", "agent"]);
const require = createRequire(import.meta.url);
/** Preserve builtin provenance; allow only the installed hashline read/search replacements. */
export function isDelegableParentTool(tool: any): boolean {
 if(READ_ONLY_PARENT_TOOLS.has(tool.name)){
  if(typeof tool.sourceInfo?.path!=="string")return false;
  try {
   const root=tool.name==="lsp" ? path.dirname(fileURLToPath(import.meta.url)) : path.dirname(require.resolve("pi-web-access/package.json"));
   return ["index.ts","index.js"].some(entry=>path.resolve(tool.sourceInfo.path)===path.join(root,entry)&&realpathSync(tool.sourceInfo.path)===path.join(realpathSync(root),entry));
  }catch(error:any){if(error.code==="MODULE_NOT_FOUND"||error.code==="ENOENT")return false;throw error;}
 }
 if(!BUILTIN_CHILD_TOOLS.has(tool.name))return false;
 const source=tool.sourceInfo;
 if(source?.source==="builtin" && source.path===`builtin:${tool.name}`)return true;
 if(!["read","grep"].includes(tool.name) || typeof source?.path!=="string")return false;
 try {
  const root=path.dirname(require.resolve("pi-hashline-edit-pro/package.json"));
  const entry=path.resolve(source.path);
  if(entry!==path.join(root,"index.js") && entry!==path.join(root,"index.ts"))return false;
  return realpathSync(entry)===path.join(realpathSync(root),path.basename(entry));
 } catch(error:any) {
  if(error.code==="MODULE_NOT_FOUND" || error.code==="ENOENT")return false;
  throw error;
 }
}

export type ParentToolBridge = { tools: readonly any[]; getActiveTools?:()=>readonly string[]; validate?:()=>void; executeTool(name:string,args:unknown,options?:any):Promise<any> };
export type ChildPermissions = { role?: import("./roles.ts").AgentRole; backend?: "controlled-pi"; outputSchema?: import("./structured-output.ts").OutputSchema; fullTools?: boolean; writeScope?: string[]; testCommands?: string[]; bridge?: ParentToolBridge };
export function inheritedToolCeiling(parentTools: readonly string[], requested?: readonly string[], excluded: readonly string[] = [], noTools = false, bridged = false, fullTools = false): string[] {
 if(noTools)return [];
 const parent=new Set(parentTools), deny=new Set(excluded);
 return [...new Set(requested ?? parentTools)].filter(name=>parent.has(name)&&!DELEGATION.has(name)&&(bridged ? fullTools || BUILTIN_CHILD_TOOLS.has(name) || READ_ONLY_PARENT_TOOLS.has(name) : SAFE_CHILD_TOOLS.has(name))&&!deny.has(name));
}
/** Resolve existing ancestors too, preventing symlink and ../ scope escapes. */
export function canonicalScope(value:string,cwd:string):string {
 let current=path.resolve(cwd,value),tail:string[]=[];
 while(true){try{return path.join(realpathSync(current),...tail);}catch(error:any){if(error.code!=="ENOENT")throw error;
   try { if(lstatSync(current).isSymbolicLink())throw new Error("Dangling symlink is not an authorized scope path"); } catch(statError:any) { if(statError.code!=="ENOENT")throw statError; }
   const parent=path.dirname(current);if(parent===current)throw error;tail.unshift(path.basename(current));current=parent;}}
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
export function bridgedChildTools(bridge:ParentToolBridge,allowed:readonly string[],scopes:readonly string[],cwd:string,testCommands:readonly string[]=[],fullTools=false){
 const ceiling=new Set(allowed);
 return bridge.tools.filter(tool=>ceiling.has(tool.name)&&!DELEGATION.has(tool.name)&&(fullTools || isDelegableParentTool(tool))).map(tool=>({
  name:tool.name,label:tool.label??tool.name,description:tool.description,parameters:tool.parameters,promptGuidelines:tool.promptGuidelines,
  async execute(_id:string,args:any,signal:AbortSignal,onUpdate:any){
   bridge.validate?.();
   if(!bridge.getActiveTools?.().includes(tool.name))throw new Error("Parent tool no longer active");
   if(scopes.some(root=>!contains(canonicalScope(cwd,cwd),canonicalScope(root,cwd))))throw new Error("writeScope must remain within cwd");
   if(!fullTools && tool.name==="bash" && (typeof args?.command!=="string" || !testCommands.includes(args.command)))throw new Error("Shell command not in explicitly authorized testCommands (not sandboxed)");
   if(!fullTools && (tool.name==="write"||tool.name==="edit")){
    if(typeof args?.path!=="string"||!scopes.some(root=>contains(canonicalScope(root,cwd),canonicalScope(args.path,cwd))))throw new Error("Write outside assigned writeScope");
   }
   // Shell cannot be path-sandboxed by a string allowlist. It remains parent-policy mediated;
   // writable scopes take a workspace-wide lock while bash is enabled.
   if(!fullTools && !SAFE_CHILD_TOOLS.has(tool.name)&&!READ_ONLY_PARENT_TOOLS.has(tool.name)&&scopes.length===0)throw new Error("Mutating tools require explicit writeScope");
   if(!bridge.tools.some(t=>t.name===tool.name&&(fullTools || isDelegableParentTool(t))&&t.sourceInfo?.path===tool.sourceInfo?.path))throw new Error("Parent tool no longer available");
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
