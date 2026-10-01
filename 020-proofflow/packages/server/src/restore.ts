#!/usr/bin/env node
/**
 * ProofFlow restore CLI — restores an organization backup (JSON from GET /api/v1/orgs/:id/backup) into an EMPTY environment.
 *   node packages/server/dist/restore.js <backup.json> [--dry-run]
 * Uses the same PROOFFLOW_* environment as the server (DB driver/URL, PROOFFLOW_MASTER_KEY must be the one used when the
 * backup was taken, otherwise stored secrets cannot be decrypted). Artifact binaries are restored separately (BACKUP_RESTORE.md).
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db/db.js';
import { migrate } from './db/migrate.js';
import { AuditService } from './services/audit.js';
import { BackupService } from './services/backup.js';
import { HttpError } from './context.js';

export async function restoreMain(argv: string[], env = process.env): Promise<number> {
  const file = argv.find((a) => !a.startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  if (!file) { console.error('usage: proofflow-restore <backup.json> [--dry-run]'); return 4; }
  const cfg = loadConfig(env);
  const db = await openDb({ driver: cfg.dbDriver, url: cfg.databaseUrl, sqlitePath: cfg.sqlitePath });
  try {
    await migrate(db);
    const svc = new BackupService(db, new AuditService(db));
    const doc = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const res = await svc.restore(doc, { dryRun });
    const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
    console.log(`${dryRun ? '[dry-run] would restore' : 'restored'} organization ${res.organizationId}: ${total} rows across ${Object.keys(res.counts).length} tables`);
    for (const [t, n] of Object.entries(res.counts)) if (n > 0) console.log(`  ${t.padEnd(28)} ${n}`);
    if (!dryRun) console.log('NOTE: artifact binaries are not part of the JSON backup — copy PROOFFLOW_DATA_DIR/artifacts and /fixtures from your storage backup. Secrets decrypt only with the original PROOFFLOW_MASTER_KEY.');
    return 0;
  } catch (e) {
    if (e instanceof HttpError) { console.error(`restore refused: ${e.message}`); return e.status === 409 ? 5 : 1; }
    console.error(e); return 1;
  } finally { await db.close(); }
}

if (process.argv[1] && /restore\.(js|ts)$/.test(process.argv[1])) restoreMain(process.argv.slice(2)).then((c) => process.exit(c));
