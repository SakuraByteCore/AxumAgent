/** Pi does not expose parent approval handlers through ExtensionContext. Fail closed:
 * children may only use builtin read/search tools active on the parent. No shell,
 * custom tools, write tools or recursive delegation until a policy bridge exists.
 * This is a tool ceiling, not an OS filesystem sandbox. */
export const SAFE_CHILD_TOOLS = new Set(["read", "grep", "find", "ls"]);
export function inheritedToolCeiling(parentTools: readonly string[], requested?: readonly string[], excluded: readonly string[] = [], noTools = false): string[] {
 if(noTools)return [];
 const parent=new Set(parentTools), deny=new Set(excluded);
 return [...new Set(requested ?? parentTools)].filter(name=>parent.has(name)&&SAFE_CHILD_TOOLS.has(name)&&!deny.has(name));
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
