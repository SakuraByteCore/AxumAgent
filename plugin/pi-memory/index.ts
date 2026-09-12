// pi-memory: persistent cross-session memory for pi-coding-agent.
// Single-file extension, zero native deps — pure Node.js (fs/path/os only).
// Storage: one JSON file (default ~/.pi/agent/memory.json, override with PI_MEMORY_FILE).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const DEFAULT_MEMORY_FILE = join(homedir(), ".pi", "agent", "memory.json");
const MAX_MEMORIES = 500;
const LIST_PREVIEW_WIDTH = 80;
const MIN_INDEX = 1;

const MEMORY_HELP = [
  "pi-memory — persistent cross-session memory:",
  "  /memory save <text>    add a memory",
  "  /memory list           list all memories",
  "  /memory find <query>   case-insensitive substring search",
  "  /memory remove <n>     remove memory #n (see /memory list)",
  "  /memory recall [query] send matching (or all) memories into the conversation",
  "  /memory clear          delete every memory",
].join("\n");

function memoryFilePath() {
  const override = process.env.PI_MEMORY_FILE;
  return override ? override : DEFAULT_MEMORY_FILE;
}

async function loadMemories() {
  const file = memoryFilePath();
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a memory array`);
  }
  return parsed.map((entry) => String(entry));
}

async function persistMemories(memories) {
  const file = memoryFilePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(memories, null, 2)}\n`, "utf8");
}

function truncate(text, width) {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function formatMemory(index, memory) {
  return `${index}. ${truncate(memory, LIST_PREVIEW_WIDTH)}`;
}

function selectMatches(memories, query) {
  if (!query) return memories.map((text, position) => ({ index: position + 1, text }));
  return memories
    .map((text, position) => ({ index: position + 1, text }))
    .filter((entry) => entry.text.toLowerCase().includes(query));
}

async function handleSave(args, ctx) {
  const text = args.trim();
  if (!text) {
    ctx.ui.notify("Usage: /memory save <text>", "warning");
    return;
  }
  const memories = await loadMemories();
  if (memories.length >= MAX_MEMORIES) {
    ctx.ui.notify(`Memory store is full (${MAX_MEMORIES} entries); remove entries first.`, "error");
    return;
  }
  memories.push(text);
  await persistMemories(memories);
  ctx.ui.notify(`Saved memory #${memories.length}.`, "info");
}

async function handleList(_args, ctx) {
  const memories = await loadMemories();
  if (memories.length === 0) {
    ctx.ui.notify("Memory store is empty.", "info");
    return;
  }
  ctx.ui.notify(memories.map((memory, position) => formatMemory(position + 1, memory)).join("\n"), "info");
}

async function handleFind(args, ctx) {
  const query = args.trim().toLowerCase();
  if (!query) {
    ctx.ui.notify("Usage: /memory find <query>", "warning");
    return;
  }
  const hits = selectMatches(await loadMemories(), query);
  if (hits.length === 0) {
    ctx.ui.notify(`No memories match "${query}".`, "info");
    return;
  }
  ctx.ui.notify(hits.map((hit) => formatMemory(hit.index, hit.text)).join("\n"), "info");
}

async function handleRemove(args, ctx) {
  const position = Number.parseInt(args.trim(), 10);
  if (!Number.isFinite(position) || position < MIN_INDEX) {
    ctx.ui.notify("Usage: /memory remove <index> (1-based, see /memory list)", "warning");
    return;
  }
  const memories = await loadMemories();
  if (position > memories.length) {
    ctx.ui.notify(`No memory #${position}; the store holds ${memories.length} entries.`, "warning");
    return;
  }
  const [removed] = memories.splice(position - 1, 1);
  await persistMemories(memories);
  ctx.ui.notify(`Removed memory #${position}: ${truncate(removed, LIST_PREVIEW_WIDTH)}`, "info");
}

async function handleClear(_args, ctx) {
  const memories = await loadMemories();
  if (memories.length === 0) {
    ctx.ui.notify("Memory store is already empty.", "info");
    return;
  }
  await persistMemories([]);
  ctx.ui.notify(`Cleared ${memories.length} memories.`, "info");
}

async function handleRecall(args, ctx, pi) {
  const memories = await loadMemories();
  if (memories.length === 0) {
    ctx.ui.notify("Nothing to recall: the memory store is empty.", "warning");
    return;
  }
  const query = args.trim().toLowerCase();
  const hits = selectMatches(memories, query);
  if (hits.length === 0) {
    ctx.ui.notify(`No memories match "${query}".`, "warning");
    return;
  }
  const payload = hits.map((hit) => `- ${hit.text}`).join("\n");
  const header = query ? `Recalled memories matching "${query}":` : "Recalled memories:";
  await pi.sendUserMessage(`${header}\n${payload}`, { streamingBehavior: "followUp" });
  ctx.ui.notify(`Sent ${hits.length} memories to the conversation.`, "info");
}

export default function (pi) {
  const SUBCOMMANDS = {
    save: handleSave,
    list: handleList,
    find: handleFind,
    remove: handleRemove,
    clear: handleClear,
    recall: handleRecall,
  };

  pi.registerCommand("memory", {
    description: "Persistent cross-session memory: /memory save|list|find|remove|recall|clear",
    getArgumentCompletions: () => null,
    async handler(args, ctx) {
      const trimmed = args.trim();
      const separator = trimmed.indexOf(" ");
      const subcommand = separator === -1 ? trimmed : trimmed.slice(0, separator);
      const rest = separator === -1 ? "" : trimmed.slice(separator + 1);
      const handler = SUBCOMMANDS[subcommand];
      if (!handler) {
        ctx.ui.notify(MEMORY_HELP, "info");
        return;
      }
      try {
        await handler(rest, ctx, pi);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`pi-memory: ${message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const memories = await loadMemories();
      if (memories.length > 0) {
        ctx.ui.notify(`pi-memory: ${memories.length} memories stored (/memory list, /memory recall)`, "info");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-memory: failed to load memories: ${message}`, "warning");
    }
  });
}
