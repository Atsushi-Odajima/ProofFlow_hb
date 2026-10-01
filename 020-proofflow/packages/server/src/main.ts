import { loadConfig } from './config.js';
import { openDb } from './db/db.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';
import { mkdirSync } from 'node:fs';

async function main() {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });
  const db = await openDb({ driver: cfg.dbDriver, url: cfg.databaseUrl, sqlitePath: cfg.sqlitePath });
  const applied = await migrate(db);
  if (applied.length) console.log(`[proofflow] migrations applied: ${applied.join(', ')}`);
  const app = await buildApp({ cfg, db, logger: true });
  await app.listen({ port: cfg.port, host: cfg.host });
  console.log(`[proofflow] control plane listening on http://${cfg.host}:${cfg.port} (db=${db.dialect})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
