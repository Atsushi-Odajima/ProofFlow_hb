/**
 * Backup / Restore of one organization's metadata as a single JSON document.
 *
 * - Scope: everything tenant-scoped (projects, environments, encrypted secrets, requirements, scenarios, suites, run/result/
 *   artifact METADATA, visual baselines, defects, release candidates, gate evaluations, manual checks, schedules, audit log …).
 * - NOT included: artifact binaries (screenshots/video/trace/reports/fixtures) — back up PROOFFLOW_DATA_DIR/{artifacts,fixtures}
 *   with your storage strategy (BACKUP_RESTORE.md); login sessions; global retention jobs.
 * - Integrity: schemaVersion / appVersion / sha256 checksum over the canonical table payload.
 * - Restore is an "empty environment" operation: the organization id/slug and every member e-mail must be absent.
 *   It never merges into an existing tenant and never touches other tenants.
 * - Secrets stay encrypted (AES-256-GCM); they decrypt only with the same PROOFFLOW_MASTER_KEY.
 */
import { createHash } from 'node:crypto';
import type { Db, Param } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { ulid, SCHEMA_VERSION, APP_VERSION } from '@proofflow/shared';
import { badRequest, conflict, notFound, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';

/** Tables in FK-safe insertion order. `by` = ordering columns for deterministic export; `where` = tenant filter. */
const TABLES: Array<{ name: string; by: string[]; where: 'org' | 'org_id_col' | 'users' }> = [
  { name: 'organizations', by: ['id'], where: 'org' },
  { name: 'users', by: ['id'], where: 'users' },
  { name: 'org_members', by: ['org_id', 'user_id'], where: 'org_id_col' },
  { name: 'api_tokens', by: ['id'], where: 'org_id_col' },
  { name: 'invitations', by: ['id'], where: 'org_id_col' },
  { name: 'workspaces', by: ['id'], where: 'org_id_col' },
  { name: 'projects', by: ['id'], where: 'org_id_col' },
  { name: 'environments', by: ['id'], where: 'org_id_col' },
  { name: 'secrets', by: ['id'], where: 'org_id_col' },
  { name: 'domain_verifications', by: ['id'], where: 'org_id_col' },
  { name: 'requirements', by: ['id'], where: 'org_id_col' },
  { name: 'acceptance_criteria', by: ['id'], where: 'org_id_col' },
  { name: 'scenarios', by: ['id'], where: 'org_id_col' },
  { name: 'scenario_versions', by: ['id'], where: 'org_id_col' },
  { name: 'scenario_requirements', by: ['scenario_id', 'requirement_id'], where: 'org_id_col' },
  { name: 'suites', by: ['id'], where: 'org_id_col' },
  { name: 'suite_scenarios', by: ['suite_id', 'scenario_id'], where: 'org_id_col' },
  { name: 'test_data_profiles', by: ['id'], where: 'org_id_col' },
  { name: 'fixtures', by: ['id'], where: 'org_id_col' },
  { name: 'openapi_specs', by: ['id'], where: 'org_id_col' },
  { name: 'crawl_inventory', by: ['id'], where: 'org_id_col' },
  { name: 'runners', by: ['id'], where: 'org_id_col' },
  { name: 'release_candidates', by: ['id'], where: 'org_id_col' },
  { name: 'test_runs', by: ['id'], where: 'org_id_col' },
  { name: 'run_jobs', by: ['id'], where: 'org_id_col' },
  { name: 'test_results', by: ['id'], where: 'org_id_col' },
  { name: 'result_attempts', by: ['id'], where: 'org_id_col' },
  { name: 'artifacts', by: ['id'], where: 'org_id_col' },
  { name: 'visual_baselines', by: ['id'], where: 'org_id_col' },
  { name: 'baseline_history', by: ['id'], where: 'org_id_col' },
  { name: 'visual_comparisons', by: ['id'], where: 'org_id_col' },
  { name: 'performance_baselines', by: ['id'], where: 'org_id_col' },
  { name: 'failure_groups', by: ['id'], where: 'org_id_col' },
  { name: 'defects', by: ['id'], where: 'org_id_col' },
  { name: 'defect_links', by: ['defect_id', 'target_type', 'target_id'], where: 'org_id_col' },
  { name: 'defect_history', by: ['id'], where: 'org_id_col' },
  { name: 'bug_report_intakes', by: ['id'], where: 'org_id_col' },
  { name: 'bug_reports', by: ['id'], where: 'org_id_col' },
  { name: 'bug_report_attachments', by: ['artifact_id'], where: 'org_id_col' },
  { name: 'gate_evaluations', by: ['id'], where: 'org_id_col' },
  { name: 'accepted_risks', by: ['id'], where: 'org_id_col' },
  { name: 'evidence_reports', by: ['id'], where: 'org_id_col' },
  { name: 'manual_cases', by: ['id'], where: 'org_id_col' },
  { name: 'manual_case_requirements', by: ['manual_case_id', 'requirement_id'], where: 'org_id_col' },
  { name: 'manual_check_results', by: ['id'], where: 'org_id_col' },
  { name: 'exploratory_sessions', by: ['id'], where: 'org_id_col' },
  { name: 'schedules', by: ['id'], where: 'org_id_col' },
  { name: 'notification_channels', by: ['id'], where: 'org_id_col' },
  { name: 'notifications', by: ['id'], where: 'org_id_col' },
  { name: 'notification_deliveries', by: ['id'], where: 'org_id_col' },
  { name: 'ai_suggestions', by: ['id'], where: 'org_id_col' },
  { name: 'ai_invocations', by: ['id'], where: 'org_id_col' },
  { name: 'test_impact_rules', by: ['id'], where: 'org_id_col' },
  { name: 'ci_integrations', by: ['id'], where: 'org_id_col' },
  { name: 'audit_logs', by: ['id'], where: 'org_id_col' },
  { name: 'usage_counters', by: ['org_id', 'period', 'metric'], where: 'org_id_col' },
  { name: 'backups', by: ['id'], where: 'org_id_col' },
];
const TABLE_NAMES = new Set(TABLES.map((t) => t.name));
const IDENT = /^[a-z_][a-z0-9_]*$/;
const PAGE = 5000;

export interface BackupDocument {
  format: 'proofflow-backup'; schemaVersion: number; appVersion: string; exportedAt: string;
  organization: { id: string; slug: string; name: string };
  counts: Record<string, number>;
  checksum: string;            // sha256 over canonical JSON of `tables`
  excludes: string[];
  tables: Record<string, Array<Record<string, unknown>>>;
}

export function canonicalTablesJson(tables: Record<string, Array<Record<string, unknown>>>): string {
  // Deterministic: table order as declared, row order as exported, object keys sorted.
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
    return typeof v === 'bigint' ? Number(v) : v;
  };
  const ordered: Record<string, unknown> = {};
  for (const t of TABLES) if (tables[t.name]) ordered[t.name] = sortKeys(tables[t.name]);
  for (const k of Object.keys(tables)) if (!(k in ordered)) ordered[k] = sortKeys(tables[k]);
  return JSON.stringify(ordered);
}
export const checksumOf = (tables: BackupDocument['tables']) => createHash('sha256').update(canonicalTablesJson(tables)).digest('hex');

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v;
  return out;
}

