import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "./provider-config.js";

export const MAX_PROMPT_HISTORY_ENTRIES = 100;
export const MAX_PROMPT_HISTORY_EXPORT_BYTES = 3 * 1024 * 1024;
export const GLOBAL_PROMPT_HISTORY_PROJECT = "__global__";
const PROMPT_HISTORY_FILE = "prompt-history";
const GLOBAL_PROMPT_HISTORY_FILE = "prompt-history-global";
const MAX_ENTRY_CHARS = 500;

export function getPromptHistorySessionsDir(env = process.env) {
  return path.join(getAgentDir(env), "sessions");
}

export function getGlobalPromptHistoryFile(env = process.env) {
  return path.join(getAgentDir(env), GLOBAL_PROMPT_HISTORY_FILE);
}

function resolveHistoryFile(project, sessionsDir) {
  if (typeof project !== "string") throw new Error("project must be a string");
  if (!project || project.includes("/") || project.includes("\\") || project === "." || project === "..") {
    throw new Error("Invalid project");
  }
  const base = path.resolve(sessionsDir);
  const filePath = path.resolve(base, project, PROMPT_HISTORY_FILE);
  if (filePath !== base && !filePath.startsWith(base + path.sep)) throw new Error("Invalid project");
  return filePath;
}

function readHistoryFile(filePath) {
  if (!fs.existsSync(filePath)) return { entries: [], duplicates: 0 };
  const raw = fs.readFileSync(filePath, "utf8");
  const seen = new Set();
  const entries = [];
  let duplicates = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text) continue;
    if (seen.has(text)) {
      duplicates += 1;
      continue;
    }
    seen.add(text);
    entries.push(text);
  }
  return { entries, duplicates };
}

function writeHistoryFile(filePath, entries) {
  const seen = new Set();
  const unique = [];
  for (const text of entries) {
    if (!seen.has(text)) {
      seen.add(text);
      unique.push(text);
    }
  }
  const keep = unique.length > MAX_PROMPT_HISTORY_ENTRIES ? unique.slice(-MAX_PROMPT_HISTORY_ENTRIES) : unique;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!keep.length) {
    // An empty history file is dead weight: drop it so an empty project
    // dir can be pruned, and the next append recreates both.
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  const data = keep.map((text) => JSON.stringify(text)).join("\n") + "\n";
  fs.writeFileSync(filePath, data, { mode: 0o600 });
}

function cwdHintFromDirName(dirName) {
  // Best-effort reverse of Pi's --cwd-slug-- session dir name; display only.
  const slug = dirName.replace(/^-+|-+$/g, "");
  if (!slug) return dirName;
  const restored = slug.replace(/-/g, "/").replace(/^([A-Za-z])-/, "$1:/");
  return /^[A-Za-z]:/.test(restored) ? restored : "/" + restored;
}

function historyEntries(entries, maxEntryChars) {
  return entries
    .map((text, index) => ({
      index,
      text: text.length > maxEntryChars ? text.slice(0, maxEntryChars) : text,
      truncated: text.length > maxEntryChars,
      length: text.length,
    }))
    .reverse();
}

export function listPromptHistory({ env = process.env, maxEntryChars = MAX_ENTRY_CHARS } = {}) {
  const sessionsDir = getPromptHistorySessionsDir(env);
  const globalFile = getGlobalPromptHistoryFile(env);
  const global = readHistoryFile(globalFile);
  const projects = [];
  let totalEntries = 0;
  let totalDuplicates = 0;

  if (global.entries.length) {
    totalEntries += global.entries.length;
    totalDuplicates += global.duplicates;
    projects.push({
      dir: GLOBAL_PROMPT_HISTORY_PROJECT,
      cwdHint: "Global",
      scope: "global",
      entries: historyEntries(global.entries, maxEntryChars),
      duplicates: global.duplicates,
      total: global.entries.length,
    });
  }

  if (fs.existsSync(sessionsDir)) {
    const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      const filePath = path.join(sessionsDir, dir.name, PROMPT_HISTORY_FILE);
      const { entries, duplicates } = readHistoryFile(filePath);
      totalDuplicates += duplicates;
      if (!entries.length) continue;
      totalEntries += entries.length;
      projects.push({
        dir: dir.name,
        cwdHint: cwdHintFromDirName(dir.name),
        scope: "project",
        entries: historyEntries(entries, maxEntryChars),
        duplicates,
        total: entries.length,
      });
    }
  }
  return { projects, totalEntries, totalDuplicates };
}

