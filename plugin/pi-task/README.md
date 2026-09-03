# pi-task

Lean isolated subagent tool for Pi. **Zero runtime dependencies.**

One tool (`subagent`), four actions:

| action | what it does |
| --- | --- |
| `spawn` | Start an isolated child Pi session (`pi --mode json -p --no-session -ne --no-skills --no-prompt-templates --no-context-files`) with a tool allowlist; returns a `jobId` immediately so work can continue in parallel |
| `wait` | Block until the job finishes (max 120s) and return the full report |
| `status` | Job state plus a report tail |
| `kill` | Stop the job |

On completion a `subagent-complete` steering message delivers the report as a
new turn, so the parent conversation only sees the final report, never the
child's intermediate work.

## Parameters

- `action`: spawn / wait / status / kill
- `task` (spawn): full task including role, e.g. "You are a code reviewer; review X and report findings"
- `tools` (spawn): comma list, default `read,bash,grep,find,ls`; add `write,edit` only when the child should modify files
- `cwd` (spawn): working directory, defaults to the session cwd
- `model` / `timeoutSec` (spawn): optional; timeout default 600s
- `jobId` (wait/status/kill)

## Design

Children are fully isolated: own minimal prompt, ephemeral (`--no-session`),
and launched without skills, prompt templates, or context files. Follow-up
questions are handled by spawning a new subagent with context from the
previous report. At most 4 subagents run concurrently; reports are clipped at
6k characters in the notification (`action=status` shows the tail). The
interactive UI shows a live `subagent-async` widget with one row per running
job, refreshed every second.

## License

MIT
