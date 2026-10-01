/**
 * Thin dual-dialect DB wrapper (SQLite via node:sqlite, PostgreSQL via pg).
 * - `?` placeholders in all SQL (converted to $n for Postgres)
 * - booleans stored as INTEGER 0/1, timestamps as ISO-8601 UTC TEXT, JSON as TEXT
 */
import { DatabaseSync } from 'node:sqlite';
import { AsyncMutex } from './mutex.js';

export type Dialect = 'sqlite' | 'postgres';
export type Row = Record<string, unknown>;
export type Param = string | number | bigint | null | boolean | Uint8Array | undefined;

export interface Db {
  readonly dialect: Dialect;
  run(sql: string, params?: Param[]): Promise<{ changes: number }>;
  get<T = Row>(sql: string, params?: Param[]): Promise<T | undefined>;
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function normParams(params: Param[] = []): Param[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

// ---------------- SQLite ----------------
class SqliteDb implements Db {
  readonly dialect: Dialect = 'sqlite';
  private mutex = new AsyncMutex();
  constructor(private conn: DatabaseSync, private inTx = false) {}

  static open(path: string): SqliteDb {
    const conn = new DatabaseSync(path);
    conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    return new SqliteDb(conn);
  }
  private async guard<T>(fn: () => T): Promise<T> {
    if (this.inTx) return fn();
    return this.mutex.run(async () => fn());
  }
  run(sql: string, params: Param[] = []) {
    return this.guard(() => { const r = this.conn.prepare(sql).run(...(normParams(params) as never[])); return { changes: Number(r.changes) }; });
  }
  get<T = Row>(sql: string, params: Param[] = []) {
    return this.guard(() => this.conn.prepare(sql).get(...(normParams(params) as never[])) as T | undefined);
  }
  all<T = Row>(sql: string, params: Param[] = []) {
    return this.guard(() => this.conn.prepare(sql).all(...(normParams(params) as never[])) as T[]);
  }
  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return this.mutex.run(async () => {
      const inner = new SqliteDb(this.conn, true);
      this.conn.exec('BEGIN IMMEDIATE');
      try { const out = await fn(inner); this.conn.exec('COMMIT'); return out; }
      catch (e) { try { this.conn.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    });
  }
  async close() { this.conn.close(); }
}

// ---------------- PostgreSQL ----------------
function toPg(sql: string): string { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }

class PgDb implements Db {
  readonly dialect: Dialect = 'postgres';
  constructor(private pool: import('pg').Pool, private client?: import('pg').PoolClient) {}
  static async open(url: string): Promise<PgDb> {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: url, max: 10 });
    return new PgDb(pool);
  }
  private q() { return this.client ?? this.pool; }
  async run(sql: string, params: Param[] = []) { const r = await this.q().query(toPg(sql), normParams(params)); return { changes: r.rowCount ?? 0 }; }
  async get<T = Row>(sql: string, params: Param[] = []) { const r = await this.q().query(toPg(sql), normParams(params)); return r.rows[0] as T | undefined; }
  async all<T = Row>(sql: string, params: Param[] = []) { const r = await this.q().query(toPg(sql), normParams(params)); return r.rows as T[]; }
  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.client) return fn(this);
    const client = await this.pool.connect();
    const inner = new PgDb(this.pool, client);
    try { await client.query('BEGIN'); const out = await fn(inner); await client.query('COMMIT'); return out; }
    catch (e) { try { await client.query('ROLLBACK'); } catch { /* ignore */ } throw e; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}

export async function openDb(opts: { driver: Dialect; url?: string; sqlitePath?: string }): Promise<Db> {
  if (opts.driver === 'postgres') { if (!opts.url) throw new Error('PROOFFLOW_DATABASE_URL required for postgres'); return PgDb.open(opts.url); }
  return SqliteDb.open(opts.sqlitePath ?? ':memory:');
}

export const nowIso = () => new Date().toISOString();
export const asBool = (v: unknown) => v === 1 || v === true || v === '1' || v === 't';
export const asJson = <T>(v: unknown, fallback: T): T => { if (v == null || v === '') return fallback; try { return JSON.parse(String(v)) as T; } catch { return fallback; } };
export const toJson = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