export function deletePromptHistoryEntries({ env = process.env, project, indexes }) {
  if (!project || typeof project !== "string") throw new Error("project is required");
  if (!Array.isArray(indexes) || !indexes.length) throw new Error("indexes must be a non-empty array");
  const sessionsDir = getPromptHistorySessionsDir(env);
  const filePath = resolveHistoryFile(project, sessionsDir);
  if (!fs.existsSync(filePath)) return { deleted: 0, total: 0, failed: [{ index: null, reason: "not found" }] };
  const { entries } = readHistoryFile(filePath);
  const targets = new Set();
  const failed = [];
  for (const raw of indexes) {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
      failed.push({ index: raw, reason: "out of range" });
      continue;
    }
    targets.add(index);
  }
  const survivors = entries.filter((_, index) => !targets.has(index));
  writeHistoryFile(filePath, survivors);
  const projectDir = path.dirname(filePath);
  try {
    if (!fs.readdirSync(projectDir).length) fs.rmdirSync(projectDir);
  } catch {
    // Best-effort cleanup; ignore errors.
  }
  return { deleted: targets.size, total: entries.length, failed };
}

export function promotePromptHistoryEntry({ env = process.env, project, index }) {
  if (!project || typeof project !== "string") throw new Error("project is required");
  const normalizedIndex = Number(index);
  if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) throw new Error("index must be a non-negative integer");
  const sessionsDir = getPromptHistorySessionsDir(env);
  const projectFile = resolveHistoryFile(project, sessionsDir);
  if (!fs.existsSync(projectFile)) throw new Error("Prompt history project not found");
  const projectEntries = readHistoryFile(projectFile).entries;
  if (normalizedIndex >= projectEntries.length) throw new Error("Prompt history index out of range");
  const text = projectEntries[normalizedIndex];
  const globalFile = getGlobalPromptHistoryFile(env);
  const globalEntries = readHistoryFile(globalFile).entries;
  if (!globalEntries.includes(text)) writeHistoryFile(globalFile, [...globalEntries, text]);
  writeHistoryFile(projectFile, projectEntries.filter((_, entryIndex) => entryIndex !== normalizedIndex));
  try {
    const projectDir = path.dirname(projectFile);
    if (!fs.readdirSync(projectDir).length) fs.rmdirSync(projectDir);
  } catch {
    // Best-effort cleanup; ignore errors.
  }
  return {
    text,
    index: normalizedIndex,
    globalTotal: readHistoryFile(globalFile).entries.length,
    projectTotal: projectEntries.length - 1,
  };
}

export function deleteGlobalPromptHistoryEntry({ env = process.env, index }) {
  const normalizedIndex = Number(index);
  if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) throw new Error("index must be a non-negative integer");
  const globalFile = getGlobalPromptHistoryFile(env);
  if (!fs.existsSync(globalFile)) return { deleted: 0, total: 0 };
  const { entries } = readHistoryFile(globalFile);
  if (normalizedIndex >= entries.length) throw new Error("Prompt history index out of range");
  const survivors = entries.filter((_, entryIndex) => entryIndex !== normalizedIndex);
  writeHistoryFile(globalFile, survivors);
  return { deleted: 1, total: entries.length };
}

