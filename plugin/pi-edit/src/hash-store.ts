import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashStorePath } from "./paths.js";

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

export async function flushStore(store: HashStore): Promise<void> {
  if (!store.dirty) return;
  mkdirSync(dirname(store.storePath), { recursive: true });
  const arr = Array.from(store.rows.values());
  await writeFile(store.storePath, JSON.stringify(arr), "utf8");
  store.dirty = false;
}

export async function loadHashStore(): Promise<HashStore> {
  if (cached) return cached;
  const storePath = hashStorePath();
  const storeDir = dirname(storePath);
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  const rows = loadFromDisk(storePath);
  cached = { rows, storePath, dirty: false };
  return cached;
}

export function getSnapshot(store: HashStore, path: string, checksum: string): string[] | null {
  const row = store.rows.get(path);
  if (!row?.hashes) return null;
  if (row.checksum !== checksum) return null;
  try {
    const parsed = JSON.parse(row.hashes) as string[];
    if (Array.isArray(parsed)) return parsed;
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
  maxPersistLines?: number,
): void {
  if (maxPersistLines !== undefined && lineCount > maxPersistLines) return;
  store.rows.set(path, {
    path,
    checksum,
    line_count: lineCount,
    hashes: JSON.stringify(hashes),
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
  await flushStore(store);
}
