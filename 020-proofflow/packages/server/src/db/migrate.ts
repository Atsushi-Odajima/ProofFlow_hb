import type { Db } from './db.js';
import { MIGRATIONS } from './schema.js';
import { nowIso } from './db.js';

export async function migrate(db: Db): Promise<string[]> {
  await db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set((await db.all<{ id: string }>(`SELECT id FROM schema_migrations`)).map((r) => r.id));
  const done: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await db.tx(async (tx) => {
      for (const stmt of m.sql) await tx.run(stmt);
      await tx.run(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`, [m.id, nowIso()]);
    });
    done.push(m.id);
  }
  return done;
}
