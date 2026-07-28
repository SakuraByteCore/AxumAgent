import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { hashStorePath, hashStoreDir } from "./paths.js";
import { HASH_STORE_BUSY_TIMEOUT } from "./constants.js";

type StatementParams = unknown[];

interface SnapshotRow {
  path: string;
  checksum: string;
  line_count: number;
  hashes: string;
  updated_at: number;
}


type StatementLike = {
  get: (...params: StatementParams) => Record<string, unknown> | undefined;
  all: (...params: StatementParams) => Record<string, unknown>[];
  run: (...params: StatementParams) => void;
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
let memoryWarned = false;

function createNodeSqliteDb(dbPath: string): DatabaseLike {
  const nodeSqlite = require("node:sqlite") as { DatabaseSync: new (p: string, o?: Record<string, unknown>) => DatabaseLike };
  return new nodeSqlite.DatabaseSync(dbPath, {});
}

function createMemoryDb(): DatabaseLike {
  const rows = new Map<string, SnapshotRow>();

  function execImpl(sql: string): void {
    const insert = sql.match(/^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+snapshots\s*\(([^)]+)\)\s+VALUES\s*\(([^)]*)\)\s*$/i);
    if (insert) {
      const row = parseSnapshotValues(insert[2]);
      if (row) rows.set(row.path, row);
      return;
    }

    const deleteLiteral = sql.match(/^\s*DELETE\s+FROM\s+snapshots\s+WHERE\s+path\s*=\s*'([^']*(?:''[^']*)*)'\s*$/i);
    if (deleteLiteral) {
      rows.delete(deleteLiteral[1].replace(/''/g, "'"));
      return;
    }

    // CREATE TABLE and other DDL are no-ops for the memory backend.
  }

  return {
    prepare: (sql: string): StatementLike => {
      const selectAll = sql.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s+snapshots\s*$/i);
      if (selectAll) {
        const cols = selectAll[1];
        return {
          get: () => undefined,
          all: () => Array.from(rows.values()).map((row) => projectRow(row, cols)),
          run: () => undefined,
        };
      }

      const selectWhere = sql.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s+snapshots\s+WHERE\s+([\s\S]+?)\s*$/i);
      if (selectWhere) {
        return {
          get: (...params: StatementParams) => {
            const row = findRow(rows, selectWhere![2], params);
            return row ? projectRow(row, selectWhere![1]) : undefined;
          },
          all: () => [],
          run: () => undefined,
        };
      }

      return {
        get: () => undefined,
        all: () => [],
        run: () => undefined,
      };
    },
    exec: execImpl,
    close: () => {
      rows.clear();
    },
  };
}

function findRow(rows: Map<string, SnapshotRow>, where: string, params: StatementParams): SnapshotRow | undefined {
  // Supported: `path = ?` or `path = '<literal>'`.
  const equality = where.match(/^\s*(\w+)\s*=\s*(\?|'[^']*')\s*$/);
  if (!equality) return undefined;
  const column = equality[1];
  if (equality[2] === "?") {
    const value = params[0];
    if (column === "path" && typeof value === "string") return rows.get(value);
    return undefined;
  }
  const literal = equality[2].slice(1, -1);
  if (column === "path") return rows.get(literal);
  return undefined;
}

function projectRow(row: SnapshotRow, columns: string): Record<string, unknown> {
  const trimmed = columns.trim();
  if (trimmed === "*") return { ...row };
  const result: Record<string, unknown> = {};
  for (const col of trimmed.split(/,\s*/)) {
    const key = col.trim();
    if (key in row) result[key] = (row as Record<string, unknown>)[key];
  }
  return result;
}

function unquoteSqlLiteral(token: string): string {
  const trimmed = token.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseSnapshotValues(valuesGroup: string): SnapshotRow | null {
  // Parse the VALUES (...) clause of an INSERT OR REPLACE on the snapshots table.
  // Column order is fixed: path, checksum, line_count, hashes, updated_at.
  const parts = splitSqlValues(valuesGroup);
  if (parts.length < 5) return null;
  return {
    path: unquoteSqlLiteral(parts[0]!),
    checksum: unquoteSqlLiteral(parts[1]!),
    line_count: Number(parts[2]),
    hashes: unquoteSqlLiteral(parts[3]!),
    updated_at: Number(parts[4]),
  };
}

function splitSqlValues(values: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < values.length; i++) {
    const ch = values[i]!;
    if (inQuote) {
      current += ch;
      if (ch === "'") {
        if (values[i + 1] === "'") {
          current += values[++i]!;
        } else {
          inQuote = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      current += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function openDb(storePath: string): DatabaseLike {
  if (cachedDb) return cachedDb;

  let db: DatabaseLike;
  try {
    mkdirSync(hashStoreDir(), { recursive: true });
    db = createNodeSqliteDb(storePath);
  } catch (err) {
    if (!memoryWarned) {
      memoryWarned = true;
      console.error(
        "node:sqlite unavailable -> using in-memory hash store. Upgrade to Node 22.5+ for persistent hash cache.",
        err instanceof Error ? err.message : err,
      );
    }
    db = createMemoryDb();
  }

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
