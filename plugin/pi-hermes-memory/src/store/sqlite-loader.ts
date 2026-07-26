import { createRequire } from 'node:module';

type StatementLike = {
  run: (...args: any[]) => any;
  get: (...args: any[]) => any;
  all: (...args: any[]) => any;
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
  pragma?: (query: string, options?: any) => any;
  transaction?: (fn: any) => any;
};

export type DatabaseCtor = new (dbPath: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }) => DatabaseLike;

type BunDatabaseInstance = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: (throwOnError?: boolean) => void;
  transaction?: (fn: any) => any;
};

type NodeSqliteDatabaseInstance = {
  prepare: (sql: string) => NodeSqliteStatementLike;
  exec: (sql: string) => void;
  close: () => void;
};

type NodeSqliteStatementLike = {
  run: (...args: any[]) => any;
  get: (...args: any[]) => any;
  all: (...args: any[]) => any[];
};

function createBunCompatDatabaseCtor(require: NodeRequire): DatabaseCtor {
  const bunSqlite = require('bun:sqlite') as { Database: new (dbPath: string) => BunDatabaseInstance };

  return class BunCompatDatabase implements DatabaseLike {
    private readonly db: BunDatabaseInstance;

    constructor(dbPath: string) {
      this.db = new bunSqlite.Database(dbPath);
    }

    prepare(sql: string): StatementLike {
      return this.db.prepare(sql);
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    close(): void {
      this.db.close();
    }

    transaction(fn: any): any {
      if (!this.db.transaction) {
        return undefined;
      }
      return this.db.transaction(fn);
    }
  };
}

function createNodeSqliteCompatDatabaseCtor(): DatabaseCtor {
  const nodeSqlite = require('node:sqlite') as { DatabaseSync: new (dbPath: string, options?: any) => NodeSqliteDatabaseInstance };

  return class NodeSqliteCompatDatabase implements DatabaseLike {
    private readonly db: NodeSqliteDatabaseInstance;

    constructor(dbPath: string, options?: any) {
      this.db = new nodeSqlite.DatabaseSync(dbPath, options ?? {});
    }

    prepare(sql: string): StatementLike {
      const stmt = this.db.prepare(sql);
      return {
        run: (...args: any[]) => stmt.run(...args),
        get: (...args: any[]) => stmt.get(...args),
        all: (...args: any[]) => stmt.all(...args),
      };
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    close(): void {
      this.db.close();
    }

    pragma(query: string, options?: { simple?: boolean }): any {
      const sql = 'PRAGMA ' + query;
      const stmt = this.db.prepare(sql);
      const rows = stmt.all();
      if (options?.simple) {
        if (rows.length === 0) return undefined;
        const row = rows[0] as Record<string, unknown>;
        const values = Object.values(row);
        return values.length === 1 ? values[0] : row;
      }
      return rows;
    }

    transaction(fn: any): any {
      return (...args: any[]) => {
        this.db.exec('BEGIN');
        try {
          const result = fn(...args);
          this.db.exec('COMMIT');
          return result;
        } catch (err) {
          this.db.exec('ROLLBACK');
          throw err;
        }
      };
    }
  };
}

export function isAndroidLikeRuntime(): boolean {
  return process.platform === 'android' || Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes('/com.termux/'));
}

export async function loadDatabaseCtorAsync(): Promise<DatabaseCtor> {
  const require = createRequire(import.meta.url);
  const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

  if (isBunRuntime) {
    return createBunCompatDatabaseCtor(require);
  }

  if (isAndroidLikeRuntime()) {
    return createNodeSqliteCompatDatabaseCtor();
  }

  const { loadBetterSqlite3 } = await import('./sqlite-native.js');
  return loadBetterSqlite3({ requireImpl: require }) as DatabaseCtor;
}
