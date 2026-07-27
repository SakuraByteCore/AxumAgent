import { isRec, has } from "./utils.js";

function tryParseContentLines(record: Record<string, unknown>, key: string): void {
  const val = record[key];
  if (typeof val !== "string") return;
  try {
    const parsed = JSON.parse(val);
    if (Array.isArray(parsed)) { record[key] = parsed; return; }
  } catch {
    // fall through to error
  }
  throw new Error(
    `[E_BAD_SHAPE] "content_lines" must be a native JSON array of strings, not a JSON string. Pass it as a proper JSON array: ["line1", "line2"].`
  );
}

export function normalizeFilePath(record: Record<string, unknown>): void {
  if (typeof record.path !== "string" && typeof record.file_path === "string") {
    record.path = record.file_path;
    delete record.file_path;
  }
}

function normalizeField(record: Record<string, unknown>, from: string, to: string): void {
  if (!has(record, from)) return;
  const raw = record[from];
  if (Array.isArray(raw)) {
    record[to] = raw;
  } else if (isRec(raw)) {
    record[to] = [raw];
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) record[to] = parsed;
      else if (isRec(parsed)) record[to] = [parsed];
    } catch {
      // leave as-is
    }
  }
  if (from !== to) delete record[from];
}

export function normReq(request: unknown): Record<string, unknown> {
  if (!isRec(request)) throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  const record: Record<string, unknown> = { ...request };
  normalizeFilePath(record);
  // content_lines normalization
  if ("changes" in record && Array.isArray(record.changes)) {
    for (const change of record.changes) {
      if (isRec(change)) tryParseContentLines(change, "content_lines");
    }
  }
  if ("content_lines" in record) tryParseContentLines(record, "content_lines");
  normalizeField(record, "edits", "changes");
  return record;
}
