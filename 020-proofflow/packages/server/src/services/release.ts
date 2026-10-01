import type { Db } from '../db/db.js';
import { nowIso, asJson, asBool } from '../db/db.js';
import { ulid, GateRuleSchema, APP_VERSION, type GateResult } from '@proofflow/shared';
import type { z } from 'zod';
import { badRequest, conflict, forbidden, notFound, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { ProjectService, ProjectRow } from './projects.js';
import type { ArtifactService } from './artifacts.js';
import type { VisualService } from './visual.js';
import { sha256 } from '../crypto.js';

type GateRule = z.infer<typeof GateRuleSchema>;
export interface RCRow { id: string; org_id: string; project_id: string; version: string; commit_sha: string | null; build_id: string | null; environment_id: string; included_changes: string | null; required_suite_ids_json: string | null; required_manual_checks_json: string | null; gate_rules_json: string | null; status: string; last_gate_result: string | null; created_by: string | null; created_at: string; updated_at: string; evaluated_at: string | null; released_at: string | null; released_by: string | null; }
export interface RuleOutcome { rule: GateRule; pass: boolean; message: string; evidence: Record<string, unknown>; coveredByAcceptedRisk?: boolean; }

export const rcView = (r: RCRow) => ({ id: r.id, projectId: r.project_id, version: r.version, commitSha: r.commit_sha, buildId: r.build_id, environmentId: r.environment_id, includedChanges: r.included_changes, requiredSuiteIds: asJson<string[]>(r.required_suite_ids_json, []), requiredManualChecks: asJson<string[]>(r.required_manual_checks_json, []), gateRules: asJson<GateRule[]>(r.gate_rules_json, []), status: r.status, lastGateResult: r.last_gate_result, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, evaluatedAt: r.evaluated_at, releasedAt: r.released_at, releasedBy: r.released_by });
const OPEN_DEFECT_STATUSES = ['new', 'triaged', 'in_progress', 'ready_for_retest', 'reopened'];

/** Release Candidate / Gate / Accepted Risk / Evidence Report. Gate evaluation is deterministic over stored results; AI is never an input or an approver. */
/** Latest completed run per suite (runs are ordered newest first) plus every ad-hoc run without a suite. */
function latestRunsPerSuite<T extends { id: string; suite_id: string | null; completed_at: string | null }>(runs: T[]): T[] {
  const seen = new Set<string>(); const out: T[] = [];
  for (const r of runs) { if (!r.completed_at) continue; if (!r.suite_id) { out.push(r); continue; } if (seen.has(r.suite_id)) continue; seen.add(r.suite_id); out.push(r); }
  return out;
}

export class ReleaseService {
  constructor(private db: Db, private audit: AuditService, private projects: ProjectService, private artifacts: ArtifactService, private visual: VisualService) {}
  notify?: (orgId: string, projectId: string, kind: string, title: string, body: string, link: string, dedupeKey: string) => Promise<void>;

  defaultRules(requiredSuiteIds: string[], manualChecks: string[]): GateRule[] {
    return [
      ...requiredSuiteIds.map((suiteId) => ({ type: 'suite_pass_rate', suiteId, minRate: 1, treatFlakyAsFail: true }) as GateRule),
      { type: 'open_defects_max', severity: 'critical', max: 0, allowAcceptedRisk: false },
      { type: 'open_defects_max', severity: 'high', max: 0, allowAcceptedRisk: true },
      { type: 'visual_approved' },
      ...manualChecks.map((label) => ({ type: 'manual_check_required', label }) as GateRule),
      { type: 'accessibility_max', impact: 'critical', max: 0 },
      { type: 'no_infra_errors' },
    ];
  }
  async list(projectId: string) { return (await this.db.all<RCRow>(`SELECT * FROM release_candidates WHERE project_id = ? ORDER BY id DESC LIMIT 200`, [projectId])).map(rcView); }
  async getRow(id: string, projectId?: string): Promise<RCRow> {
    const r = await this.db.get<RCRow>(`SELECT * FROM release_candidates WHERE id = ?`, [id]);
    if (!r || (projectId && r.project_id !== projectId)) throw notFound('release candidate');
    return r;
  }
  async create(ctx: Ctx, p: ProjectRow, input: { version: string; commitSha?: string; buildId?: string; environmentId: string; includedChanges?: string; requiredSuiteIds?: string[]; gateRules?: GateRule[]; requiredManualChecks?: string[] }) {
    await this.projects.getEnvironmentRow(input.environmentId, p.id);
    if (await this.db.get(`SELECT 1 FROM release_candidates WHERE project_id = ? AND version = ?`, [p.id, input.version])) throw conflict('version already exists');
    let required = input.requiredSuiteIds ?? [];
    if (required.length === 0) required = (await this.db.all<{ id: string }>(`SELECT id FROM suites WHERE project_id = ? AND required_for_release = 1`, [p.id])).map((s) => s.id);
    for (const sid of required) if (!(await this.db.get(`SELECT 1 FROM suites WHERE id = ? AND project_id = ?`, [sid, p.id]))) throw badRequest(`suite ${sid} not in project`);
    const manual = input.requiredManualChecks ?? [];
    const rules = input.gateRules ?? this.defaultRules(required, manual);
    const id = ulid(); const now = nowIso();
    await this.db.run(`INSERT INTO release_candidates (id, org_id, project_id, version, commit_sha, build_id, environment_id, included_changes, required_suite_ids_json, required_manual_checks_json, gate_rules_json, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, input.version, input.commitSha ?? null, input.buildId ?? null, input.environmentId, input.includedChanges ?? null, JSON.stringify(required), JSON.stringify(manual), JSON.stringify(rules), 'draft', ctx.actor.id, now, now]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'release.create', targetType: 'release_candidate', targetId: id, projectId: p.id, after: { version: input.version, commitSha: input.commitSha ?? null, requiredSuites: required.length, rules: rules.length }, ip: ctx.ip });
    return rcView(await this.getRow(id));
  }
  async update(ctx: Ctx, p: ProjectRow, rc: RCRow, patch: Partial<{ commitSha: string; buildId: string; includedChanges: string; requiredSuiteIds: string[]; gateRules: GateRule[]; requiredManualChecks: string[] }>) {
    if (rc.status === 'released') throw conflict('released candidates are immutable');
    const before = rcView(rc);
    const rules = patch.gateRules ?? (patch.requiredSuiteIds || patch.requiredManualChecks ? this.defaultRules(patch.requiredSuiteIds ?? before.requiredSuiteIds, patch.requiredManualChecks ?? before.requiredManualChecks) : before.gateRules);
    await this.db.run(`UPDATE release_candidates SET commit_sha = ?, build_id = ?, included_changes = ?, required_suite_ids_json = ?, required_manual_checks_json = ?, gate_rules_json = ?, updated_at = ? WHERE id = ?`, [patch.commitSha ?? rc.commit_sha, patch.buildId ?? rc.build_id, patch.includedChanges ?? rc.included_changes, JSON.stringify(patch.requiredSuiteIds ?? before.requiredSuiteIds), JSON.stringify(patch.requiredManualChecks ?? before.requiredManualChecks), JSON.stringify(rules), nowIso(), rc.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'release.gate_rules_update', targetType: 'release_candidate', targetId: rc.id, projectId: p.id, before: { rules: before.gateRules, requiredSuiteIds: before.requiredSuiteIds }, after: { rules, requiredSuiteIds: patch.requiredSuiteIds ?? before.requiredSuiteIds }, ip: ctx.ip });
    return rcView(await this.getRow(rc.id));
  }
  async runsOf(rcId: string) { return this.db.all<{ id: string; suite_id: string | null; status: string; counts_json: string | null; completed_at: string | null; browser_versions_json: string | null; created_at: string }>(`SELECT id, suite_id, status, counts_json, completed_at, browser_versions_json, created_at FROM test_runs WHERE release_candidate_id = ? ORDER BY id DESC`, [rcId]); }

  // ---------- gate ----------
  async evaluate(ctx: Ctx, p: ProjectRow, rc: RCRow): Promise<{ result: GateResult; rules: RuleOutcome[]; evaluationId: string; summary: Record<string, unknown> }> {
    const rules = asJson<GateRule[]>(rc.gate_rules_json, []);
    const runs = await this.runsOf(rc.id);
    const runIds = runs.map((r) => r.id);
    const risks = await this.db.all<{ defect_id: string; reason: string; approver_user_id: string }>(`SELECT defect_id, reason, approver_user_id FROM accepted_risks WHERE release_candidate_id = ? AND revoked_at IS NULL`, [rc.id]);
    const riskIds = new Set(risks.map((r) => r.defect_id));
    const outcomes: RuleOutcome[] = [];
    for (const rule of rules) outcomes.push(await this.evalRule(p, rc, rule, runs, runIds, riskIds));
    const failing = outcomes.filter((o) => !o.pass);
    const usedRisk = outcomes.some((o) => o.coveredByAcceptedRisk);
    const result: GateResult = failing.length ? 'BLOCKED' : usedRisk ? 'READY_WITH_ACCEPTED_RISK' : 'READY';
    const id = ulid(); const now = nowIso();
    const summary = { runs: runs.length, failingRules: failing.length, acceptedRisks: risks.length, evaluatedBy: ctx.actor.name, evaluatedAt: now };
    await this.db.run(`INSERT INTO gate_evaluations (id, org_id, release_candidate_id, result, rules_json, summary_json, evaluated_by, evaluated_by_kind, created_at) VALUES (?,?,?,?,?,?,?,?,?)`, [id, p.org_id, rc.id, result, JSON.stringify(outcomes), JSON.stringify(summary), ctx.actor.id, ctx.actor.kind, now]);
    const status = rc.status === 'released' ? 'released' : result === 'BLOCKED' ? 'blocked' : result === 'READY' ? 'ready' : 'ready_with_accepted_risk';
    await this.db.run(`UPDATE release_candidates SET status = ?, last_gate_result = ?, evaluated_at = ?, updated_at = ? WHERE id = ?`, [status, result, now, now, rc.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'release.gate_evaluate', targetType: 'release_candidate', targetId: rc.id, projectId: p.id, after: { result, failingRules: failing.map((f) => f.message) }, ip: ctx.ip });
    if (result === 'BLOCKED') await this.notify?.(p.org_id, p.id, 'gate.blocked', `Release ${rc.version} BLOCKED`, failing.map((f) => f.message).join('; ').slice(0, 500), `/projects/${p.id}/releases/${rc.id}`, `gate.blocked:${rc.id}:${failing.map((f) => f.rule.type).join(',')}`);
    return { result, rules: outcomes, evaluationId: id, summary };
  }
  private async evalRule(p: ProjectRow, rc: RCRow, rule: GateRule, runs: Awaited<ReturnType<ReleaseService['runsOf']>>, runIds: string[], riskIds: Set<string>): Promise<RuleOutcome> {
    switch (rule.type) {
      case 'suite_pass_rate': {
        const suite = await this.db.get<{ name: string }>(`SELECT name FROM suites WHERE id = ?`, [rule.suiteId]);
        const run = runs.find((r) => r.suite_id === rule.suiteId && r.completed_at);
        if (!run) return { rule, pass: false, message: `suite "${suite?.name ?? rule.suiteId}" has no completed run for this release candidate`, evidence: { suiteId: rule.suiteId } };
        const res = await this.db.all<{ status: string; outcome_detail: string }>(`SELECT status, outcome_detail FROM test_results WHERE run_id = ?`, [run.id]);
        const total = res.length; const passed = res.filter((r) => r.status === 'passed' || (!rule.treatFlakyAsFail && r.status === 'flaky')).length;
        const rate = total ? passed / total : 0;
        const pass = total > 0 && rate >= rule.minRate;
        return { rule, pass, message: `suite "${suite?.name ?? rule.suiteId}" pass rate ${(rate * 100).toFixed(1)}% (${passed}/${total}), required ${(rule.minRate * 100).toFixed(0)}%${pass ? '' : ' — BLOCKING'}`, evidence: { runId: run.id, runStatus: run.status, total, passed, flaky: res.filter((r) => r.status === 'flaky').length, failed: res.filter((r) => r.status === 'failed').length, infraError: res.filter((r) => r.status === 'infra_error').length } };
      }
      case 'open_defects_max': {
        const open = await this.db.all<{ id: string; key: string; title: string; status: string }>(`SELECT id, key, title, status FROM defects WHERE project_id = ? AND severity = ? AND status IN (${OPEN_DEFECT_STATUSES.map(() => '?').join(',')})`, [p.id, rule.severity, ...OPEN_DEFECT_STATUSES]);
        const notAccepted = rule.allowAcceptedRisk ? open.filter((d) => !riskIds.has(d.id)) : open;
        const pass = notAccepted.length <= rule.max;
        const covered = rule.allowAcceptedRisk && open.length > notAccepted.length;
        return { rule, pass, message: `${rule.severity} open defects: ${notAccepted.length}${covered ? ` (+${open.length - notAccepted.length} accepted as risk)` : ''}, max ${rule.max}${pass ? '' : ' — BLOCKING'}`, evidence: { defects: open.map((d) => ({ key: d.key, title: d.title, status: d.status, acceptedRisk: riskIds.has(d.id) })) }, coveredByAcceptedRisk: covered && pass };
      }
      case 'visual_approved': {
        const pending = await this.visual.list(p.id, { limit: 500 });
        const rel = pending.filter((c) => runIds.includes(c.runId) && (c.status === 'diff' || c.status === 'new_baseline_needed'));
        return { rule, pass: rel.length === 0, message: rel.length ? `${rel.length} visual change(s) awaiting review — BLOCKING` : 'all visual comparisons reviewed', evidence: { pendingComparisonIds: rel.map((c) => c.id) } };
      }
      case 'manual_check_required': {
        const checks = await this.db.all<{ id: string; result: string; device: string; tester_user_id: string; performed_at: string; label: string | null }>(`SELECT id, result, device, tester_user_id, performed_at, label FROM manual_check_results WHERE release_candidate_id = ? AND (label = ? OR manual_case_id IN (SELECT id FROM manual_cases WHERE project_id = ? AND (label = ? OR category = ?))) ORDER BY performed_at DESC`, [rc.id, rule.label, p.id, rule.label, rule.category ?? '']);
        const rel = rule.device ? checks.filter((c) => c.device.toLowerCase().includes(rule.device!.toLowerCase())) : checks;
        if (rel.length === 0) return { rule, pass: false, message: `manual check "${rule.label}"${rule.device ? ` on ${rule.device}` : ''} not performed — BLOCKING`, evidence: {} };
        const latest = rel[0]!;
        return { rule, pass: latest.result === 'pass', message: `manual check "${rule.label}": ${latest.result} on ${latest.device} (${latest.performed_at})${latest.result === 'pass' ? '' : ' — BLOCKING'}`, evidence: { checkId: latest.id, device: latest.device, tester: latest.tester_user_id, performedAt: latest.performed_at } };
      }
      case 'accessibility_max': {
        // Only the latest completed run of each suite counts (a re-run after a fix supersedes the failing one); ad-hoc runs count individually.
        let count = 0; const sources: string[] = [];
        for (const run of latestRunsPerSuite(runs)) { const rows = await this.db.all<{ id: string; checks_json: string | null }>(`SELECT id, checks_json FROM test_results WHERE run_id = ?`, [run.id]); for (const r of rows) { const a11y = asJson<{ accessibility?: Array<{ counts?: Record<string, number> }> }>(r.checks_json, {}).accessibility ?? []; for (const a of a11y) { const n = a.counts?.[rule.impact] ?? 0; if (n) { count += n; sources.push(r.id); } } } }
        return { rule, pass: count <= rule.max, message: `accessibility ${rule.impact} findings: ${count}, max ${rule.max}${count <= rule.max ? '' : ' — BLOCKING'}`, evidence: { resultIds: sources.slice(0, 20) } };
      }
      case 'no_infra_errors': {
        const latestIds = latestRunsPerSuite(runs).map((r) => r.id);
        const n = latestIds.length ? Number((await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM test_results WHERE run_id IN (${latestIds.map(() => '?').join(',')}) AND status = 'infra_error'`, latestIds))?.c ?? 0) : 0;
        return { rule, pass: n === 0, message: n ? `${n} infrastructure error(s) in release runs — BLOCKING (rerun required)` : 'no infrastructure errors', evidence: { infraErrors: n } };
      }
    }
  }
  async evaluations(rcId: string) { return (await this.db.all<{ id: string; result: string; rules_json: string; summary_json: string | null; evaluated_by: string | null; evaluated_by_kind: string; created_at: string }>(`SELECT * FROM gate_evaluations WHERE release_candidate_id = ? ORDER BY id DESC LIMIT 50`, [rcId])).map((e) => ({ id: e.id, result: e.result, rules: asJson<RuleOutcome[]>(e.rules_json, []), summary: asJson(e.summary_json, {}), evaluatedBy: e.evaluated_by, evaluatedByKind: e.evaluated_by_kind, createdAt: e.created_at })); }

  // ---------- accepted risk ----------
  async acceptRisk(ctx: Ctx, p: ProjectRow, rc: RCRow, input: { defectId: string; reason: string; reviewDate: string; impact: string }) {
    if (!ctx.actor.userId && ctx.actor.kind !== 'user') throw forbidden('accepted risks need a human approver');
    const d = await this.db.get<{ id: string; key: string }>(`SELECT id, key FROM defects WHERE id = ? AND project_id = ?`, [input.defectId, p.id]);
    if (!d) throw badRequest('defect not in project');
    if (!/^\d{4}-\d{2}-\d{2}/.test(input.reviewDate)) throw badRequest('reviewDate must be an ISO date');
    const approver = ctx.actor.userId ?? ctx.actor.id!;
    const id = ulid();
    await this.db.run(`INSERT INTO accepted_risks (id, org_id, release_candidate_id, defect_id, reason, approver_user_id, review_date, impact, created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (release_candidate_id, defect_id) DO UPDATE SET reason = ?, approver_user_id = ?, review_date = ?, impact = ?, revoked_at = NULL`, [id, p.org_id, rc.id, d.id, input.reason, approver, input.reviewDate, input.impact, nowIso(), input.reason, approver, input.reviewDate, input.impact]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'release.accept_risk', targetType: 'release_candidate', targetId: rc.id, projectId: p.id, after: { defect: d.key, reason: input.reason, reviewDate: input.reviewDate, impact: input.impact, approver }, ip: ctx.ip });
    return this.db.get(`SELECT * FROM accepted_risks WHERE release_candidate_id = ? AND defect_id = ?`, [rc.id, d.id]);
  }
  async revokeRisk(ctx: Ctx, p: ProjectRow, rc: RCRow, defectId: string) {
    const r = await this.db.run(`UPDATE accepted_risks SET revoked_at = ? WHERE release_candidate_id = ? AND defect_id = ? AND revoked_at IS NULL`, [nowIso(), rc.id, defectId]);
    if (!r.changes) throw notFound('accepted risk');
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'release.revoke_risk', targetType: 'release_candidate', targetId: rc.id, projectId: p.id, after: { defectId }, ip: ctx.ip });
  }
  async risks(rcId: string) { return this.db.all(`SELECT ar.*, d.key AS defect_key, d.title AS defect_title, d.severity AS defect_severity, u.name AS approver_name FROM accepted_risks ar JOIN defects d ON d.id = ar.defect_id LEFT JOIN users u ON u.id = ar.approver_user_id WHERE ar.release_candidate_id = ? AND ar.revoked_at IS NULL`, [rcId]); }

  /** Human release decision. Requires a fresh gate that is READY or READY_WITH_ACCEPTED_RISK. Service tokens / system / AI cannot release. */
  async release(ctx: Ctx, p: ProjectRow, rc: RCRow, note?: string) {
    if (ctx.actor.kind === 'system' || ctx.actor.kind === 'runner' || (ctx.actor.kind === 'token' && !ctx.actor.userId)) throw forbidden('release approval requires a human user (not a service token, runner or AI)');
    if (rc.status === 'released') throw conflict('already released');
    const gate = await this.evaluate(ctx, p, rc);
    if (gate.result === 'BLOCKED') throw conflict(`gate is BLOCKED: ${gate.rules.filter((r) => !r.pass).map((r) => r.message).join('; ')}`);
    const now = nowIso(); const approver = ctx.actor.userId ?? ctx.actor.id;
    await this.db.run(`UPDATE release_candidates SET status = 'released', released_at = ?, released_by = ?, updated_at = ? WHERE id = ?`, [now, approver, now, rc.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'release.approve', targetType: 'release_candidate', targetId: rc.id, projectId: p.id, after: { gate: gate.result, note: note ?? null, approver }, ip: ctx.ip });
    // Release evidence must be retained longer.
    const runIds = (await this.runsOf(rc.id)).map((r) => r.id);
    for (const rid of runIds) await this.db.run(`UPDATE artifacts SET retention_class = 'release_evidence', expires_at = ? WHERE run_id = ? AND deleted_at IS NULL AND retention_class IN ('passed','failed')`, [this.artifacts.retentionExpiry('release_evidence'), rid]);
    return { ...rcView(await this.getRow(rc.id)), gate: gate.result };
  }

  // ---------- evidence report ----------
  async buildReportData(p: ProjectRow, rc: RCRow) {
    const env = await this.projects.getEnvironmentRow(rc.environment_id);
    const runs = await this.runsOf(rc.id);
    const runDetails = [] as Array<Record<string, unknown>>;
    const browserVersions: Record<string, string> = {};
    for (const r of runs) {
      const suite = r.suite_id ? await this.db.get<{ name: string; kind: string }>(`SELECT name, kind FROM suites WHERE id = ?`, [r.suite_id]) : null;
      const results = await this.db.all<{ id: string; scenario_id: string; browser: string; browser_version: string | null; viewport_json: string; status: string; outcome_detail: string; failure_json: string | null }>(`SELECT id, scenario_id, browser, browser_version, viewport_json, status, outcome_detail, failure_json FROM test_results WHERE run_id = ? ORDER BY id`, [r.id]);
      Object.assign(browserVersions, asJson<Record<string, string>>(r.browser_versions_json, {}));
      const rows = [] as Array<Record<string, unknown>>;
      for (const res of results) { const sc = await this.db.get<{ key: string; title: string }>(`SELECT key, title FROM scenarios WHERE id = ?`, [res.scenario_id]); const vp = asJson<{ width: number; height: number; name?: string }>(res.viewport_json, { width: 0, height: 0 }); rows.push({ id: res.id, scenario: sc ? `${sc.key} ${sc.title}` : res.scenario_id, browser: `${res.browser} ${res.browser_version ?? ''}`.trim(), viewport: vp.name ?? `${vp.width}x${vp.height}`, status: res.status, outcomeDetail: res.outcome_detail, failure: asJson<{ type: string; message: string } | null>(res.failure_json, null)?.message ?? null, artifacts: (await this.artifacts.listForResult(res.id)).map((a) => ({ id: a.id, kind: a.kind, label: a.label })) }); }
      runDetails.push({ id: r.id, suite: suite ? `${suite.name} (${suite.kind})` : 'ad-hoc', status: r.status, counts: asJson<Record<string, number>>(r.counts_json, {}), completedAt: r.completed_at, results: rows });
    }
    const evals = await this.evaluations(rc.id);
    const latestGate = evals[0] ?? null;
    const defects = await this.db.all<{ key: string; title: string; severity: string; status: string; fix_version: string | null }>(`SELECT key, title, severity, status, fix_version FROM defects WHERE project_id = ? AND (updated_at >= ? OR status IN (${OPEN_DEFECT_STATUSES.map(() => '?').join(',')})) ORDER BY severity, key`, [p.id, rc.created_at, ...OPEN_DEFECT_STATUSES]);
    const visual = (await this.visual.list(p.id, { limit: 500 })).filter((c) => runs.some((r) => r.id === c.runId));
    const manual = await this.db.all<{ id: string; label: string | null; device: string; os_version: string | null; browser: string | null; tester_user_id: string; performed_at: string; result: string; notes: string | null; artifact_ids_json: string | null }>(`SELECT * FROM manual_check_results WHERE release_candidate_id = ? ORDER BY performed_at`, [rc.id]);
    const risks = await this.risks(rc.id);
    const releasedBy = rc.released_by ? await this.db.get<{ name: string; email: string }>(`SELECT name, email FROM users WHERE id = ?`, [rc.released_by]) : null;
    const totals = runDetails.reduce<{ passed: number; failed: number; flaky: number; infraError: number; total: number }>((acc, r) => { const c = r.counts as Record<string, number>; acc.passed += c.passed ?? 0; acc.failed += c.failed ?? 0; acc.flaky += (c.flaky ?? 0) + (c.passedAfterRetry ?? 0); acc.infraError += c.infraError ?? 0; acc.total += c.total ?? 0; return acc; }, { passed: 0, failed: 0, flaky: 0, infraError: 0, total: 0 });
    return { generatedAt: nowIso(), appVersion: APP_VERSION, project: { id: p.id, name: p.name, type: p.type, timezone: p.timezone }, release: { ...rcView(rc), releasedByName: releasedBy?.name ?? null }, environment: { id: env.id, name: env.name, kind: env.kind, baseUrl: env.base_url }, browserMatrix: browserVersions, totals, runs: runDetails, gate: latestGate, defects, visual: visual.map((v) => ({ id: v.id, stepKey: v.stepKey, browser: v.browser, viewport: v.viewportKey, status: v.status, diffRatio: v.diffRatio, reviewedBy: v.reviewedBy, reviewNote: v.reviewNote, baselineArtifactId: v.baselineArtifactId, currentArtifactId: v.currentArtifactId, diffArtifactId: v.diffArtifactId })), manualChecks: manual.map((m) => ({ id: m.id, label: m.label, device: m.device, osVersion: m.os_version, browser: m.browser, tester: m.tester_user_id, performedAt: m.performed_at, result: m.result, notes: m.notes, artifactIds: asJson<string[]>(m.artifact_ids_json, []) })), acceptedRisks: risks };
  }
  renderHtml(d: Awaited<ReturnType<ReleaseService['buildReportData']>>): string {
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    const badge = (s: string) => `<span class="b b-${esc(s)}">${esc(s)}</span>`;
    const runsHtml = d.runs.map((r) => `<h3>Run ${esc(r.id)} — ${esc(r.suite)} ${badge(String(r.status))}</h3><p>${Object.entries(r.counts as Record<string, number>).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ')}</p><table><thead><tr><th>Scenario</th><th>Browser</th><th>Viewport</th><th>Status</th><th>Outcome</th><th>Failure</th><th>Evidence</th></tr></thead><tbody>${(r.results as Array<Record<string, unknown>>).map((x) => `<tr><td>${esc(x.scenario)}</td><td>${esc(x.browser)}</td><td>${esc(x.viewport)}</td><td>${badge(String(x.status))}</td><td>${esc(x.outcomeDetail)}</td><td>${esc(x.failure)}</td><td>${(x.artifacts as Array<{ id: string; kind: string }>).map((a) => `<code>${esc(a.kind)}:${esc(a.id)}</code>`).join(' ')}</td></tr>`).join('')}</tbody></table>`).join('');
    const gateHtml = d.gate ? `<p class="gate gate-${esc(d.gate.result)}">${esc(d.gate.result)}</p><ul>${d.gate.rules.map((r) => `<li>${r.pass ? '✅' : '❌'} ${esc(r.message)}</li>`).join('')}</ul><p class="muted">Evaluated ${esc(d.gate.createdAt)} by ${esc(d.gate.evaluatedByKind)} ${esc(d.gate.evaluatedBy)}</p>` : '<p>No gate evaluation recorded.</p>';
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ProofFlow Evidence Report — ${esc(d.project.name)} ${esc(d.release.version)}</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#1a1a2e;line-height:1.45}h1{margin-bottom:0}table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0 16px}th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f3f4f6}.b{padding:1px 6px;border-radius:4px;font-size:12px;background:#e5e7eb}.b-passed{background:#dcfce7}.b-failed{background:#fee2e2}.b-flaky{background:#fef3c7}.b-infra_error{background:#fde68a}.gate{font-size:22px;font-weight:700}.gate-READY{color:#15803d}.gate-BLOCKED{color:#b91c1c}.gate-READY_WITH_ACCEPTED_RISK{color:#b45309}.muted{color:#666;font-size:12px}.note{border:1px solid #fbbf24;background:#fffbeb;padding:8px 12px;font-size:13px}code{font-size:11px}</style></head><body>
<h1>Evidence Report</h1><p class="muted">ProofFlow ${esc(d.appVersion)} · generated ${esc(d.generatedAt)}</p>
<p class="note">このレポートはテスト実行結果の記録です。品質保証証明書・認証・保証書ではありません。自動テストで検出できる不具合は一部であり、未検出の問題が存在する可能性があります。</p>
<h2>Summary</h2><table><tr><th>Project</th><td>${esc(d.project.name)} (${esc(d.project.type)})</td></tr><tr><th>Version</th><td>${esc(d.release.version)}</td></tr><tr><th>Commit / Build</th><td>${esc(d.release.commitSha)} / ${esc(d.release.buildId)}</td></tr><tr><th>Environment</th><td>${esc(d.environment.name)} (${esc(d.environment.kind)}) ${esc(d.environment.baseUrl)}</td></tr><tr><th>Run date</th><td>${esc(d.runs.map((r) => r.completedAt).filter(Boolean).sort().slice(-1)[0] ?? '—')}</td></tr><tr><th>Browser matrix</th><td>${esc(Object.entries(d.browserMatrix).map(([k, v]) => `${k} ${v}`).join(', ') || '—')}</td></tr><tr><th>Results</th><td>passed ${d.totals.passed} · failed ${d.totals.failed} · flaky ${d.totals.flaky} · infra ${d.totals.infraError} · total ${d.totals.total}</td></tr><tr><th>Release status</th><td>${esc(d.release.status)}${d.release.releasedAt ? ` — approved by ${esc(d.release.releasedByName)} at ${esc(d.release.releasedAt)}` : ''}</td></tr></table>
<h2>Release Gate</h2>${gateHtml}
<h2>Test Runs</h2>${runsHtml || '<p>No runs linked to this release candidate.</p>'}
<h2>Defects</h2><table><thead><tr><th>Key</th><th>Title</th><th>Severity</th><th>Status</th><th>Fix version</th></tr></thead><tbody>${d.defects.map((x) => `<tr><td>${esc(x.key)}</td><td>${esc(x.title)}</td><td>${esc(x.severity)}</td><td>${esc(x.status)}</td><td>${esc(x.fix_version)}</td></tr>`).join('') || '<tr><td colspan="5">none</td></tr>'}</tbody></table>
<h2>Visual Evidence</h2><table><thead><tr><th>Step</th><th>Browser</th><th>Viewport</th><th>Status</th><th>Diff ratio</th><th>Reviewed by</th><th>Note</th><th>Artifacts</th></tr></thead><tbody>${d.visual.map((v) => `<tr><td>${esc(v.stepKey)}</td><td>${esc(v.browser)}</td><td>${esc(v.viewport)}</td><td>${esc(v.status)}</td><td>${v.diffRatio == null ? '—' : (v.diffRatio * 100).toFixed(2) + '%'}</td><td>${esc(v.reviewedBy)}</td><td>${esc(v.reviewNote)}</td><td><code>${esc(v.baselineArtifactId)}</code> → <code>${esc(v.currentArtifactId)}</code> ${v.diffArtifactId ? `diff <code>${esc(v.diffArtifactId)}</code>` : ''}</td></tr>`).join('') || '<tr><td colspan="8">none</td></tr>'}</tbody></table>
<h2>Manual Device Checks</h2><table><thead><tr><th>Label</th><th>Device</th><th>OS</th><th>Browser</th><th>Tester</th><th>Performed</th><th>Result</th><th>Notes</th><th>Evidence</th></tr></thead><tbody>${d.manualChecks.map((m) => `<tr><td>${esc(m.label)}</td><td>${esc(m.device)}</td><td>${esc(m.osVersion)}</td><td>${esc(m.browser)}</td><td>${esc(m.tester)}</td><td>${esc(m.performedAt)}</td><td>${esc(m.result)}</td><td>${esc(m.notes)}</td><td>${m.artifactIds.map((a) => `<code>${esc(a)}</code>`).join(' ')}</td></tr>`).join('') || '<tr><td colspan="9">none</td></tr>'}</tbody></table>
<h2>Accepted Risks</h2><table><thead><tr><th>Defect</th><th>Severity</th><th>Reason</th><th>Impact</th><th>Approver</th><th>Review date</th></tr></thead><tbody>${(d.acceptedRisks as Array<Record<string, unknown>>).map((r) => `<tr><td>${esc(r.defect_key)} ${esc(r.defect_title)}</td><td>${esc(r.defect_severity)}</td><td>${esc(r.reason)}</td><td>${esc(r.impact)}</td><td>${esc(r.approver_name ?? r.approver_user_id)}</td><td>${esc(r.review_date)}</td></tr>`).join('') || '<tr><td colspan="6">none</td></tr>'}</tbody></table>
<h2>Approver</h2><p>${d.release.releasedAt ? `${esc(d.release.releasedByName)} (${esc(d.release.releasedAt)})` : 'not released'}</p>
</body></html>`;
  }
  async generateReport(ctx: Ctx, p: ProjectRow, rc: RCRow, format: 'html' | 'pdf') {
    const data = await this.buildReportData(p, rc);
    const html = this.renderHtml(data);
    let body: Buffer = Buffer.from(html, 'utf8'); let contentType = 'text/html; charset=utf-8';
    if (format === 'pdf') {
      try {
        const pw = await import('playwright');
        const browser = await pw.chromium.launch({ headless: true });
        try { const page = await browser.newPage(); await page.setContent(html, { waitUntil: 'load' }); body = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } }); contentType = 'application/pdf'; } finally { await browser.close(); }
      } catch (e) { throw badRequest(`PDF rendering unavailable (${e instanceof Error ? e.message.split('\n')[0] : e}); use html`, { code: 'pdf_unavailable' }); }
    }
    const checksum = sha256(body);
    const art = await this.artifacts.create({ orgId: p.org_id, projectId: p.id, runId: null, kind: 'report', label: `evidence-${rc.version}.${format}`, contentType, body, retentionClass: 'release_evidence', createdBy: ctx.actor.id });
    const id = ulid();
    await this.db.run(`INSERT INTO evidence_reports (id, org_id, project_id, release_candidate_id, format, artifact_id, gate_evaluation_id, summary_json, checksum, generated_by, generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, rc.id, format, art.id, data.gate?.id ?? null, JSON.stringify({ totals: data.totals, gate: data.gate?.result ?? null, runs: data.runs.map((r) => ({ id: r.id, status: r.status, counts: r.counts })), defects: data.defects.length, visual: data.visual.length, manualChecks: data.manualChecks.length, acceptedRisks: data.acceptedRisks.length }), checksum, ctx.actor.id, nowIso()]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'release.report', targetType: 'release_candidate', targetId: rc.id, projectId: p.id, after: { reportId: id, format, checksum: checksum.slice(0, 16) }, ip: ctx.ip });
    return { id, format, artifactId: art.id, checksum, summary: asJson((await this.db.get<{ summary_json: string }>(`SELECT summary_json FROM evidence_reports WHERE id = ?`, [id]))?.summary_json, {}), data };
  }
  async reports(rcId: string) { return (await this.db.all<{ id: string; format: string; artifact_id: string; summary_json: string; checksum: string; generated_by: string | null; generated_at: string }>(`SELECT * FROM evidence_reports WHERE release_candidate_id = ? ORDER BY id DESC`, [rcId])).map((r) => ({ id: r.id, format: r.format, artifactId: r.artifact_id, summary: asJson(r.summary_json, {}), checksum: r.checksum, generatedBy: r.generated_by, generatedAt: r.generated_at })); }

  // ---------- dashboard ----------
  async dashboard(p: ProjectRow) {
    const today = nowIso().slice(0, 10); const d30 = new Date(Date.now() - 30 * 86400_000).toISOString();
    const runsToday = await this.db.all<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM test_runs WHERE project_id = ? AND created_at >= ? GROUP BY status`, [p.id, today]);
    const newDefects = Number((await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM defects WHERE project_id = ? AND created_at >= ?`, [p.id, today]))?.c ?? 0);
    const rfr = Number((await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM defects WHERE project_id = ? AND status = 'ready_for_retest'`, [p.id]))?.c ?? 0);
    const blocked = Number((await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM release_candidates WHERE project_id = ? AND status = 'blocked'`, [p.id]))?.c ?? 0);
    const openBySev = await this.db.all<{ severity: string; c: number }>(`SELECT severity, COUNT(*) AS c FROM defects WHERE project_id = ? AND status IN (${OPEN_DEFECT_STATUSES.map(() => '?').join(',')}) GROUP BY severity`, [p.id, ...OPEN_DEFECT_STATUSES]);
    const p0 = await this.db.all<{ id: string }>(`SELECT id FROM requirements WHERE project_id = ? AND priority IN ('p0','p1')`, [p.id]);
    let covered = 0; for (const r of p0) if (await this.db.get(`SELECT 1 FROM scenario_requirements sr JOIN scenarios s ON s.id = sr.scenario_id WHERE sr.requirement_id = ? AND s.status = 'active' LIMIT 1`, [r.id])) covered++;
    const browsers = await this.db.all<{ browser: string; c: number }>(`SELECT browser, COUNT(*) AS c FROM test_results WHERE project_id = ? AND created_at >= ? GROUP BY browser`, [p.id, d30]);
    const mobileRuns = Number((await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM test_results WHERE project_id = ? AND created_at >= ? AND viewport_json LIKE '%"isMobile":true%'`, [p.id, d30]))?.c ?? 0);
    const manual30 = Number((await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM manual_check_results WHERE project_id = ? AND performed_at >= ?`, [p.id, d30]))?.c ?? 0);
    const visualPending = await this.visual.pendingCount(p.id);
    const a11y = await this.db.all<{ checks_json: string | null }>(`SELECT checks_json FROM test_results WHERE project_id = ? AND created_at >= ? AND checks_json LIKE '%accessibility%' ORDER BY id DESC LIMIT 200`, [p.id, d30]);
    const a11yCounts: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const r of a11y) for (const a of asJson<{ accessibility?: Array<{ counts?: Record<string, number> }> }>(r.checks_json, {}).accessibility ?? []) for (const [k, v] of Object.entries(a.counts ?? {})) a11yCounts[k] = (a11yCounts[k] ?? 0) + v;
    const flakyRecent = Number((await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM test_results WHERE project_id = ? AND created_at >= ? AND status = 'flaky'`, [p.id, today]))?.c ?? 0);
    return {
      today: { runs: Object.fromEntries(runsToday.map((r) => [r.status, Number(r.c)])), failedRuns: Number(runsToday.find((r) => r.status === 'failed')?.c ?? 0), flakyResults: flakyRecent, newDefects, readyForRetest: rfr, blockedReleases: blocked },
      quality: { criticalRequirementCoverage: { covered, total: p0.length }, browserCoverage30d: Object.fromEntries(browsers.map((b) => [b.browser, Number(b.c)])), mobileChecks30d: { automatedMobileResults: mobileRuns, manualChecks: manual30 }, visualChangesPending: visualPending, accessibilityFindings30d: a11yCounts, openDefects: Object.fromEntries(openBySev.map((d) => [d.severity, Number(d.c)])) },
      note: 'ProofFlow does not compute a single AI quality score; review the evidence.',
    };
  }
  bool = asBool;
}
