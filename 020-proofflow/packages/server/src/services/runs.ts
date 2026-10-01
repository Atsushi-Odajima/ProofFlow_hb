import { EventEmitter } from 'node:events';
import type { Db } from '../db/db.js';
import { nowIso, asJson, asBool } from '../db/db.js';
import { ulid, DEFAULT_MATRIX, MatrixSchema, checkTargetUrl, extractSecretRefs, failureFingerprint, type Matrix, type Step, type Viewport, type RunStatus, type ResultStatus, type OutcomeDetail } from '@proofflow/shared';
import type { Config } from '../config.js';
import { badRequest, conflict, notFound, forbidden, HttpError, type Ctx, type Actor } from '../context.js';
import type { AuditService } from './audit.js';
import type { ProjectService, ProjectRow, EnvironmentRow } from './projects.js';
import { environmentView } from './projects.js';
import type { ScenarioService } from './scenarios.js';
import { scenarioView } from './scenarios.js';
import type { ArtifactService } from './artifacts.js';

export interface RunRow { id: string; org_id: string; project_id: string; environment_id: string; suite_id: string | null; kind: string; label: string | null; status: RunStatus; trigger: string; commit_sha: string | null; branch: string | null; pr_number: number | null; build_id: string | null; matrix_json: string; release_candidate_id: string | null; parent_run_id: string | null; retest_defect_id: string | null; idempotency_key: string | null; priority: number; counts_json: string | null; browser_versions_json: string | null; runner_ids_json: string | null; requested_by: string | null; requested_by_kind: string | null; error_message: string | null; queued_at: string; started_at: string | null; completed_at: string | null; created_at: string; updated_at: string; }
export interface JobRow { id: string; org_id: string; run_id: string; scenario_id: string; scenario_version: number; browser: string; viewport_json: string; status: string; attempt: number; max_attempts: number; priority: number; available_at: string; lease_until: string | null; leased_by: string | null; result_id: string | null; last_error: string | null; created_at: string; started_at: string | null; completed_at: string | null; }
export interface ResultRow { id: string; org_id: string; project_id: string; run_id: string; job_id: string | null; scenario_id: string; scenario_version: number; browser: string; browser_version: string | null; viewport_json: string; status: ResultStatus; outcome_detail: OutcomeDetail; attempts: number; duration_ms: number | null; started_at: string | null; completed_at: string | null; failure_json: string | null; fingerprint: string | null; steps_json: string | null; console_summary_json: string | null; network_summary_json: string | null; metrics_json: string | null; checks_json: string | null; runner_id: string | null; created_at: string; }

export interface FailureInfo { type: string; message: string; stepIndex?: number; stepType?: string; url?: string; locator?: string; status?: number; ruleId?: string; stack?: string; expected?: string; actual?: string; }
export interface JobCompletion { status: ResultStatus; outcomeDetail: OutcomeDetail; attempts: number; durationMs: number; startedAt: string; completedAt: string; browserVersion?: string; failure?: FailureInfo | null; steps?: unknown[]; consoleSummary?: unknown; networkSummary?: unknown; metrics?: unknown; checks?: unknown; attemptsDetail?: { attempt: number; status: string; durationMs: number; failure?: FailureInfo | null; steps?: unknown[]; startedAt: string; completedAt: string }[]; }

export function runView(r: RunRow) {
  return { id: r.id, projectId: r.project_id, environmentId: r.environment_id, suiteId: r.suite_id, kind: r.kind, label: r.label, status: r.status, trigger: r.trigger, commitSha: r.commit_sha, branch: r.branch, prNumber: r.pr_number, buildId: r.build_id, matrix: asJson<Matrix>(r.matrix_json, DEFAULT_MATRIX), releaseCandidateId: r.release_candidate_id, parentRunId: r.parent_run_id, retestDefectId: r.retest_defect_id, priority: r.priority, counts: asJson<Record<string, number>>(r.counts_json, {}), browserVersions: asJson<Record<string, string>>(r.browser_versions_json, {}), requestedBy: r.requested_by, requestedByKind: r.requested_by_kind, errorMessage: r.error_message, queuedAt: r.queued_at, startedAt: r.started_at, completedAt: r.completed_at, createdAt: r.created_at };
}
export function resultView(r: ResultRow) {
  return { id: r.id, runId: r.run_id, jobId: r.job_id, scenarioId: r.scenario_id, scenarioVersion: r.scenario_version, browser: r.browser, browserVersion: r.browser_version, viewport: asJson<Viewport>(r.viewport_json, { width: 0, height: 0 }), status: r.status, outcomeDetail: r.outcome_detail, attempts: r.attempts, durationMs: r.duration_ms, startedAt: r.started_at, completedAt: r.completed_at, failure: asJson<FailureInfo | null>(r.failure_json, null), fingerprint: r.fingerprint, steps: asJson<unknown[]>(r.steps_json, []), consoleSummary: asJson<unknown>(r.console_summary_json, null), networkSummary: asJson<unknown>(r.network_summary_json, null), metrics: asJson<unknown>(r.metrics_json, null), checks: asJson<unknown>(r.checks_json, null), runnerId: r.runner_id, createdAt: r.created_at };
}
export const viewportKey = (v: Viewport) => v.name ?? v.device ?? `${v.width}x${v.height}`;

