import type { Db } from '../db/db.js';
import { nowIso, asJson, asBool } from '../db/db.js';
import { ulid, DEFECT_TRANSITIONS, type DefectStatus, type Viewport } from '@proofflow/shared';
import { badRequest, conflict, forbidden, notFound, SYSTEM, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { ProjectService, ProjectRow } from './projects.js';
import type { RunService, RunRow, JobCompletion, ResultRow } from './runs.js';
import type { ArtifactService } from './artifacts.js';

export interface DefectRow { id: string; org_id: string; project_id: string; key: string; title: string; severity: string; priority: string; status: DefectStatus; environment_id: string | null; browser: string | null; viewport_json: string | null; first_seen_at: string | null; last_seen_at: string | null; reproduction: string | null; expected: string | null; actual: string | null; evidence_json: string | null; failure_group_id: string | null; assignee_user_id: string | null; fix_version: string | null; resolution: string | null; from_ai_suggestion_id: string | null; created_by: string | null; created_at: string; updated_at: string; closed_at: string | null; }
export interface FailureGroupRow { id: string; org_id: string; project_id: string; fingerprint: string; title: string; failure_type: string; first_seen_at: string; last_seen_at: string; occurrence_count: number; sample_result_id: string | null; defect_id: string | null; }

export const defectView = (d: DefectRow) => ({ id: d.id, projectId: d.project_id, key: d.key, title: d.title, severity: d.severity, priority: d.priority, status: d.status, environmentId: d.environment_id, browser: d.browser, viewport: asJson<Viewport | null>(d.viewport_json, null), firstSeenAt: d.first_seen_at, lastSeenAt: d.last_seen_at, reproduction: d.reproduction, expected: d.expected, actual: d.actual, evidence: asJson<{ artifactIds: string[]; resultIds: string[] }>(d.evidence_json, { artifactIds: [], resultIds: [] }), failureGroupId: d.failure_group_id, assigneeUserId: d.assignee_user_id, fixVersion: d.fix_version, resolution: d.resolution, fromAiSuggestionId: d.from_ai_suggestion_id, createdBy: d.created_by, createdAt: d.created_at, updatedAt: d.updated_at, closedAt: d.closed_at });
export const groupView = (g: FailureGroupRow) => ({ id: g.id, projectId: g.project_id, fingerprint: g.fingerprint, title: g.title, failureType: g.failure_type, firstSeenAt: g.first_seen_at, lastSeenAt: g.last_seen_at, occurrenceCount: g.occurrence_count, sampleResultId: g.sample_result_id, defectId: g.defect_id });

export class DefectService {
  constructor(private db: Db, private audit: AuditService, private projects: ProjectService, private runs: RunService, private artifacts: ArtifactService) {}
  /** Notification hook (Phase 9). */
  notify?: (orgId: string, projectId: string, kind: string, title: string, body: string, link: string, dedupeKey: string) => Promise<void>;

  // ---------- failure groups ----------
  /** Called for every completed result. Groups failures by fingerprint and reopens verified/closed defects on recurrence. */
  async onResult(resultId: string, run: RunRow, c: JobCompletion, fingerprint: string | null) {
    if (c.status !== 'failed' || !fingerprint || !c.failure) return;
    const now = nowIso();
    const title = `${c.failure.type}: ${c.failure.message.slice(0, 120)}`;
    const existing = await this.db.get<FailureGroupRow>(`SELECT * FROM failure_groups WHERE project_id = ? AND fingerprint = ?`, [run.project_id, fingerprint]);
    let groupId: string;
    if (existing) { groupId = existing.id; await this.db.run(`UPDATE failure_groups SET last_seen_at = ?, occurrence_count = occurrence_count + 1, sample_result_id = ? WHERE id = ?`, [now, resultId, existing.id]); }
    else { groupId = ulid(); await this.db.run(`INSERT INTO failure_groups (id, org_id, project_id, fingerprint, title, failure_type, first_seen_at, last_seen_at, occurrence_count, sample_result_id) VALUES (?,?,?,?,?,?,?,?,1,?)`, [groupId, run.org_id, run.project_id, fingerprint, title, c.failure.type, now, now, resultId]); }
    // Recurrence of a fixed defect → Reopened (never silently stays Verified/Closed).
    const defects = await this.db.all<DefectRow>(`SELECT d.* FROM defects d WHERE d.project_id = ? AND (d.failure_group_id = ? OR d.id IN (SELECT defect_id FROM defect_links WHERE target_type = 'failure_group' AND target_id = ?))`, [run.project_id, groupId, groupId]);
    for (const d of defects) {
      await this.db.run(`UPDATE defects SET last_seen_at = ?, updated_at = ? WHERE id = ?`, [now, now, d.id]);
      if ((d.status === 'verified' || d.status === 'closed') && run.kind !== 'retest') {
        await this.transition({ actor: SYSTEM, ip: 'system', requestId: 'system' }, await this.projects.getRow(d.project_id), d, 'reopened', `regression detected in run ${run.id} (result ${resultId})`, run.id, true);
        await this.notify?.(run.org_id, run.project_id, 'defect.reopened', `${d.key} reopened`, `Regression of "${d.title}" detected in run ${run.id}`, `/projects/${run.project_id}/defects/${d.id}`, `defect.reopened:${d.id}:${run.id}`);
      }
    }
  }
  async groups(projectId: string, opts: { withoutDefect?: boolean; limit?: number } = {}) {
    const rows = await this.db.all<FailureGroupRow>(`SELECT * FROM failure_groups WHERE project_id = ? ${opts.withoutDefect ? 'AND defect_id IS NULL' : ''} ORDER BY last_seen_at DESC LIMIT ?`, [projectId, Math.min(opts.limit ?? 100, 500)]);
    return rows.map(groupView);
  }
  async group(projectId: string, id: string) {
    const g = await this.db.get<FailureGroupRow>(`SELECT * FROM failure_groups WHERE id = ? AND project_id = ?`, [id, projectId]);
    if (!g) throw notFound('failure group');
    const results = await this.db.all<ResultRow>(`SELECT * FROM test_results WHERE project_id = ? AND fingerprint = ? ORDER BY id DESC LIMIT 20`, [projectId, g.fingerprint]);
    const { resultView } = await import('./runs.js');
    return { ...groupView(g), recentResults: results.map(resultView) };
  }
  /** Similar-group candidates: same failure type + step type, different fingerprint. Merging is a human decision (AI merge is confirm-only). */
  async similar(projectId: string, id: string) {
    const g = await this.db.get<FailureGroupRow>(`SELECT * FROM failure_groups WHERE id = ? AND project_id = ?`, [id, projectId]);
    if (!g) throw notFound('failure group');
    const sample = g.sample_result_id ? await this.db.get<ResultRow>(`SELECT * FROM test_results WHERE id = ?`, [g.sample_result_id]) : undefined;
    const f = asJson<{ stepType?: string; type: string; url?: string } | null>(sample?.failure_json, null);
    const others = await this.db.all<FailureGroupRow>(`SELECT * FROM failure_groups WHERE project_id = ? AND id <> ? AND failure_type = ? ORDER BY last_seen_at DESC LIMIT 50`, [projectId, g.id, g.failure_type]);
    const out = [] as Array<ReturnType<typeof groupView> & { score: number; reason: string }>;
    for (const o of others) {
      const os = o.sample_result_id ? await this.db.get<ResultRow>(`SELECT * FROM test_results WHERE id = ?`, [o.sample_result_id]) : undefined;
      const of = asJson<{ stepType?: string; type: string; url?: string } | null>(os?.failure_json, null);
      let score = 0.3; const reasons = ['same failure type'];
      if (f?.stepType && of?.stepType === f.stepType) { score += 0.3; reasons.push('same step type'); }
      if (f?.url && of?.url && safePath(f.url) === safePath(of.url)) { score += 0.3; reasons.push('same URL path'); }
      if (sample && os && sample.scenario_id === os.scenario_id) { score += 0.1; reasons.push('same scenario'); }
      if (score >= 0.6) out.push({ ...groupView(o), score: Number(score.toFixed(2)), reason: reasons.join(', ') });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // ---------- defects ----------
  async list(projectId: string, opts: { status?: string; severity?: string; assignee?: string; limit?: number; cursor?: string; q?: string } = {}) {
    const where = ['project_id = ?']; const params: (string | number)[] = [projectId];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.severity) { where.push('severity = ?'); params.push(opts.severity); }
    if (opts.assignee) { where.push('assignee_user_id = ?'); params.push(opts.assignee); }
    if (opts.q) { where.push('(title LIKE ? OR key LIKE ?)'); params.push(`%${opts.q}%`, `%${opts.q}%`); }
    if (opts.cursor) { where.push('id < ?'); params.push(opts.cursor); }
    params.push(Math.min(opts.limit ?? 100, 500));
    return (await this.db.all<DefectRow>(`SELECT * FROM defects WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params)).map(defectView);
  }
  async getRow(id: string, projectId?: string): Promise<DefectRow> {
    const d = await this.db.get<DefectRow>(`SELECT * FROM defects WHERE id = ?`, [id]);
    if (!d || (projectId && d.project_id !== projectId)) throw notFound('defect');
    return d;
  }
  async get(id: string, projectId: string) {
    const d = await this.getRow(id, projectId);
    const links = await this.db.all<{ target_type: string; target_id: string }>(`SELECT target_type, target_id FROM defect_links WHERE defect_id = ? ORDER BY target_type, target_id`, [id]);
    const history = await this.db.all(`SELECT * FROM defect_history WHERE defect_id = ? ORDER BY id`, [id]);
    const ev = asJson<{ artifactIds: string[]; resultIds: string[] }>(d.evidence_json, { artifactIds: [], resultIds: [] });
    const artifacts = [] as unknown[];
    for (const aid of ev.artifactIds.slice(0, 50)) { const a = await this.artifacts.getRow(aid); if (a && !a.deleted_at) { const { artifactView } = await import('./artifacts.js'); artifacts.push(artifactView(a)); } }
    const risks = await this.db.all(`SELECT ar.*, rc.version FROM accepted_risks ar JOIN release_candidates rc ON rc.id = ar.release_candidate_id WHERE ar.defect_id = ? AND ar.revoked_at IS NULL`, [id]);
    return { ...defectView(d), links: links.map((l) => ({ type: l.target_type, id: l.target_id })), history, artifacts, acceptedRisks: risks };
  }
  async create(ctx: Ctx, p: ProjectRow, input: { title: string; severity: string; priority: string; environmentId?: string; browser?: string; viewport?: Viewport; reproduction?: string; expected?: string; actual?: string; resultIds?: string[]; scenarioIds?: string[]; requirementIds?: string[]; artifactIds?: string[]; failureGroupId?: string; assigneeUserId?: string; fixVersion?: string; fromAiSuggestionId?: string }) {
    const id = ulid(); const now = nowIso();
    const key = await this.projects.nextKey(this.db, p.id, 'DEF');
    const evidence = { artifactIds: input.artifactIds ?? [], resultIds: input.resultIds ?? [] };
    for (const rid of evidence.resultIds) { const r = await this.db.get<{ project_id: string }>(`SELECT project_id FROM test_results WHERE id = ?`, [rid]); if (!r || r.project_id !== p.id) throw badRequest(`result ${rid} not in project`); }
    if (input.failureGroupId) { const g = await this.db.get(`SELECT 1 FROM failure_groups WHERE id = ? AND project_id = ?`, [input.failureGroupId, p.id]); if (!g) throw badRequest('failure group not in project'); }
    await this.db.tx(async (tx) => {
      await tx.run(`INSERT INTO defects (id, org_id, project_id, key, title, severity, priority, status, environment_id, browser, viewport_json, first_seen_at, last_seen_at, reproduction, expected, actual, evidence_json, failure_group_id, assignee_user_id, fix_version, from_ai_suggestion_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, p.org_id, p.id, key, input.title, input.severity, input.priority, 'new', input.environmentId ?? null, input.browser ?? null, input.viewport ? JSON.stringify(input.viewport) : null, now, now, input.reproduction ?? null, input.expected ?? null, input.actual ?? null, JSON.stringify(evidence), input.failureGroupId ?? null, input.assigneeUserId ?? null, input.fixVersion ?? null, input.fromAiSuggestionId ?? null, ctx.actor.id, now, now]);
      const links: [string, string][] = [];
      for (const r of evidence.resultIds) links.push(['result', r]);
      for (const s of input.scenarioIds ?? []) links.push(['scenario', s]);
      for (const r of input.requirementIds ?? []) links.push(['requirement', r]);
      if (input.failureGroupId) links.push(['failure_group', input.failureGroupId]);
      for (const [t, tid] of links) await tx.run(`INSERT INTO defect_links (org_id, defect_id, target_type, target_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`, [p.org_id, id, t, tid, now]);
      if (input.failureGroupId) await tx.run(`UPDATE failure_groups SET defect_id = ? WHERE id = ? AND defect_id IS NULL`, [id, input.failureGroupId]);
      await tx.run(`INSERT INTO defect_history (id, org_id, defect_id, from_status, to_status, actor_id, actor_kind, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)`, [ulid(), p.org_id, id, null, 'new', ctx.actor.id, ctx.actor.kind, 'created', now]);
      await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'defect.create', targetType: 'defect', targetId: id, projectId: p.id, after: { key, title: input.title, severity: input.severity, fromAiSuggestionId: input.fromAiSuggestionId ?? null }, ip: ctx.ip }, tx);
    });
    // Defect evidence must outlive default retention.
    if (evidence.artifactIds.length) await this.artifacts.setRetentionClass(evidence.artifactIds, 'release_evidence');
    await this.notify?.(p.org_id, p.id, 'defect.new', `${key} created`, input.title, `/projects/${p.id}/defects/${id}`, `defect.new:${id}`);
    return this.get(id, p.id);
  }
  /** Build a defect from a failed result's evidence (no AI needed). */
  async createFromResult(ctx: Ctx, p: ProjectRow, resultId: string, overrides: Partial<{ title: string; severity: string; priority: string; assigneeUserId: string }> = {}) {
    const r = await this.runs.getResult(resultId, p.id);
    if (r.status !== 'failed' && r.status !== 'flaky') throw badRequest('result is not a failure');
    const run = await this.runs.getRow(r.run_id);
    const f = asJson<{ type: string; message: string; stepIndex?: number; stepType?: string; url?: string; expected?: string; actual?: string } | null>(r.failure_json, null);
    const scenario = await this.db.get<{ key: string; title: string; steps_json: string; expected: string | null }>(`SELECT key, title, steps_json, expected FROM scenarios WHERE id = ?`, [r.scenario_id]);
    const steps = asJson<Array<{ type: string; url?: string; target?: unknown; value?: string; text?: string }>>(scenario?.steps_json, []);
    const repro = steps.slice(0, (f?.stepIndex ?? steps.length - 1) + 1).map((s, i) => `${i + 1}. ${s.type}${s.url ? ` ${s.url}` : ''}${s.target ? ` ${JSON.stringify(s.target)}` : ''}${s.value && !/\{\{secret:/.test(s.value) ? ` "${s.value}"` : ''}${s.text ? ` "${s.text}"` : ''}`).join('\n');
    const arts = await this.artifacts.listForResult(r.id);
    const reqs = await this.db.all<{ requirement_id: string }>(`SELECT requirement_id FROM scenario_requirements WHERE scenario_id = ? ORDER BY requirement_id`, [r.scenario_id]);
    const vp = asJson<Viewport>(r.viewport_json, { width: 0, height: 0 });
    return this.create(ctx, p, {
      title: overrides.title ?? `${scenario?.key ?? ''} ${scenario?.title ?? 'scenario'} fails on ${r.browser} ${vp.name ?? `${vp.width}x${vp.height}`}: ${f?.message.slice(0, 80) ?? 'failure'}`.trim(),
      severity: overrides.severity ?? (f?.type === 'policy' ? 'low' : 'high'), priority: overrides.priority ?? 'p1', environmentId: run.environment_id, browser: `${r.browser}${r.browser_version ? ' ' + r.browser_version : ''}`, viewport: vp,
      reproduction: `Environment: ${run.environment_id}\nBrowser: ${r.browser} ${r.browser_version ?? ''}\nViewport: ${vp.width}x${vp.height}\nRun: ${run.id}\n\nSteps:\n${repro}`,
      expected: f?.expected ?? scenario?.expected ?? (f ? 'step passes' : ''), actual: f?.actual ?? f?.message ?? '', resultIds: [r.id], scenarioIds: [r.scenario_id], requirementIds: reqs.map((x) => x.requirement_id), artifactIds: arts.map((a) => a.id), failureGroupId: r.fingerprint ? (await this.db.get<{ id: string }>(`SELECT id FROM failure_groups WHERE project_id = ? AND fingerprint = ?`, [p.id, r.fingerprint]))?.id : undefined, assigneeUserId: overrides.assigneeUserId,
    });
  }
  async update(ctx: Ctx, p: ProjectRow, d: DefectRow, patch: Record<string, unknown>) {
    const next = { title: (patch.title as string) ?? d.title, severity: (patch.severity as string) ?? d.severity, priority: (patch.priority as string) ?? d.priority, reproduction: (patch.reproduction as string) ?? d.reproduction, expected: (patch.expected as string) ?? d.expected, actual: (patch.actual as string) ?? d.actual, assignee: patch.assigneeUserId !== undefined ? (patch.assigneeUserId as string | null) : d.assignee_user_id, fixVersion: (patch.fixVersion as string) ?? d.fix_version, resolution: (patch.resolution as string) ?? d.resolution };
    await this.db.run(`UPDATE defects SET title = ?, severity = ?, priority = ?, reproduction = ?, expected = ?, actual = ?, assignee_user_id = ?, fix_version = ?, resolution = ?, updated_at = ? WHERE id = ?`, [next.title, next.severity, next.priority, next.reproduction, next.expected, next.actual, next.assignee, next.fixVersion, next.resolution, nowIso(), d.id]);
    if (patch.artifactIds || patch.resultIds) { const ev = asJson<{ artifactIds: string[]; resultIds: string[] }>(d.evidence_json, { artifactIds: [], resultIds: [] }); const merged = { artifactIds: [...new Set([...ev.artifactIds, ...((patch.artifactIds as string[]) ?? [])])], resultIds: [...new Set([...ev.resultIds, ...((patch.resultIds as string[]) ?? [])])] }; await this.db.run(`UPDATE defects SET evidence_json = ? WHERE id = ?`, [JSON.stringify(merged), d.id]); for (const rid of (patch.resultIds as string[]) ?? []) await this.db.run(`INSERT INTO defect_links (org_id, defect_id, target_type, target_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`, [p.org_id, d.id, 'result', rid, nowIso()]); }
    for (const sid of (patch.scenarioIds as string[]) ?? []) await this.db.run(`INSERT INTO defect_links (org_id, defect_id, target_type, target_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`, [p.org_id, d.id, 'scenario', sid, nowIso()]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'defect.update', targetType: 'defect', targetId: d.id, projectId: p.id, before: { severity: d.severity, priority: d.priority, assignee: d.assignee_user_id }, after: { severity: next.severity, priority: next.priority, assignee: next.assignee }, ip: ctx.ip });
    if (patch.status && patch.status !== d.status) await this.transition(ctx, p, await this.getRow(d.id), patch.status as DefectStatus, (patch.note as string) ?? null, null, false);
    return this.get(d.id, p.id);
  }
  async transition(ctx: Ctx, p: ProjectRow, d: DefectRow, to: DefectStatus, note: string | null, runId: string | null, system: boolean) {
    if (to === 'verified' && !system) throw forbidden('Verified is set by a passing retest run, not manually (use retest)');
    const allowed = DEFECT_TRANSITIONS[d.status] ?? [];
    if (!allowed.includes(to)) throw conflict(`cannot move defect from ${d.status} to ${to}`);
    const now = nowIso();
    await this.db.run(`UPDATE defects SET status = ?, updated_at = ?, closed_at = CASE WHEN ? IN ('closed','wont_fix') THEN ? ELSE NULL END WHERE id = ?`, [to, now, to, now, d.id]);
    await this.db.run(`INSERT INTO defect_history (id, org_id, defect_id, from_status, to_status, actor_id, actor_kind, note, run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [ulid(), p.org_id, d.id, d.status, to, ctx.actor.id, ctx.actor.kind, note, runId, now]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: `defect.${to}`, targetType: 'defect', targetId: d.id, projectId: p.id, before: { status: d.status }, after: { status: to, note, runId }, ip: ctx.ip });
    if (to === 'ready_for_retest') await this.notify?.(p.org_id, p.id, 'defect.ready_for_retest', `${d.key} ready for retest`, d.title, `/projects/${p.id}/defects/${d.id}`, `defect.rfr:${d.id}`);
  }
  /** Retest: runs the defect's linked scenarios. The resulting run transitions the defect (verified / reopened) on completion. */
  async retest(ctx: Ctx, p: ProjectRow, d: DefectRow, input: { environmentId?: string; matrix?: Record<string, unknown> }, canRunDestructive: boolean) {
    if (d.status !== 'ready_for_retest' && d.status !== 'reopened' && d.status !== 'in_progress' && d.status !== 'triaged' && d.status !== 'new') throw conflict(`defect in status ${d.status} cannot be retested`);
    const scenarioIds = (await this.db.all<{ target_id: string }>(`SELECT target_id FROM defect_links WHERE defect_id = ? AND target_type = 'scenario' ORDER BY target_id`, [d.id])).map((x) => x.target_id);
    if (scenarioIds.length === 0) throw badRequest('defect has no linked scenarios to retest');
    const envId = input.environmentId ?? d.environment_id ?? p.default_environment_id;
    if (!envId) throw badRequest('environmentId required');
    if (d.status !== 'ready_for_retest') await this.transition(ctx, p, d, 'ready_for_retest', 'retest requested', null, false);
    const { run } = await this.runs.create(ctx, p, { environmentId: envId, scenarioIds, matrix: input.matrix as never, trigger: 'retest', retestDefectId: d.id, kind: 'retest', label: `Retest ${d.key}` }, { canRunDestructive });
    return run;
  }
  /** Run completion hook for retest runs. */
  async onRunCompleted(run: RunRow) {
    if (!run.retest_defect_id) return;
    const d = await this.db.get<DefectRow>(`SELECT * FROM defects WHERE id = ?`, [run.retest_defect_id]);
    if (!d) return;
    const p = await this.projects.getRow(d.project_id);
    const results = await this.db.all<{ status: string }>(`SELECT status FROM test_results WHERE run_id = ?`, [run.id]);
    const sys: Ctx = { actor: SYSTEM, ip: 'system', requestId: 'system' };
    if (results.length && results.every((r) => r.status === 'passed')) { if (d.status === 'ready_for_retest') await this.transition(sys, p, d, 'verified', `retest run ${run.id} passed (${results.length} result(s))`, run.id, true); }
    else if (results.some((r) => r.status === 'failed')) { if (d.status === 'ready_for_retest') await this.transition(sys, p, d, 'reopened', `retest run ${run.id} failed`, run.id, true); }
    // infra errors / flaky leave the status untouched; a human decides.
  }
  /** Flaky candidates from recent results: passed_after_retry, or alternating outcomes for the same scenario/browser. */
  async flakyCandidates(projectId: string, limit = 50) {
    const rows = await this.db.all<{ scenario_id: string; browser: string; status: string; outcome_detail: string; duration_ms: number | null; fingerprint: string | null; id: string }>(`SELECT id, scenario_id, browser, status, outcome_detail, duration_ms, fingerprint FROM test_results WHERE project_id = ? AND status IN ('passed','failed','flaky') ORDER BY id DESC LIMIT 2000`, [projectId]);
    const by = new Map<string, typeof rows>();
    for (const r of rows) { const k = `${r.scenario_id}|${r.browser}`; const arr = by.get(k) ?? []; if (arr.length < 20) arr.push(r); by.set(k, arr); }
    const out = [] as Array<{ scenarioId: string; browser: string; sample: number; passedAfterRetry: number; transitions: number; failRate: number; signatures: string[]; avgDurationMs: number | null; score: number }>;
    for (const [k, arr] of by) {
      const [scenarioId, browser] = k.split('|') as [string, string];
      const par = arr.filter((r) => r.outcome_detail === 'passed_after_retry').length;
      let transitions = 0; for (let i = 1; i < arr.length; i++) if ((arr[i]!.status === 'failed') !== (arr[i - 1]!.status === 'failed')) transitions++;
      const fails = arr.filter((r) => r.status === 'failed').length;
      const sigs = [...new Set(arr.map((r) => r.fingerprint).filter(Boolean))] as string[];
      const durs = arr.map((r) => r.duration_ms).filter((d): d is number => d != null);
      const score = par * 2 + (transitions >= 2 ? transitions : 0);
      if (score > 0) out.push({ scenarioId, browser, sample: arr.length, passedAfterRetry: par, transitions, failRate: Number((fails / arr.length).toFixed(2)), signatures: sigs.slice(0, 5), avgDurationMs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  parse = asJson; bool = asBool;
}
function safePath(u: string): string { try { return new URL(u).pathname.replace(/\d+/g, '{n}'); } catch { return u; } }
