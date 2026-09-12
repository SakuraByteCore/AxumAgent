# pi-memory

Bundled memory plugin for pi-coding-agent: persistent cross-session memory stored in a single JSON file (default `~/.pi/agent/memory.json`, override with `PI_MEMORY_FILE`). Single-file extension, zero native deps — pure Node.js (`fs`/`path`/`os` only), so it loads on every platform including Android/Termux.

## Commands

- `/memory save <text>` — add a memory
- `/memory list` — list all memories (numbered)
- `/memory find <query>` — case-insensitive substring search
- `/memory remove <n>` — remove memory #n
- `/memory recall [query]` — send matching (or all) memories into the conversation
- `/memory clear` — delete every memory

Each session start reports how many memories are stored.

## Why vendored locally

The upstream npm package (`@amaster.ai/pi-memory-mem0`) depends on `mem0ai`, which pulls `better-sqlite3` — a native module with no `android-arm64` prebuild. On Android/Termux the node-gyp source build fails and the whole install aborts, so the package cannot be bundled for all platforms. This plugin reimplements the memory workflow in pure JavaScript.
