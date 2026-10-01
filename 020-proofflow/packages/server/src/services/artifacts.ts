import type { Db } from '../db/db.js';
import { nowIso, asBool } from '../db/db.js';
import { ulid, type ArtifactKind, type RetentionClass } from '@proofflow/shared';
import type { Config } from '../config.js';
import { hmac, safeEqual } from '../crypto.js';
import { HttpError, notFound, type Actor } from '../context.js';
import type { ArtifactStore } from '../storage/store.js';
import type { Readable } from 'node:stream';
import type { AuditService } from './audit.js';

export interface ArtifactRow { id: string; org_id: string; project_id: string; run_id: string | null; result_id: string | null; attempt: number | null; kind: ArtifactKind; label: string | null; step_index: number | null; storage_key: string; content_type: string; size_bytes: number; sha256: string | null; restricted: number; retention_class: RetentionClass; expires_at: string | null; created_by: string | null; created_at: string; deleted_at: string | null; }

export function artifactView(a: ArtifactRow) {
  return { id: a.id, projectId: a.project_id, runId: a.run_id, resultId: a.result_id, attempt: a.attempt, kind: a.kind, label: a.label, stepIndex: a.step_index, contentType: a.content_type, sizeBytes: Number(a.size_bytes), sha256: a.sha256, restricted: asBool(a.restricted), retentionClass: a.retention_class, expiresAt: a.expires_at, createdAt: a.created_at, deletedAt: a.deleted_at };
}

const SAFE_CT = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(;.*)?$/i;

export class ArtifactService {
  constructor(private db: Db, private cfg: Config, private store: ArtifactStore, private audit: AuditService) {}

  retentionExpiry(cls: RetentionClass, from = Date.now()): string | null {
    const days = cls === 'passed' ? this.cfg.retention.passedDays : cls === 'failed' ? this.cfg.retention.failedDays : cls === 'release_evidence' ? this.cfg.retention.releaseDays : cls === 'manual' ? this.cfg.retention.manualDays : null;
    return days == null ? null : new Date(from + days * 86400_000).toISOString();
  }

