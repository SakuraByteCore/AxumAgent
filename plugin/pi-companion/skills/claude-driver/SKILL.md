---
name: claude-driver
description: Drive Claude Code (the `claude` CLI) to perform tasks the user delegates to Claude. Use when the user asks to use Claude, let Claude handle/analyze/review/build something, or route work to Claude Code ("use claude", "让 claude 做", "让 claude 处理", "claude 来做", "delegate to claude", "ask claude", "claude fix this"). Covers availability preflight, headless one-shot invocation, multi-turn session resume, output parsing, timeout control, and security bounds. Not for driving other CLIs or the local model.
---

# claude-driver

Route the task to the Claude Code CLI (`claude`) via headless invocation. Zero configuration is required beyond Claude Code itself being installed and logged in.

## Preflight (always first)

1. Run `claude --version`. If it fails, Claude Code is not installed: tell the user to install it (`npm install -g @anthropic-ai/claude-code`, see https://claude.com/install) and log in once with an interactive `claude` session. Do NOT silently fall back to the local model and do NOT fabricate output.
2. If `claude --version` succeeds, Claude Code is authenticated out of the box — no API key setup is needed in this skill.

## One-shot invocation (default)

Run the task in the target working directory:

- Simple: `claude -p "<task>"` from the target cwd. Stdout is the final answer.
- Task text contains quotes or newlines: pipe it via stdin instead of hand-quoting: `printf '%s' "<task>" | claude -p`.
- Structured output needed: add `--output-format json`; the JSON carries a `result` field (final answer) and a `session_id` field (use it for resume).
- Always wrap the call in a hard timeout (e.g. `timeout 300 claude -p ...`) so a hung upstream cannot block the session.

## Multi-turn work

- Continue the most recent session in the same cwd: `claude -c -p "<follow-up>"`.
- Resume a specific session: `claude --resume <session-id> -p "<follow-up>"` (session_id comes from a previous `--output-format json` run).
- Keep one session per repository or task; do not mix unrelated work into one session.

## Security bounds

- Never default to `--dangerously-skip-permissions` (or any full-permission mode). Only use it when the user explicitly asked for unattended execution, and say so plainly.
- Run Claude in the user's target project directory; do not point it at unrelated paths.
- Surface stderr and non-zero exits fully. A failed `claude` call is reported as failed — never rewrite it as a mock success.
- Claude may modify files in its cwd. Before delegating a mutation task, confirm the user actually wants Claude (not the local agent) to write.

## Concurrency

- One `claude` process per task. Serialize calls that touch the same repository; independent repositories may run in parallel.
