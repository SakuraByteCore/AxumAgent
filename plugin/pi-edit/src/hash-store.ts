import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { hashStorePath, hashStoreDir } from "./paths.js";

interface SnapshotRow {
  path: string;
  checksum: string;
  line_count: number;
  hashes: string;
  updated_at: number;
}

export interface HashStore {
  readonly rows: Map<string, SnapshotRow>;
  readonly storePath: string;
  dirty: boolean;
}

let cached: HashStore | null = null;

function loadFromDisk(storePath: string): Map<string, SnapshotRow> {
  if (!existsSync(storePath)) return new Map();
  try {
    const raw = readFileSync(storePath, "utf8");
    const arr = JSON.parse(raw) as SnapshotRow[];
    const map = new Map<string, SnapshotRow>();
    for (const row of arr) {
      if (row && typeof row.path === "string") map.set(row.path, row);
    }
    return map;
  } catch {
    return new Map();
  }
}

export function flushStore(store: HashStore): void {
  if (!store.dirty) return;
  mkdirSync(hashStoreDir(), { recursive: true });
  const arr = Array.from(store.rows.values());
  writeFileSync(store.storePath, JSON.stringify(arr), "utf8");
  store.dirty = false;
}

export async function loadHashStore(): Promise<HashStore> {
  if (cached) return cached;
  const storePath = hashStorePath();
  if (!existsSync(hashStoreDir())) mkdirSync(hashStoreDir(), { recursive: true });
  const rows = loadFromDisk(storePath);
  cached = { rows, storePath, dirty: false };
  return cached;
}

export function getSnapshot(store: HashStore, path: string, content: string): string[] | null {
  const row = store.rows.get(path);
  if (!row?.hashes) return null;
  try {
    const parsed = JSON.parse(row.hashes) as { content: string; hashes: string[] };
    if (parsed.content === content) return parsed.hashes;
  } catch {
    // fall through
  }
  return null;
}

export function upsertSnapshot(
  store: HashStore,
  path: string,
  checksum: string,
  lineCount: number,
  hashes: string[],
  content?: string,
): void {
  const data = JSON.stringify({ content: content ?? "", hashes });
  store.rows.set(path, {
    path,
    checksum,
    line_count: lineCount,
    hashes: data,
    updated_at: Date.now(),
  });
  store.dirty = true;
}

export async function pruneMissing(store: HashStore): Promise<void> {
  let changed = false;
  for (const [path, row] of store.rows) {
    if (!existsSync(row.path)) {
      store.rows.delete(path);
      changed = true;
    }
  }
  if (changed) store.dirty = true;
  flushStore(store);
}