  async create(input: { orgId: string; projectId: string; runId?: string | null; resultId?: string | null; attempt?: number | null; kind: ArtifactKind; label?: string | null; stepIndex?: number | null; contentType: string; body: Readable | Buffer; retentionClass: RetentionClass; restricted?: boolean; createdBy?: string | null; maxBytes?: number }) {
    if (!SAFE_CT.test(input.contentType)) throw new HttpError(400, 'bad_request', 'invalid content type');
    const id = ulid();
    const key = `${input.orgId}/${input.projectId}/${input.runId ?? 'misc'}/${id}`;
    const put = await this.store.put(key, input.body, input.maxBytes ?? this.cfg.maxArtifactBytes);
    await this.db.run(`INSERT INTO artifacts (id, org_id, project_id, run_id, result_id, attempt, kind, label, step_index, storage_key, content_type, size_bytes, sha256, restricted, retention_class, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, input.orgId, input.projectId, input.runId ?? null, input.resultId ?? null, input.attempt ?? null, input.kind, input.label ?? null, input.stepIndex ?? null, key, input.contentType, put.sizeBytes, put.sha256, input.restricted ? 1 : 0, input.retentionClass, this.retentionExpiry(input.retentionClass), input.createdBy ?? null, nowIso()]);
    await this.db.run(`INSERT INTO usage_counters (org_id, period, metric, value) VALUES (?,?,?,?) ON CONFLICT (org_id, period, metric) DO UPDATE SET value = usage_counters.value + ?`, [input.orgId, nowIso().slice(0, 7), 'artifact_bytes', put.sizeBytes, put.sizeBytes]);
    return artifactView((await this.getRow(id))!);
  }
  async getRow(id: string): Promise<ArtifactRow | undefined> { return this.db.get<ArtifactRow>(`SELECT * FROM artifacts WHERE id = ?`, [id]); }
  async listForRun(runId: string) { return (await this.db.all<ArtifactRow>(`SELECT * FROM artifacts WHERE run_id = ? AND deleted_at IS NULL ORDER BY id`, [runId])).map(artifactView); }
  async listForResult(resultId: string) { return (await this.db.all<ArtifactRow>(`SELECT * FROM artifacts WHERE result_id = ? AND deleted_at IS NULL ORDER BY id`, [resultId])).map(artifactView); }

  /** Signed URL: time-limited, HMAC-bound to artifact id. Used for runner downloads, report embedding and UI previews. */
  signedPath(id: string, ttlSec = this.cfg.artifactUrlTtlSec): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `/artifacts/${id}?exp=${exp}&sig=${hmac(this.cfg.signingSecret, `${id}|${exp}`)}`;
  }
  signedUrl(id: string, ttlSec?: number): string { return `${this.cfg.publicUrl}${this.signedPath(id, ttlSec)}`; }
  verifySignature(id: string, exp: string | undefined, sig: string | undefined): boolean {
    if (!exp || !sig) return false;
    if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
    return safeEqual(sig, hmac(this.cfg.signingSecret, `${id}|${exp}`));
  }
  async open(id: string): Promise<{ row: ArtifactRow; stream: Readable }> {
    const row = await this.getRow(id);
    if (!row || row.deleted_at || (row.expires_at && row.expires_at < nowIso()) || !this.store.exists(row.storage_key)) throw notFound('artifact');
    return { row, stream: this.store.getStream(row.storage_key) };
  }
  async setRetentionClass(ids: string[], cls: RetentionClass) {
    for (const id of ids) await this.db.run(`UPDATE artifacts SET retention_class = ?, expires_at = ? WHERE id = ? AND deleted_at IS NULL`, [cls, this.retentionExpiry(cls), id]);
  }
  async setRestricted(actor: Actor, orgId: string, id: string, restricted: boolean, ip: string) {
    const r = await this.db.run(`UPDATE artifacts SET restricted = ? WHERE id = ? AND org_id = ?`, [restricted ? 1 : 0, id, orgId]);
    if (!r.changes) throw notFound('artifact');
    await this.audit.log({ orgId, actor, action: 'artifact.restrict', targetType: 'artifact', targetId: id, after: { restricted }, ip });
  }
  /** Retention job: delete expired artifacts (metadata soft-delete + storage delete). Batched for large tables. */
  async runRetention(orgId?: string, batch = 500): Promise<{ deleted: number; freedBytes: number }> {
    const jobId = ulid(); const started = nowIso();
    await this.db.run(`INSERT INTO retention_jobs (id, org_id, started_at, status) VALUES (?,?,?,?)`, [jobId, orgId ?? null, started, 'running']);
    let deleted = 0; let freed = 0;
    try {
      for (;;) {
        const rows = orgId ? await this.db.all<ArtifactRow>(`SELECT * FROM artifacts WHERE org_id = ? AND deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < ? LIMIT ?`, [orgId, started, batch]) : await this.db.all<ArtifactRow>(`SELECT * FROM artifacts WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < ? LIMIT ?`, [started, batch]);
        if (rows.length === 0) break;
        for (const r of rows) { await this.store.delete(r.storage_key); await this.db.run(`UPDATE artifacts SET deleted_at = ? WHERE id = ?`, [nowIso(), r.id]); deleted++; freed += Number(r.size_bytes); }
        if (rows.length < batch) break;
      }
      await this.db.run(`UPDATE retention_jobs SET completed_at = ?, deleted_count = ?, freed_bytes = ?, status = 'done' WHERE id = ?`, [nowIso(), deleted, freed, jobId]);
    } catch (e) { await this.db.run(`UPDATE retention_jobs SET completed_at = ?, deleted_count = ?, freed_bytes = ?, status = 'error', error = ? WHERE id = ?`, [nowIso(), deleted, freed, String(e).slice(0, 500), jobId]); throw e; }
    return { deleted, freedBytes: freed };
  }
  async storageUsage(orgId: string) {
    const rows = await this.db.all<{ kind: string; retention_class: string; c: number; bytes: number }>(`SELECT kind, retention_class, COUNT(*) AS c, COALESCE(SUM(size_bytes),0) AS bytes FROM artifacts WHERE org_id = ? AND deleted_at IS NULL GROUP BY kind, retention_class`, [orgId]);
    return rows.map((r) => ({ kind: r.kind, retentionClass: r.retention_class, count: Number(r.c), bytes: Number(r.bytes) }));
  }
}