export function deleteAllPromptHistory({ env = process.env } = {}) {
  const sessionsDir = getPromptHistorySessionsDir(env);
  if (!fs.existsSync(sessionsDir)) return { deleted: 0, total: 0, failed: [] };
  const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const failed = [];
  let deleted = 0;
  let total = 0;
  for (const dir of dirs) {
    try {
      const filePath = resolveHistoryFile(dir.name, sessionsDir);
      const { entries } = readHistoryFile(filePath);
      total += entries.length;
      if (!entries.length) continue;
      writeHistoryFile(filePath, []);
      deleted += entries.length;
      const projectDir = path.dirname(filePath);
      try {
        if (!fs.readdirSync(projectDir).length) fs.rmdirSync(projectDir);
      } catch {
        // Best-effort cleanup; ignore errors.
      }
    } catch (error) {
      failed.push({ project: dir.name, reason: error.message });
    }
  }
  return { deleted, total, failed };
}

export function exportPromptHistory({ env = process.env, projects, maxBytes = MAX_PROMPT_HISTORY_EXPORT_BYTES } = {}) {
  const sessionsDir = getPromptHistorySessionsDir(env);
  const selected = Array.isArray(projects) ? projects.map((project) => String(project)).filter(Boolean) : null;
  const items = [];
  if (!fs.existsSync(sessionsDir) && !fs.existsSync(getGlobalPromptHistoryFile(env))) {
    return { items, totalEntries: 0 };
  }
  const globalEntries = readHistoryFile(getGlobalPromptHistoryFile(env)).entries;
  if (globalEntries.length) items.push({ project: GLOBAL_PROMPT_HISTORY_PROJECT, scope: "global", entries: globalEntries });
  if (fs.existsSync(sessionsDir)) {
    const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      if (selected && !selected.includes(dir.name)) continue;
      const filePath = path.join(sessionsDir, dir.name, PROMPT_HISTORY_FILE);
      const { entries } = readHistoryFile(filePath);
      if (!entries.length) continue;
      items.push({ project: dir.name, scope: "project", entries });
    }
  }
  const encoded = Buffer.byteLength(JSON.stringify(items), "utf8");
  if (encoded > maxBytes) throw new Error(`Prompt history export exceeds ${maxBytes} bytes (${encoded}); reduce selection and retry`);
  return { items, totalEntries: items.reduce((sum, item) => sum + item.entries.length, 0) };
}

export function importPromptHistory({ items, env = process.env, overwrite = false }) {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  const sessionsDir = getPromptHistorySessionsDir(env);
  let added = 0;
  let replaced = 0;
  let skipped = 0;
  let duplicatesRemoved = 0;
  const failed = [];
  for (const item of items) {
    const isGlobal = item?.scope === "global" || item?.project === GLOBAL_PROMPT_HISTORY_PROJECT;
    const project = String(item?.project ?? "").trim();
    const incoming = Array.isArray(item?.entries)
      ? item.entries.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
      : [];
    if (!isGlobal && !project) {
      failed.push({ project: "", reason: "empty project name" });
      continue;
    }
    let filePath;
    try {
      filePath = isGlobal ? getGlobalPromptHistoryFile(env) : resolveHistoryFile(project, sessionsDir);
    } catch (error) {
      failed.push({ project, reason: error.message });
      continue;
    }
    const existed = fs.existsSync(filePath);
    const { entries: current, duplicates } = readHistoryFile(filePath);
    duplicatesRemoved += duplicates;
    if (overwrite) {
      writeHistoryFile(filePath, incoming);
      if (existed) replaced += incoming.length;
      else added += incoming.length;
    } else {
      if (!existed) {
        writeHistoryFile(filePath, incoming);
        added += incoming.length;
        continue;
      }
      const known = new Set(current);
      const merged = incoming.filter((text) => !known.has(text));
      skipped += incoming.length - merged.length;
      if (merged.length) writeHistoryFile(filePath, current.concat(merged));
      added += merged.length;
    }
  }
  return { added, replaced, skipped, duplicatesRemoved, failed, total: items.length };
}