export class RunEvents extends EventEmitter { emitRun(runId: string, event: string, data: unknown) { this.emit(`run:${runId}`, { event, data, at: nowIso() }); this.emit('any', { runId, event, data }); } }

export class RunService {
  readonly events = new RunEvents();
  constructor(private db: Db, private cfg: Config, private audit: AuditService, private projects: ProjectService, private scenarios: ScenarioService, private artifacts: ArtifactService) { this.events.setMaxListeners(1000); }

  // ---------------- creation ----------------
  async create(ctx: Ctx, p: ProjectRow, input: { environmentId: string; suiteId?: string; scenarioIds?: string[]; matrix?: Partial<Matrix>; commitSha?: string; branch?: string; prNumber?: number; buildId?: string; trigger: string; priority?: number; releaseCandidateId?: string; allowDestructive?: boolean; idempotencyKey?: string; retestDefectId?: string; parentRunId?: string; label?: string; kind?: string }, opts: { canRunDestructive: boolean }) {
    const env = await this.projects.getEnvironmentRow(input.environmentId, p.id);
    if (input.idempotencyKey) {
      const existing = await this.db.get<RunRow>(`SELECT * FROM test_runs WHERE org_id = ? AND idempotency_key = ?`, [p.org_id, input.idempotencyKey]);
      if (existing) return { run: runView(existing), deduplicated: true };
    }
    let scenarioIds: string[] = []; let matrix: Matrix = DEFAULT_MATRIX; let suiteId: string | null = null;
    if (input.suiteId) { const s = await this.scenarios.getSuite(input.suiteId, p.id); scenarioIds = s.scenarioIds; matrix = s.matrix; suiteId = s.id; }
    if (input.scenarioIds?.length) { scenarioIds = input.suiteId ? scenarioIds.filter((id) => input.scenarioIds!.includes(id)) : input.scenarioIds; }
    if (input.matrix) matrix = MatrixSchema.parse({ ...matrix, ...input.matrix });
    if (scenarioIds.length === 0) throw badRequest('run needs at least one scenario (suite or scenarioIds)');
    const scenarioRows = [] as import('./scenarios.js').ScenarioRow[];
    for (const id of scenarioIds) { const s = await this.scenarios.getRow(id, p.id); if (s.status === 'archived') continue; scenarioRows.push(s); }
    if (scenarioRows.length === 0) throw badRequest('all scenarios are archived');
    // Destructive policy: production (or any env with policy=deny) refuses destructive scenarios unless explicitly allowed AND the actor may do so.
    const destructive = scenarioRows.filter((s) => asBool(s.destructive));
    if (destructive.length > 0 && env.destructive_policy === 'deny') {
      throw new HttpError(403, 'destructive_denied', `environment "${env.name}" (${env.kind}) denies destructive scenarios: ${destructive.map((s) => s.key).join(', ')}`, { scenarioKeys: destructive.map((s) => s.key), environmentKind: env.kind });
    }
    if (destructive.length > 0 && env.kind === 'production') {
      if (!input.allowDestructive || !opts.canRunDestructive) throw new HttpError(403, 'destructive_confirmation_required', 'destructive scenarios on production require allowDestructive=true and the run:trigger_destructive permission', { scenarioKeys: destructive.map((s) => s.key) });
    }
    const urlPolicy = checkTargetUrl(env.base_url, { allowPrivateNetwork: asBool(env.allow_private_network) || this.cfg.allowPrivateTargetsGlobally });
    if (!urlPolicy.allowed) throw new HttpError(403, 'target_policy', `environment base URL rejected: ${urlPolicy.reason}`);
    // Domain verification: unverified public targets run in low-load mode (DOMAIN_VERIFICATION.md).
    const verified = asBool(env.domain_verified) || env.kind === 'local';
    const priority = Math.min(input.priority ?? 3, verified ? 9 : 2);
    const runId = ulid(); const now = nowIso();
    const jobs: { id: string; scenario: import('./scenarios.js').ScenarioRow; browser: string; viewport: Viewport }[] = [];
    for (const s of scenarioRows) {
      const browsers = asJson<string[] | null>(s.browsers_json, null) ?? matrix.browsers;
      for (const b of matrix.browsers.filter((x) => browsers.includes(x))) for (const v of matrix.viewports) jobs.push({ id: ulid(), scenario: s, browser: b, viewport: v });
    }
    if (!verified && jobs.length > 50) throw new HttpError(403, 'domain_unverified', 'unverified domain: runs are limited to 50 jobs until the domain is verified (DOMAIN_VERIFICATION.md)');
    await this.db.tx(async (tx) => {
      await tx.run(`INSERT INTO test_runs (id, org_id, project_id, environment_id, suite_id, kind, label, status, trigger, commit_sha, branch, pr_number, build_id, matrix_json, release_candidate_id, parent_run_id, retest_defect_id, idempotency_key, priority, counts_json, requested_by, requested_by_kind, queued_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [runId, p.org_id, p.id, env.id, suiteId, input.kind ?? (input.retestDefectId ? 'retest' : suiteId ? 'suite' : 'scenario'), input.label ?? null, 'queued', input.trigger, input.commitSha ?? null, input.branch ?? null, input.prNumber ?? null, input.buildId ?? null, JSON.stringify(matrix), input.releaseCandidateId ?? null, input.parentRunId ?? null, input.retestDefectId ?? null, input.idempotencyKey ?? null, priority, JSON.stringify({ total: jobs.length, queued: jobs.length }), ctx.actor.id, ctx.actor.kind, now, now, now]);
      for (const j of jobs) await tx.run(`INSERT INTO run_jobs (id, org_id, run_id, scenario_id, scenario_version, browser, viewport_json, status, attempt, max_attempts, priority, available_at, created_at) VALUES (?,?,?,?,?,?,?,?,0,2,?,?,?)`, [j.id, p.org_id, runId, j.scenario.id, j.scenario.version, j.browser, JSON.stringify(j.viewport), 'queued', priority, now, now]);
      await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'run.create', targetType: 'test_run', targetId: runId, projectId: p.id, after: { environmentId: env.id, suiteId, jobs: jobs.length, trigger: input.trigger, commitSha: input.commitSha ?? null, destructive: destructive.length }, ip: ctx.ip }, tx);
    });
    await this.db.run(`INSERT INTO usage_counters (org_id, period, metric, value) VALUES (?,?,?,?) ON CONFLICT (org_id, period, metric) DO UPDATE SET value = usage_counters.value + ?`, [p.org_id, now.slice(0, 7), 'runs', 1, 1]);
    const run = runView((await this.getRow(runId))!);
    this.events.emitRun(runId, 'run.queued', { runId, jobs: jobs.length });
    return { run, deduplicated: false };
  }

  async getRow(id: string, projectId?: string): Promise<RunRow> {
    const r = await this.db.get<RunRow>(`SELECT * FROM test_runs WHERE id = ?`, [id]);
    if (!r || (projectId && r.project_id !== projectId)) throw notFound('run');
    return r;
  }
  async list(projectId: string, opts: { status?: string; environmentId?: string; suiteId?: string; releaseCandidateId?: string; limit?: number; cursor?: string; branch?: string } = {}) {
    const where = ['project_id = ?']; const params: (string | number)[] = [projectId];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.environmentId) { where.push('environment_id = ?'); params.push(opts.environmentId); }
    if (opts.suiteId) { where.push('suite_id = ?'); params.push(opts.suiteId); }
    if (opts.releaseCandidateId) { where.push('release_candidate_id = ?'); params.push(opts.releaseCandidateId); }
    if (opts.branch) { where.push('branch = ?'); params.push(opts.branch); }
    if (opts.cursor) { where.push('id < ?'); params.push(opts.cursor); }
    params.push(Math.min(opts.limit ?? 50, 200));
    return (await this.db.all<RunRow>(`SELECT * FROM test_runs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params)).map(runView);
  }
  async results(runId: string) { return (await this.db.all<ResultRow>(`SELECT * FROM test_results WHERE run_id = ? ORDER BY id`, [runId])).map(resultView); }
  async getResult(resultId: string, projectId?: string) {
    const r = await this.db.get<ResultRow>(`SELECT * FROM test_results WHERE id = ?`, [resultId]);
    if (!r || (projectId && r.project_id !== projectId)) throw notFound('result');
    return r;
  }
  async jobs(runId: string) { return this.db.all<JobRow>(`SELECT * FROM run_jobs WHERE run_id = ? ORDER BY id`, [runId]); }
  async detail(run: RunRow) {
    const results = await this.results(run.id);
    const artifacts = await this.artifacts.listForRun(run.id);
    const jobs = await this.jobs(run.id);
    const attempts = await this.db.all<{ id: string; result_id: string; attempt: number; status: string; duration_ms: number | null; failure_json: string | null; started_at: string | null; completed_at: string | null }>(`SELECT id, result_id, attempt, status, duration_ms, failure_json, started_at, completed_at FROM result_attempts WHERE result_id IN (SELECT id FROM test_results WHERE run_id = ?) ORDER BY result_id, attempt`, [run.id]);
    const scenarios: Record<string, { key: string; title: string }> = {};
    for (const r of results) if (!scenarios[r.scenarioId]) { const s = await this.db.get<{ key: string; title: string }>(`SELECT key, title FROM scenarios WHERE id = ?`, [r.scenarioId]); if (s) scenarios[r.scenarioId] = s; }
    return { ...runView(run), results: results.map((r) => ({ ...r, scenario: scenarios[r.scenarioId] ?? null, artifacts: artifacts.filter((a) => a.resultId === r.id), attemptsDetail: attempts.filter((a) => a.result_id === r.id).map((a) => ({ attempt: a.attempt, status: a.status, durationMs: a.duration_ms, failure: asJson<FailureInfo | null>(a.failure_json, null), startedAt: a.started_at, completedAt: a.completed_at })) })), jobs: jobs.map((j) => ({ id: j.id, scenarioId: j.scenario_id, browser: j.browser, viewport: asJson<Viewport>(j.viewport_json, { width: 0, height: 0 }), status: j.status, attempt: j.attempt, maxAttempts: j.max_attempts, leasedBy: j.leased_by, lastError: j.last_error, startedAt: j.started_at, completedAt: j.completed_at })), artifacts: artifacts.filter((a) => !a.resultId) };
  }
  async cancel(ctx: Ctx, run: RunRow) {
    if (run.status !== 'queued' && run.status !== 'running') throw conflict('run already finished');
    await this.db.run(`UPDATE run_jobs SET status = 'cancelled', completed_at = ? WHERE run_id = ? AND status IN ('queued')`, [nowIso(), run.id]);
    await this.db.run(`UPDATE test_runs SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), run.id]);
    await this.audit.log({ orgId: run.org_id, actor: ctx.actor, action: 'run.cancel', targetType: 'test_run', targetId: run.id, projectId: run.project_id, ip: ctx.ip });
    this.events.emitRun(run.id, 'run.cancelled', { runId: run.id });
    await this.recomputeRun(run.id);
  }

  // ---------------- runner protocol ----------------
  async registerRunner(actor: Actor, orgId: string, input: { name: string; version?: string; capabilities?: unknown; allowPrivateNetwork?: boolean }) {
    let runner = actor.runnerId ? await this.db.get<{ id: string }>(`SELECT id FROM runners WHERE id = ? AND org_id = ?`, [actor.runnerId, orgId]) : undefined;
    if (!runner) { const id = ulid(); await this.db.run(`INSERT INTO runners (id, org_id, name, token_id, capabilities_json, version, last_heartbeat_at, status, self_hosted, allow_private_network, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, orgId, input.name, actor.id, JSON.stringify(input.capabilities ?? {}), input.version ?? null, nowIso(), 'online', 1, input.allowPrivateNetwork ? 1 : 0, nowIso()]); runner = { id }; }
    else await this.db.run(`UPDATE runners SET name = ?, capabilities_json = ?, version = ?, last_heartbeat_at = ?, status = 'online', allow_private_network = ? WHERE id = ?`, [input.name, JSON.stringify(input.capabilities ?? {}), input.version ?? null, nowIso(), input.allowPrivateNetwork ? 1 : 0, runner.id]);
    return { runnerId: runner.id };
  }
  /** Lease up to `max` queued jobs for the runner's org, honoring browser capabilities. At-least-once with a visibility timeout. */
  async lease(orgId: string, runnerId: string, browsers: string[], max: number, leaseSec = 180) {
    const runner = await this.db.get<{ id: string; allow_private_network: number }>(`SELECT id, allow_private_network FROM runners WHERE id = ? AND org_id = ?`, [runnerId, orgId]);
    if (!runner) throw forbidden('unknown runner');
    await this.db.run(`UPDATE runners SET last_heartbeat_at = ?, status = 'online' WHERE id = ?`, [nowIso(), runnerId]);
    const leased: JobRow[] = [];
    const placeholders = browsers.map(() => '?').join(',');
    for (let i = 0; i < max; i++) {
      const job = await this.db.tx(async (tx) => {
        const now = nowIso();
        const cand = await tx.get<JobRow>(`SELECT * FROM run_jobs WHERE org_id = ? AND status = 'queued' AND available_at <= ? AND browser IN (${placeholders}) ORDER BY priority DESC, created_at ASC LIMIT 1`, [orgId, now, ...browsers]);
        if (!cand) return null;
        const until = new Date(Date.now() + leaseSec * 1000).toISOString();
        const r = await tx.run(`UPDATE run_jobs SET status = 'leased', leased_by = ?, lease_until = ?, attempt = attempt + 1, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'`, [runnerId, until, now, cand.id]);
        if (!r.changes) return null;
        return { ...cand, status: 'leased', leased_by: runnerId, lease_until: until, attempt: cand.attempt + 1 } as JobRow;
      });
      if (!job) break;
      leased.push(job);
    }
    const payloads = [] as unknown[];
    for (const job of leased) {
      try { payloads.push(await this.jobPayload(job, asBool(runner.allow_private_network))); }
      catch (e) { await this.failJob(orgId, runnerId, job.id, { message: `payload error: ${e instanceof Error ? e.message : String(e)}`, kind: 'infra' }); }
    }
    return payloads;
  }
  private async jobPayload(job: JobRow, runnerAllowsPrivate: boolean) {
    const run = await this.getRow(job.run_id);
    const scenario = scenarioView(await this.scenarios.getRow(job.scenario_id));
    const env = environmentView(await this.projects.getEnvironmentRow(run.environment_id));
    const matrix = asJson<Matrix>(run.matrix_json, DEFAULT_MATRIX);
    const secretNames = new Set(extractSecretRefs(scenario.steps as Step[]));
    const ap = env.authProfile as Record<string, string | undefined>;
    for (const k of ['usernameSecretRef', 'passwordSecretRef', 'tokenSecretRef', 'storageStateSecretRef']) if (ap[k]) secretNames.add(ap[k]!);
    const secrets = await this.projects.resolveSecrets(run.project_id, run.environment_id, [...secretNames]);
    const data = await this.scenarios.resolveDataProfile(run.project_id, scenario.dataProfileId);
    const fixtureRows = await this.db.all<{ name: string; content_type: string; storage_key: string; id: string }>(`SELECT id, name, content_type, storage_key FROM fixtures WHERE project_id = ?`, [run.project_id]);
    const fixtures = fixtureRows.map((f) => ({ name: f.name, contentType: f.content_type, url: `${this.cfg.publicUrl}/fixtures/${f.id}?${this.artifacts.signedPath(f.id).split('?')[1]}` }));
    const baselines = await this.db.all<{ step_key: string; artifact_id: string }>(`SELECT step_key, artifact_id FROM visual_baselines WHERE project_id = ? AND scenario_id = ? AND browser = ? AND viewport_key = ? AND status = 'active'`, [run.project_id, scenario.id, job.browser, viewportKey(asJson<Viewport>(job.viewport_json, { width: 0, height: 0 }))]);
    if (!env.allowPrivateNetwork || !runnerAllowsPrivate) { const pol = checkTargetUrl(env.baseUrl, { allowPrivateNetwork: this.cfg.allowPrivateTargetsGlobally }); if (!pol.allowed) throw new Error(`target policy: ${pol.reason}`); }
    return {
      jobId: job.id, runId: run.id, projectId: run.project_id, attempt: job.attempt, maxAttempts: job.max_attempts, leaseUntil: job.lease_until,
      scenario: { id: scenario.id, key: scenario.key, title: scenario.title, version: scenario.version, steps: scenario.steps, expected: scenario.expected, destructive: scenario.destructive },
      browser: job.browser, viewport: asJson<Viewport>(job.viewport_json, { width: 1280, height: 800 }),
      environment: { id: env.id, kind: env.kind, baseUrl: env.baseUrl, apiBaseUrl: env.apiBaseUrl, authProfile: env.authProfile, allowPrivateNetwork: env.allowPrivateNetwork && runnerAllowsPrivate, allowedHosts: env.allowedHosts, privacy: { maskSelectors: env.maskSelectors, redactHeaders: env.redactHeaders, captureBodies: env.captureBodies }, noise: { consoleIgnorePatterns: env.consoleIgnorePatterns, networkIgnorePatterns: env.networkIgnorePatterns } },
      secrets, data, fixtures,
      baselines: baselines.map((b) => ({ stepKey: b.step_key, artifactId: b.artifact_id, url: this.artifacts.signedUrl(b.artifact_id) })),
      options: { retries: matrix.retries, video: matrix.video, trace: matrix.trace, stepTimeoutMs: 15_000, jobTimeoutMs: 10 * 60_000 },
    };
  }
  async heartbeat(orgId: string, runnerId: string, jobId: string, progress?: { stepIndex?: number; message?: string; attempt?: number }, leaseSec = 180) {
    const job = await this.db.get<JobRow>(`SELECT * FROM run_jobs WHERE id = ? AND org_id = ?`, [jobId, orgId]);
    if (!job) throw notFound('job');
    if (job.leased_by !== runnerId) throw forbidden('job leased by another runner');
    const run = await this.getRow(job.run_id);
    if (run.status === 'cancelled') return { cancelled: true, leaseUntil: job.lease_until };
    const until = new Date(Date.now() + leaseSec * 1000).toISOString();
    await this.db.run(`UPDATE run_jobs SET lease_until = ?, status = 'running' WHERE id = ?`, [until, job.id]);
    await this.db.run(`UPDATE runners SET last_heartbeat_at = ? WHERE id = ?`, [nowIso(), runnerId]);
    if (run.status === 'queued') { await this.db.run(`UPDATE test_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'`, [nowIso(), nowIso(), run.id]); this.events.emitRun(run.id, 'run.started', { runId: run.id }); }
    if (progress) this.events.emitRun(run.id, 'job.progress', { jobId: job.id, scenarioId: job.scenario_id, browser: job.browser, ...progress });
    return { cancelled: false, leaseUntil: until };
  }
  async completeJob(orgId: string, runnerId: string, jobId: string, c: JobCompletion, artifactIds: string[] = []) {
    const job = await this.db.get<JobRow>(`SELECT * FROM run_jobs WHERE id = ? AND org_id = ?`, [jobId, orgId]);
    if (!job) throw notFound('job');
    if (job.leased_by !== runnerId) throw forbidden('job leased by another runner');
    if (job.status === 'done') return { resultId: job.result_id };
    const run = await this.getRow(job.run_id);
    const fingerprint = c.failure ? failureFingerprint({ type: c.failure.type, message: c.failure.message, stepIndex: c.failure.stepIndex, stepType: c.failure.stepType, url: c.failure.url, locator: c.failure.locator, status: c.failure.status, ruleId: c.failure.ruleId }) : null;
    const resultId = ulid(); const now = nowIso();
    await this.db.tx(async (tx) => {
      await tx.run(`INSERT INTO test_results (id, org_id, project_id, run_id, job_id, scenario_id, scenario_version, browser, browser_version, viewport_json, status, outcome_detail, attempts, duration_ms, started_at, completed_at, failure_json, fingerprint, steps_json, console_summary_json, network_summary_json, metrics_json, checks_json, runner_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [resultId, orgId, run.project_id, run.id, job.id, job.scenario_id, job.scenario_version, job.browser, c.browserVersion ?? null, job.viewport_json, c.status, c.outcomeDetail, c.attempts, c.durationMs, c.startedAt, c.completedAt, c.failure ? JSON.stringify(c.failure) : null, fingerprint, JSON.stringify(c.steps ?? []), JSON.stringify(c.consoleSummary ?? null), JSON.stringify(c.networkSummary ?? null), JSON.stringify(c.metrics ?? null), JSON.stringify(c.checks ?? null), runnerId, now]);
      for (const a of c.attemptsDetail ?? []) await tx.run(`INSERT INTO result_attempts (id, org_id, result_id, attempt, status, duration_ms, failure_json, steps_json, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [ulid(), orgId, resultId, a.attempt, a.status, a.durationMs, a.failure ? JSON.stringify(a.failure) : null, JSON.stringify(a.steps ?? []), a.startedAt, a.completedAt]);
      await tx.run(`UPDATE run_jobs SET status = 'done', result_id = ?, completed_at = ?, lease_until = NULL WHERE id = ?`, [resultId, now, job.id]);
      if (artifactIds.length) { const ph = artifactIds.map(() => '?').join(','); await tx.run(`UPDATE artifacts SET result_id = ? WHERE id IN (${ph}) AND org_id = ? AND run_id = ?`, [resultId, ...artifactIds, orgId, run.id]); }
    });
    // Retention class follows the outcome: passed artifacts expire sooner than failed ones.
    await this.db.run(`UPDATE artifacts SET retention_class = ?, expires_at = ? WHERE result_id = ? AND retention_class IN ('passed','failed')`, [c.status === 'passed' ? 'passed' : 'failed', this.artifacts.retentionExpiry(c.status === 'passed' ? 'passed' : 'failed'), resultId]);
    if (c.browserVersion) { const bv = asJson<Record<string, string>>(run.browser_versions_json, {}); bv[job.browser] = c.browserVersion; await this.db.run(`UPDATE test_runs SET browser_versions_json = ? WHERE id = ?`, [JSON.stringify(bv), run.id]); }
    this.events.emitRun(run.id, 'job.completed', { jobId: job.id, resultId, scenarioId: job.scenario_id, browser: job.browser, status: c.status, outcomeDetail: c.outcomeDetail });
    await this.onResult?.(resultId, run, c, fingerprint);
    await this.recomputeRun(run.id);
    return { resultId };
  }
  /** Hook set by later phases (failure grouping / defect reopen / notifications). */
  onResult?: (resultId: string, run: RunRow, c: JobCompletion, fingerprint: string | null) => Promise<void>;
  onRunCompleted?: (run: RunRow) => Promise<void>;

  /** Runner-side infrastructure failure (browser missing, crash): retry the job, then mark infra_error — never a test failure. */
  async failJob(orgId: string, runnerId: string, jobId: string, err: { message: string; kind: 'infra' | 'policy' }) {
    const job = await this.db.get<JobRow>(`SELECT * FROM run_jobs WHERE id = ? AND org_id = ?`, [jobId, orgId]);
    if (!job) throw notFound('job');
    if (job.leased_by !== runnerId) throw forbidden('job leased by another runner');
    return this.infraFail(job, err.message, err.kind);
  }
  private async infraFail(job: JobRow, message: string, kind: 'infra' | 'policy' = 'infra') {
    const run = await this.getRow(job.run_id);
    if (job.attempt < job.max_attempts && kind === 'infra') {
      await this.db.run(`UPDATE run_jobs SET status = 'queued', leased_by = NULL, lease_until = NULL, last_error = ?, available_at = ? WHERE id = ?`, [message.slice(0, 1000), new Date(Date.now() + 5000).toISOString(), job.id]);
      this.events.emitRun(run.id, 'job.requeued', { jobId: job.id, attempt: job.attempt, error: message });
      return { requeued: true };
    }
    const resultId = ulid(); const now = nowIso();
    await this.db.run(`INSERT INTO test_results (id, org_id, project_id, run_id, job_id, scenario_id, scenario_version, browser, viewport_json, status, outcome_detail, attempts, duration_ms, started_at, completed_at, failure_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [resultId, run.org_id, run.project_id, run.id, job.id, job.scenario_id, job.scenario_version, job.browser, job.viewport_json, 'infra_error', 'infra_error', job.attempt, null, job.started_at, now, JSON.stringify({ type: kind === 'policy' ? 'policy' : 'infra', message: message.slice(0, 2000) }), now]);
    await this.db.run(`UPDATE run_jobs SET status = 'infra_error', result_id = ?, completed_at = ?, lease_until = NULL, last_error = ? WHERE id = ?`, [resultId, now, message.slice(0, 1000), job.id]);
    this.events.emitRun(run.id, 'job.completed', { jobId: job.id, resultId, scenarioId: job.scenario_id, browser: job.browser, status: 'infra_error', outcomeDetail: 'infra_error' });
    await this.recomputeRun(run.id);
    return { requeued: false, resultId };
  }
  /** Sweeper: expired leases are re-queued (bounded) or marked infra_error. */
  async sweepExpiredLeases() {
    const now = nowIso();
    const rows = await this.db.all<JobRow>(`SELECT * FROM run_jobs WHERE status IN ('leased','running') AND lease_until IS NOT NULL AND lease_until < ? LIMIT 200`, [now]);
    for (const j of rows) await this.infraFail(j, 'runner lease expired (runner crashed or lost connectivity)');
    const stale = await this.db.all<{ id: string }>(`SELECT id FROM runners WHERE status = 'online' AND last_heartbeat_at < ?`, [new Date(Date.now() - 120_000).toISOString()]);
    for (const r of stale) await this.db.run(`UPDATE runners SET status = 'offline' WHERE id = ?`, [r.id]);
    return rows.length;
  }
  async recomputeRun(runId: string) {
    const run = await this.getRow(runId);
    const jobs = await this.jobs(runId);
    const results = await this.db.all<{ status: string; outcome_detail: string }>(`SELECT status, outcome_detail FROM test_results WHERE run_id = ?`, [runId]);
    const counts = { total: jobs.length, queued: jobs.filter((j) => j.status === 'queued').length, running: jobs.filter((j) => j.status === 'leased' || j.status === 'running').length, passed: results.filter((r) => r.status === 'passed' && r.outcome_detail === 'passed_first_try').length, passedAfterRetry: results.filter((r) => r.status === 'passed' && r.outcome_detail === 'passed_after_retry').length, flaky: results.filter((r) => r.status === 'flaky').length, failed: results.filter((r) => r.status === 'failed').length, infraError: results.filter((r) => r.status === 'infra_error').length, skipped: results.filter((r) => r.status === 'skipped').length, cancelled: jobs.filter((j) => j.status === 'cancelled').length };
    const open = counts.queued + counts.running;
    let status: RunStatus = run.status;
    if (run.status !== 'cancelled') {
      if (open > 0) status = (results.length > 0 || counts.running > 0) ? 'running' : 'queued';
      else status = counts.failed > 0 ? 'failed' : counts.infraError > 0 ? 'infra_error' : (counts.flaky + counts.passedAfterRetry) > 0 ? 'flaky' : 'passed';
    }
    const done = open === 0 || run.status === 'cancelled';
    await this.db.run(`UPDATE test_runs SET status = ?, counts_json = ?, completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE completed_at END, updated_at = ? WHERE id = ?`, [status, JSON.stringify(counts), done ? 1 : 0, nowIso(), nowIso(), runId]);
    if (done && !run.completed_at) { const fresh = await this.getRow(runId); this.events.emitRun(runId, 'run.completed', { runId, status, counts }); await this.onRunCompleted?.(fresh); }
    return { status, counts };
  }
  async runnersList(orgId: string) { return this.db.all(`SELECT id, name, capabilities_json, version, last_heartbeat_at, status, self_hosted, allow_private_network, created_at FROM runners WHERE org_id = ? ORDER BY created_at`, [orgId]); }
  async setRunnerPrivate(ctx: Ctx, orgId: string, runnerId: string, allow: boolean) {
    const r = await this.db.run(`UPDATE runners SET allow_private_network = ? WHERE id = ? AND org_id = ?`, [allow ? 1 : 0, runnerId, orgId]);
    if (!r.changes) throw notFound('runner');
    await this.audit.log({ orgId, actor: ctx.actor, action: 'runner.update', targetType: 'runner', targetId: runnerId, after: { allowPrivateNetwork: allow }, ip: ctx.ip });
  }
}
