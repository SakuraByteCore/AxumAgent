import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "./provider-config.js";

export function getSessionsDir(env = process.env) {
  return path.join(getAgentDir(env), "sessions");
}

function safeReadFirstLine(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      const chunk = buf.subarray(0, n).toString("utf8");
      const nl = chunk.indexOf("\n");
      return nl === -1 ? chunk : chunk.slice(0, nl);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function parseSessionMeta(filePath) {
  const firstLine = safeReadFirstLine(filePath);
  if (!firstLine) return null;
  try {
    const obj = JSON.parse(firstLine);
    if (obj.type !== "session") return null;
    return {
      id: obj.id || "",
      timestamp: obj.timestamp || "",
      cwd: obj.cwd || "",
      version: obj.version || null,
    };
  } catch {
    return null;
  }
}

function restoreCwdFromDirName(dirName) {
  // Best-effort reverse of cwd → dir-name encoding done by Pi.
  // Only meaningful for display; the original cwd is stored in the session line.
  return dirName ? dirName.replace(/^-+/, "") : "";
}

export function listSessions({ env = process.env, maxSummaryChars = 200, limitPerProject = 500 } = {}) {
  const sessionsDir = getSessionsDir(env);
  if (!fs.existsSync(sessionsDir)) return { projects: [] };

  const projectEntries = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort();

  const projects = [];
  for (const dir of projectEntries) {
    const projectDir = path.join(sessionsDir, dir.name);
    const files = fs.readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse()
      .slice(0, limitPerProject);

    const sessions = [];
    for (const fileName of files) {
      const filePath = path.join(projectDir, fileName);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      const meta = parseSessionMeta(filePath);
      if (!meta) {
        sessions.push({
          file: dir.name + "/" + fileName,
          exists: true,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          id: "",
          timestamp: "",
          cwd: "",
          summary: "",
          messageCount: 0,
        });
        continue;
      }
      sessions.push({
        file: dir.name + "/" + fileName,
        fileName,
        projectDir: dir.name,
        exists: true,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        id: meta.id,
        timestamp: meta.timestamp,
        cwd: meta.cwd,
        version: meta.version,
        summary: extractSummary(filePath, maxSummaryChars),
        messageCount: countMessages(filePath),
      });
    }
    if (sessions.length) {
      projects.push({
        dir: dir.name,
        cwdHint: sessions[0]?.cwd || restoreCwdFromDirName(dir.name),
        count: sessions.length,
        sessions,
      });
    }
  }
  return { projects };
}

function extractSummary(filePath, maxChars) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== "message") continue;
        const msg = obj.message;
        if (!msg || msg.role !== "user") continue;
        const content = msg.content;
        if (typeof content === "string") return content.slice(0, maxChars);
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part && part.type === "text" && part.text) return part.text.slice(0, maxChars);
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // File read failed; fall through.
  }
  return "";
}

function countMessages(filePath) {
  let count = 0;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(65536);
      let leftover = "";
      let pos = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n === 0) break;
        pos += n;
        leftover += buf.subarray(0, n).toString("utf8");
        const lines = leftover.split("\n");
        leftover = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "message") count += 1;
          } catch {
            // Ignore malformed lines.
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // File unreadable; return what we have.
  }
  return count;
}

export function readSession({ file, env = process.env, maxMessages = 500, maxContentChars = 2000 } = {}) {
  if (!file) throw new Error("file is required");
  const sessionsDir = getSessionsDir(env);
  const filePath = path.join(sessionsDir, file);

  // Prevent path traversal: resolved path must stay under sessionsDir.
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(sessionsDir);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error("Invalid session file path");
  }
  if (!fs.existsSync(filePath)) throw new Error("Session file not found");

  const messages = [];
  let sessionMeta = null;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(65536);
      let leftover = "";
      let pos = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n === 0) break;
        pos += n;
        leftover += buf.subarray(0, n).toString("utf8");
        const lines = leftover.split("\n");
        leftover = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type === "session" && !sessionMeta) {
            sessionMeta = { id: obj.id, timestamp: obj.timestamp, cwd: obj.cwd, version: obj.version };
          }
          if (obj.type !== "message") continue;
          if (messages.length >= maxMessages) continue;
          const msg = obj.message || {};
          const role = msg.role || "unknown";
          let text = "";
          if (typeof msg.content === "string") {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .map((part) => {
                if (!part) return "";
                if (part.type === "text") return part.text || "";
                if (part.type === "tool_use") return `[tool_use: ${part.name || ""}]`;
                if (part.type === "tool_result") return `[tool_result]`;
                return part.type ? `[${part.type}]` : "";
              })
              .join("\n");
          }
          messages.push({
            id: obj.id || "",
            role,
            timestamp: obj.timestamp || "",
            parentId: obj.parentId || null,
            text: text.slice(0, maxContentChars),
            truncated: text.length > maxContentChars,
          });
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new Error(`Failed to read session: ${error.message}`);
  }
  return { file, session: sessionMeta, messages, count: messages.length };
}

export function deleteSession({ file, env = process.env } = {}) {
  if (!file) throw new Error("file is required");
  const sessionsDir = getSessionsDir(env);
  const filePath = path.join(sessionsDir, file);

  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(sessionsDir);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error("Invalid session file path");
  }

  if (!fs.existsSync(filePath)) {
    return { deleted: false, file, reason: "not found" };
  }
  fs.unlinkSync(filePath);

  // Clean up empty parent project directory.
  const parentDir = path.dirname(filePath);
  try {
    const remaining = fs.readdirSync(parentDir);
    if (remaining.length === 0) fs.rmdirSync(parentDir);
  } catch {
    // Best-effort cleanup; ignore errors.
  }

  return { deleted: true, file };
}
