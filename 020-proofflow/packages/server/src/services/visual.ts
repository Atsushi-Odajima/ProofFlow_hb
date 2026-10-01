import type { Db } from '../db/db.js';
import { nowIso, asJson } from '../db/db.js';
import { ulid, type Viewport } from '@proofflow/shared';
import { badRequest, notFound, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { ArtifactService } from './artifacts.js';
import type { ProjectRow } from './projects.js';
import type { RunRow, JobCompletion } from './runs.js';
import { viewportKey } from './runs.js';

export interface VisualComparisonRow { id: string; org_id: string; project_id: string; run_id: string; result_id: string; scenario_id: string; step_key: string; browser: string; viewport_key: string; baseline_artifact_id: string | null; current_artifact_id: string; diff_artifact_id: string | null; diff_pixels: number | null; diff_ratio: number | null; threshold: number | null; status: string; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; created_at: string; }
export const comparisonView = (c: VisualComparisonRow) => ({ id: c.id, projectId: c.project_id, runId: c.run_id, resultId: c.result_id, scenarioId: c.scenario_id, stepKey: c.step_key, browser: c.browser, viewportKey: c.viewport_key, baselineArtifactId: c.baseline_artifact_id, currentArtifactId: c.current_artifact_id, diffArtifactId: c.diff_artifact_id, diffPixels: c.diff_pixels, diffRatio: c.diff_ratio, threshold: c.threshold, status: c.status, reviewedBy: c.reviewed_by, reviewedAt: c.reviewed_at, reviewNote: c.review_note, createdAt: c.created_at });

/**
 * Visual regression governance. Comparisons are produced by the runner (pixelmatch) and persisted here.
 * Baseline changes are human, permissioned (baseline:update), reasoned and historized. There is no automatic/AI approval path.
 */
export class VisualService {
  constructor(private db: Db, private audit: AuditService, private artifacts: ArtifactService) {}

  /** Called from the run completion hook: persist runner visual checks as comparison rows. */
  async ingest(run: RunRow, resultId: string, c: JobCompletion, browser: string, viewport: Viewport, scenarioId: string) {
    const checks = (c.checks as { visual?: Array<{ stepKey: string; status: string; diffPixels?: number; diffRatio?: number; baselineArtifactId?: string; currentLabel: string; diffLabel?: string; threshold?: number }> } | null)?.visual ?? [];
    if (!checks.length) return;
    const arts = await this.artifacts.listForResult(resultId);
    for (const v of checks) {
      const current = arts.find((a) => a.kind === 'screenshot' && a.label === v.currentLabel);
      if (!current) continue;
      const diff = v.diffLabel ? arts.find((a) => a.kind === 'diff' && a.label === v.diffLabel) : undefined;
      const status = v.status === 'new_baseline_needed' ? 'new_baseline_needed' : v.status === 'match' ? 'match' : 'diff';
      await this.db.run(`INSERT INTO visual_comparisons (id, org_id, project_id, run_id, result_id, scenario_id, step_key, browser, viewport_key, baseline_artifact_id, current_artifact_id, diff_artifact_id, diff_pixels, diff_ratio, threshold, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ulid(), run.org_id, run.project_id, run.id, resultId, scenarioId, v.stepKey, browser, viewportKey(viewport), v.baselineArtifactId ?? null, current.id, diff?.id ?? null, v.diffPixels ?? null, v.diffRatio ?? null, v.threshold ?? null, status, nowIso()]);
      // Screenshots that participate in visual review must outlive the default retention.
      await this.artifacts.setRetentionClass([current.id, ...(diff ? [diff.id] : [])], 'release_evidence');
    }
  }
  async list(projectId: string, opts: { status?: string; runId?: string; scenarioId?: string; limit?: number } = {}) {
    const where = ['project_id = ?']; const params: (string | number)[] = [projectId];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.runId) { where.push('run_id = ?'); params.push(opts.runId); }
    if (opts.scenarioId) { where.push('scenario_id = ?'); params.push(opts.scenarioId); }
    params.push(Math.min(opts.limit ?? 100, 500));
    return (await this.db.all<VisualComparisonRow>(`SELECT * FROM visual_comparisons WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params)).map(comparisonView);
  }
  async getRow(id: string, projectId: string): Promise<VisualComparisonRow> {
    const c = await this.db.get<VisualComparisonRow>(`SELECT * FROM visual_comparisons WHERE id = ? AND project_id = ?`, [id, projectId]);
    if (!c) throw notFound('visual comparison');
    return c;
  }
  async baselines(projectId: string, scenarioId?: string) {
    const rows = scenarioId ? await this.db.all(`SELECT * FROM visual_baselines WHERE project_id = ? AND scenario_id = ? AND status = 'active' ORDER BY step_key, browser, viewport_key`, [projectId, scenarioId]) : await this.db.all(`SELECT * FROM visual_baselines WHERE project_id = ? AND status = 'active' ORDER BY scenario_id, step_key, browser, viewport_key`, [projectId]);
    return rows;
  }
  async history(projectId: string, kind?: string, limit = 100) {
    return kind ? this.db.all(`SELECT * FROM baseline_history WHERE project_id = ? AND kind = ? ORDER BY id DESC LIMIT ?`, [projectId, kind, limit]) : this.db.all(`SELECT * FROM baseline_history WHERE project_id = ? ORDER BY id DESC LIMIT ?`, [projectId, limit]);
  }
  /**
   * Approve the current screenshot of a comparison as the new baseline (or the first baseline).
   * Requires baseline:update (enforced by the route). `reason` is mandatory; bulk approvals (>10) need `confirmBulk`.
   */
  async approve(ctx: Ctx, p: ProjectRow, ids: string[], reason: string, opts: { confirmBulk?: boolean; releaseCandidateId?: string } = {}) {
    if (!reason || reason.trim().length < 3) throw badRequest('a reason is required for baseline updates');
    if (ids.length > 10 && !opts.confirmBulk) throw badRequest(`bulk baseline update (${ids.length}) requires confirmBulk=true`, { code: 'bulk_confirmation_required' });
    const approved: string[] = [];
    for (const id of ids) {
      const c = await this.getRow(id, p.id);
      const now = nowIso();
      await this.db.tx(async (tx) => {
        const prev = await tx.get<{ id: string; artifact_id: string }>(`SELECT id, artifact_id FROM visual_baselines WHERE project_id = ? AND scenario_id = ? AND step_key = ? AND browser = ? AND viewport_key = ? AND status = 'active'`, [p.id, c.scenario_id, c.step_key, c.browser, c.viewport_key]);
        if (prev) await tx.run(`UPDATE visual_baselines SET status = 'superseded' WHERE id = ?`, [prev.id]);
        const bid = ulid();
        await tx.run(`INSERT INTO visual_baselines (id, org_id, project_id, scenario_id, step_key, browser, viewport_key, artifact_id, status, approved_by, approved_at, reason, source_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [bid, p.org_id, p.id, c.scenario_id, c.step_key, c.browser, c.viewport_key, c.current_artifact_id, 'active', ctx.actor.id, now, reason, c.run_id, now]);
        await tx.run(`INSERT INTO baseline_history (id, org_id, project_id, kind, baseline_id, action, actor_id, actor_kind, reason, from_ref, to_ref, run_id, release_candidate_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [ulid(), p.org_id, p.id, 'visual', bid, prev ? 'update' : 'create', ctx.actor.id, ctx.actor.kind, reason, prev?.artifact_id ?? null, c.current_artifact_id, c.run_id, opts.releaseCandidateId ?? null, now]);
        await tx.run(`UPDATE visual_comparisons SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`, [ctx.actor.id, now, reason, c.id]);
        await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: prev ? 'baseline.visual.update' : 'baseline.visual.create', targetType: 'visual_baseline', targetId: bid, projectId: p.id, before: { artifactId: prev?.artifact_id ?? null }, after: { artifactId: c.current_artifact_id, stepKey: c.step_key, browser: c.browser, viewportKey: c.viewport_key, reason, runId: c.run_id }, ip: ctx.ip }, tx);
      });
      await this.artifacts.setRetentionClass([c.current_artifact_id], 'baseline');
      approved.push(c.id);
    }
    return { approved };
  }
  async reject(ctx: Ctx, p: ProjectRow, id: string, note: string) {
    const c = await this.getRow(id, p.id);
    await this.db.run(`UPDATE visual_comparisons SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`, [ctx.actor.id, nowIso(), note, c.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'visual.reject', targetType: 'visual_comparison', targetId: c.id, projectId: p.id, after: { note }, ip: ctx.ip });
  }
  /** Gate input: are there unreviewed visual diffs for a project (optionally restricted to runs of an RC)? */
  async pendingCount(projectId: string, runIds?: string[]) {
    if (runIds && runIds.length === 0) return 0;
    const extra = runIds ? ` AND run_id IN (${runIds.map(() => '?').join(',')})` : '';
    const r = await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM visual_comparisons WHERE project_id = ? AND status IN ('diff','new_baseline_needed')${extra}`, [projectId, ...(runIds ?? [])]);
    return Number(r?.c ?? 0);
  }
  parse = asJson;
}
