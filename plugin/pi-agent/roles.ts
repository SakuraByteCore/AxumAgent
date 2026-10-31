export const AGENT_ROLES = {
 explorer: "Locate the requested symbols, files and direct callers. Return exact paths and relevant evidence; avoid broad repository tours. Respect the assigned tool permissions.",
 librarian: "Research the requested external APIs or documentation using available tools. Return source links, exact relevant facts and unresolved uncertainty; do not repeat local implementation work.",
 oracle: "Resolve the specified architecture, debugging or review question. Trace the concrete failure and recommend the smallest supported change with evidence.",
 designer: "Implement the assigned UI scope. Preserve existing conventions, accessibility and responsive behavior; report the actual interaction checks performed.",
 fixer: "Implement the bounded change in the owned files, run the authorized core checks, and return changes, evidence and remaining work without repeating discovery already supplied by the parent.",
} as const;
export type AgentRole = keyof typeof AGENT_ROLES;
export function roleInstruction(role?: AgentRole): string {
 if(role === undefined)return "";
 if(!Object.hasOwn(AGENT_ROLES,role))throw new Error("Unknown agent role: "+role);
 return `[Role: ${role}]\n${AGENT_ROLES[role]}\nUse the current model and thinking level unless explicitly overridden. Complete the task without an execution time limit. Do not dispatch other workers.\n\n`;
}
