import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "./provider-config.js";

const modes = {
  system: "SYSTEM.md",
  append: "APPEND_SYSTEM.md",
};

export function normalizeSystemPromptMode(mode = "append") {
  if (!Object.hasOwn(modes, mode)) throw new Error("Invalid system prompt mode");
  return mode;
}

export function normalizeSystemPromptScope(scope = "global") {
  if (!["global", "project"].includes(scope)) throw new Error("Invalid system prompt scope");
  return scope;
}

export function hashContent(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function resolveSystemPromptFile({ scope = "global", mode = "append", cwd = process.cwd(), env = process.env } = {}) {
  const normalizedScope = normalizeSystemPromptScope(scope);
  const normalizedMode = normalizeSystemPromptMode(mode);
  const filename = modes[normalizedMode];
  const base = normalizedScope === "global" ? getAgentDir(env) : path.join(path.resolve(cwd), ".pi");
  return {
    scope: normalizedScope,
    mode: normalizedMode,
    filename,
    path: path.join(base, filename),
    replaceDefault: normalizedMode === "system",
  };
}

export function readSystemPromptFile(options = {}) {
  const target = resolveSystemPromptFile(options);
  const exists = fs.existsSync(target.path);
  const content = exists ? fs.readFileSync(target.path, "utf8") : "";
  return {
    ...target,
    exists,
    content,
    hash: hashContent(content),
  };
}

function splitLines(content) {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function createUnifiedDiff({ oldContent = "", newContent = "", filePath = "SYSTEM.md" } = {}) {
  if (oldContent === newContent) return "No changes\n";
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const oldLabel = oldLines.length ? filePath : "/dev/null";
  const newLabel = newLines.length ? filePath : "/dev/null";
  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const contextBefore = oldLines.slice(Math.max(0, prefix - 3), prefix);
  const removed = oldLines.slice(prefix, oldSuffix + 1);
  const added = newLines.slice(prefix, newSuffix + 1);
  const contextAfter = oldLines.slice(oldSuffix + 1, Math.min(oldLines.length, oldSuffix + 4));
  out.push(`@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`);
  for (const line of contextBefore) out.push(` ${line}`);
  for (const line of removed) out.push(`-${line}`);
  for (const line of added) out.push(`+${line}`);
  for (const line of contextAfter) out.push(` ${line}`);
  return `${out.join("\n")}\n`;
}

export function diffSystemPromptFile({ content = "", ...options } = {}) {
  const current = readSystemPromptFile(options);
  return { ...current, newHash: hashContent(content), diff: createUnifiedDiff({ oldContent: current.content, newContent: content, filePath: current.path }) };
}

export function saveSystemPromptFile({ content = "", baseHash, ...options } = {}) {
  if (!String(content).trim()) throw new Error("System prompt cannot be empty");
  const current = readSystemPromptFile(options);
  if (baseHash && baseHash !== current.hash) throw new Error("System prompt file changed on disk; reload before saving");
  fs.mkdirSync(path.dirname(current.path), { recursive: true });
  fs.writeFileSync(current.path, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600 });
  try { fs.chmodSync(current.path, 0o600); } catch {}
  return readSystemPromptFile(options);
}
