import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { hashStorePath, hashStoreDir } from "./paths.js";
import { HASH_STORE_BUSY_TIMEOUT } from "./constants.js";

type StatementLike = {
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Record<string, unknown>[];
  run: (...params: unknown[]) => void;
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
  pragma?: (query: string) => unknown;
};

export interface HashStore {
  readonly db: DatabaseLike;
}

let cachedDb: DatabaseLike | null = null;

function createNodeSqliteDb(dbPath: string): DatabaseLike {
  const nodeSqlite = require("node:sqlite") as { DatabaseSync: new (p: string, o?: Record<string, unknown>) => DatabaseLike };
  return new nodeSqlite.DatabaseSync(dbPath, {});
}

function openDb(storePath: string): DatabaseLike {
  if (cachedDb) return cachedDb;
  mkdirSync(hashStoreDir(), { recursive: true });
  const db = createNodeSqliteDb(storePath);
  try {
    db.pragma?.(`busy_timeout = ${HASH_STORE_BUSY_TIMEOUT}`);
  } catch {
    // node:sqlite may not support pragma; non-fatal
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS snapshots (" +
      "path TEXT PRIMARY KEY, " +
      "checksum TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
    ")"
  );
  cachedDb = db;
  return db;
}

export async function loadHashStore(): Promise<HashStore> {
  const storePath = hashStorePath();
  if (!existsSync(hashStoreDir())) mkdirSync(hashStoreDir(), { recursive: true });
  const db = openDb(storePath);
  return { db };
}

function escapeSql(s: string): string {
  return s.replace(/'/g, "''");
}

export function getSnapshot(store: HashStore, path: string, content: string): string[] | null {
  const stmt = store.db.prepare("SELECT hashes FROM snapshots WHERE path = ?");
  const row = stmt.get(path) as { hashes?: string } | undefined;
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
  // Store content alongside hashes so getSnapshot can match by exact content.
  const data = JSON.stringify({ content: content ?? "", hashes });
  store.db.exec(
    "INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) " +
    `VALUES ('${escapeSql(path)}', '${escapeSql(checksum)}', ${lineCount}, '${escapeSql(data)}', ${Date.now()})`
  );
}

export async function pruneMissing(store: HashStore): Promise<void> {
  // Remove snapshots for files that no longer exist on disk.
  const rows = store.db.prepare("SELECT path FROM snapshots").all() as { path: string }[];
  for (const row of rows) {
    if (!existsSync(row.path)) {
      store.db.exec(`DELETE FROM snapshots WHERE path = '${row.path.replace(/'/g, "''")}'`);
    }
  }
}
