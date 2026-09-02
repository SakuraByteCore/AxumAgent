# pi-task

Local task-delegation extension: a `task` tool that spawns fresh subagent sessions
via `createAgentSession`, modeled after oh-my-pi's task tool.

## Tool

- Single spawn: `{ task, name?, agent? }`
- Batch fan-out: `{ tasks: [{ name?, agent, task }] }` — runs items concurrently
  under a semaphore (default 4), bounded by a max-width guard (default 8).

## Agents

Built-ins: `general-purpose` (full tools) and `explorer` (read-only:
read/grep/find/ls).

Custom profiles are Markdown files with frontmatter (`description`, optional
`tools`, `model`, `thinking`) discovered from, in increasing precedence:

1. `~/.omp/agent/agents/` (oh-my-pi compat)
2. `~/.pi/agent/subagents/`
3. `<cwd>/.pi/agents/`

Child sessions exclude the `task` tool, so subagents cannot delegate further.