export class BackupService {
  constructor(private db: Db, private audit: AuditService) {}

  async export(ctx: Ctx, orgId: string): Promise<BackupDocument> {
    const org = await this.db.get<{ id: string; slug: string; name: string }>(`SELECT id, slug, name FROM organizations WHERE id = ?`, [orgId]);
    if (!org) throw notFound('organization');
    const tables: BackupDocument['tables'] = {};
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      const rows: Array<Record<string, unknown>> = [];
      if (t.where === 'org') rows.push(...(await this.db.all<Record<string, unknown>>(`SELECT * FROM organizations WHERE id = ?`, [orgId])));
      else if (t.where === 'users') rows.push(...(await this.db.all<Record<string, unknown>>(`SELECT u.* FROM users u JOIN org_members m ON m.user_id = u.id WHERE m.org_id = ? ORDER BY u.id`, [orgId])));
      else if (t.by.length === 1 && t.by[0] === 'id') {
        let cursor = '';
        for (;;) {
          const page = await this.db.all<Record<string, unknown>>(`SELECT * FROM ${t.name} WHERE org_id = ? AND id > ? ORDER BY id LIMIT ${PAGE}`, [orgId, cursor]);
          rows.push(...page);
          if (page.length < PAGE) break;
          cursor = String(page[page.length - 1]!.id);
        }
      } else rows.push(...(await this.db.all<Record<string, unknown>>(`SELECT * FROM ${t.name} WHERE org_id = ? ORDER BY ${t.by.join(', ')}`, [orgId])));
      tables[t.name] = rows.map(normalizeRow);
      counts[t.name] = rows.length;
    }
    const doc: BackupDocument = {
      format: 'proofflow-backup', schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, exportedAt: nowIso(),
      organization: org, counts, checksum: checksumOf(tables),
      excludes: ['artifact binaries (PROOFFLOW_DATA_DIR/artifacts, /fixtures)', 'login sessions', 'global retention jobs'],
      tables,
    };
    const size = Buffer.byteLength(JSON.stringify(doc));
    await this.db.run(`INSERT INTO backups (id, org_id, artifact_id, schema_version, app_version, checksum, size_bytes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)`, [ulid(), orgId, null, SCHEMA_VERSION, APP_VERSION, doc.checksum, size, ctx.actor.id, doc.exportedAt]);
    await this.audit.log({ orgId, actor: ctx.actor, action: 'backup.export', targetType: 'organization', targetId: orgId, after: { checksum: doc.checksum, sizeBytes: size, tables: Object.keys(counts).length }, ip: ctx.ip });
    return doc;
  }

  /** Validate structure + checksum. Throws HttpError(400) on any problem. */
  validate(doc: unknown): BackupDocument {
    const d = doc as Partial<BackupDocument>;
    if (!d || d.format !== 'proofflow-backup') throw badRequest('not a proofflow-backup document');
    if (typeof d.schemaVersion !== 'number' || d.schemaVersion > SCHEMA_VERSION) throw badRequest(`schemaVersion ${d.schemaVersion} is newer than this server (${SCHEMA_VERSION}); upgrade ProofFlow first`);
    if (!d.organization?.id || !d.organization.slug) throw badRequest('organization block missing');
    if (!d.tables || typeof d.tables !== 'object') throw badRequest('tables block missing');
    for (const [name, rows] of Object.entries(d.tables)) {
      if (!TABLE_NAMES.has(name)) throw badRequest(`unknown table in backup: ${name}`);
      if (!Array.isArray(rows)) throw badRequest(`table ${name} is not an array`);
      for (const r of rows) for (const k of Object.keys(r)) if (!IDENT.test(k)) throw badRequest(`invalid column name ${k} in ${name}`);
    }
    if (checksumOf(d.tables) !== d.checksum) throw badRequest('checksum mismatch: the backup file is corrupted or was modified');
    return d as BackupDocument;
  }

  /** Preconditions for an "empty environment" restore: org id/slug and member e-mails must be absent. */
  async preflight(doc: BackupDocument): Promise<{ conflicts: string[] }> {
    const conflicts: string[] = [];
    if (await this.db.get(`SELECT id FROM organizations WHERE id = ? OR slug = ?`, [doc.organization.id, doc.organization.slug])) conflicts.push(`organization ${doc.organization.slug} (${doc.organization.id}) already exists`);
    for (const u of doc.tables.users ?? []) if (await this.db.get(`SELECT id FROM users WHERE id = ? OR email = ?`, [String(u.id), String(u.email)])) conflicts.push(`user ${String(u.email)} already exists`);
    for (const p of doc.tables.projects ?? []) if (await this.db.get(`SELECT id FROM projects WHERE id = ?`, [String(p.id)])) conflicts.push(`project ${String(p.id)} already exists`);
    return { conflicts };
  }

  async restore(doc: unknown, opts: { dryRun?: boolean; actor?: Ctx['actor'] } = {}): Promise<{ counts: Record<string, number>; organizationId: string; dryRun: boolean }> {
    const d = this.validate(doc);
    const { conflicts } = await this.preflight(d);
    if (conflicts.length) throw conflict(`restore target is not empty: ${conflicts.slice(0, 5).join('; ')}${conflicts.length > 5 ? ` (+${conflicts.length - 5} more)` : ''}`);
    const counts: Record<string, number> = {};
    if (opts.dryRun) { for (const t of TABLES) counts[t.name] = d.tables[t.name]?.length ?? 0; return { counts, organizationId: d.organization.id, dryRun: true }; }
    await this.db.tx(async (tx) => {
      for (const t of TABLES) {
        const rows = d.tables[t.name] ?? [];
        for (const row of rows) {
          const cols = Object.keys(row);
          await tx.run(`INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] as Param));
        }
        counts[t.name] = rows.length;
      }
      const now = nowIso();
      await tx.run(`INSERT INTO backups (id, org_id, artifact_id, schema_version, app_version, checksum, size_bytes, created_by, created_at, restored_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [ulid(), d.organization.id, null, d.schemaVersion, d.appVersion, d.checksum, Buffer.byteLength(JSON.stringify(d)), opts.actor?.id ?? null, d.exportedAt, now]);
      await this.audit.log({ orgId: d.organization.id, actor: opts.actor ?? { kind: 'system', id: null, name: 'restore-cli' }, action: 'backup.restore', targetType: 'organization', targetId: d.organization.id, after: { checksum: d.checksum, exportedAt: d.exportedAt, appVersion: d.appVersion, schemaVersion: d.schemaVersion } }, tx);
    });
    return { counts, organizationId: d.organization.id, dryRun: false };
  }
}
