import type { Db } from '../db/db.js';
import { nowIso, asJson, asBool } from '../db/db.js';
import { ulid, StepsSchema, extractSecretRefs, isStepPotentiallyDestructive, type Step, DEFAULT_MATRIX, type Matrix } from '@proofflow/shared';
import { badRequest, notFound, conflict, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { ProjectService, ProjectRow } from './projects.js';

export interface ScenarioRow { id: string; org_id: string; project_id: string; key: string; title: string; description: string | null; preconditions: string | null; steps_json: string; expected: string | null; priority: string; tags_json: string | null; browsers_json: string | null; data_profile_id: string | null; version: number; status: string; origin: string; destructive: number; created_by: string | null; created_at: string; updated_at: string; }

export function scenarioView(s: ScenarioRow, requirementIds: string[] = []) {
  return { id: s.id, projectId: s.project_id, key: s.key, title: s.title, description: s.description, preconditions: s.preconditions, steps: asJson<Step[]>(s.steps_json, []), expected: s.expected, priority: s.priority, tags: asJson<string[]>(s.tags_json, []), browsers: asJson<string[] | null>(s.browsers_json, null), dataProfileId: s.data_profile_id, version: s.version, status: s.status, origin: s.origin, destructive: asBool(s.destructive), createdBy: s.created_by, createdAt: s.created_at, updatedAt: s.updated_at, requirementIds, secretRefs: extractSecretRefs(asJson<Step[]>(s.steps_json, [])) };
}

export class ScenarioService {
  constructor(private db: Db, private audit: AuditService, private projects: ProjectService) {}

  async list(projectId: string, opts: { status?: string; tag?: string; priority?: string; q?: string; limit?: number; cursor?: string; requirementId?: string } = {}) {
    const where = ['s.project_id = ?']; const params: (string | number)[] = [projectId];
    if (opts.status) { where.push('s.status = ?'); params.push(opts.status); } else { where.push(`s.status <> 'archived'`); }
    if (opts.priority) { where.push('s.priority = ?'); params.push(opts.priority); }
    if (opts.tag) { where.push('s.tags_json LIKE ?'); params.push(`%"${opts.tag.replace(/[%_"]/g, '')}"%`); }
    if (opts.q) { where.push('(s.title LIKE ? OR s.key LIKE ?)'); params.push(`%${opts.q}%`, `%${opts.q}%`); }
    if (opts.requirementId) { where.push('s.id IN (SELECT scenario_id FROM scenario_requirements WHERE requirement_id = ?)'); params.push(opts.requirementId); }
    if (opts.cursor) { where.push('s.id < ?'); params.push(opts.cursor); }
    params.push(Math.min(opts.limit ?? 100, 500));
    const rows = await this.db.all<ScenarioRow>(`SELECT s.* FROM scenarios s WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT ?`, params);
    return Promise.all(rows.map(async (r) => scenarioView(r, await this.requirementIds(r.id))));
  }
  private async requirementIds(scenarioId: string) { return (await this.db.all<{ requirement_id: string }>(`SELECT requirement_id FROM scenario_requirements WHERE scenario_id = ?`, [scenarioId])).map((x) => x.requirement_id); }
  async getRow(id: string, projectId?: string): Promise<ScenarioRow> {
    const s = await this.db.get<ScenarioRow>(`SELECT * FROM scenarios WHERE id = ?`, [id]);
    if (!s || (projectId && s.project_id !== projectId)) throw notFound('scenario');
    return s;
  }
  async get(id: string, projectId: string) { const r = await this.getRow(id, projectId); return scenarioView(r, await this.requirementIds(r.id)); }

  private validateSteps(raw: unknown): Step[] {
    const parsed = StepsSchema.safeParse(raw);
    if (!parsed.success) throw badRequest('invalid steps', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    return parsed.data;
  }
  async create(ctx: Ctx, p: ProjectRow, input: { title: string; description?: string; preconditions?: string; steps: unknown; expected?: string; priority: string; tags?: string[]; browsers?: string[]; dataProfileId?: string; requirementIds?: string[]; destructive?: boolean; status: string; origin?: string; changeReason?: string; fromAiSuggestionId?: string }) {
    const steps = this.validateSteps(input.steps);
    await this.assertRequirements(p.id, input.requirementIds ?? []);
    const id = ulid(); const now = nowIso();
    const key = await this.projects.nextKey(this.db, p.id, 'SCN');
    const destructive = input.destructive ?? steps.some(isStepPotentiallyDestructive);
    await this.db.tx(async (tx) => {
      await tx.run(`INSERT INTO scenarios (id, org_id, project_id, key, title, description, preconditions, steps_json, expected, priority, tags_json, browsers_json, data_profile_id, version, status, origin, destructive, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
        [id, p.org_id, p.id, key, input.title, input.description ?? null, input.preconditions ?? null, JSON.stringify(steps), input.expected ?? null, input.priority, JSON.stringify(input.tags ?? []), input.browsers ? JSON.stringify(input.browsers) : null, input.dataProfileId ?? null, input.status, input.origin ?? 'manual', destructive ? 1 : 0, ctx.actor.id, now, now]);
      await tx.run(`INSERT INTO scenario_versions (id, org_id, scenario_id, version, steps_json, expected, title, changed_by, change_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [ulid(), p.org_id, id, 1, JSON.stringify(steps), input.expected ?? null, input.title, ctx.actor.id, input.changeReason ?? 'created', now]);
      for (const rid of input.requirementIds ?? []) await tx.run(`INSERT INTO scenario_requirements (org_id, scenario_id, requirement_id) VALUES (?,?,?)`, [p.org_id, id, rid]);
      await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'scenario.create', targetType: 'scenario', targetId: id, projectId: p.id, after: { key, title: input.title, stepCount: steps.length, origin: input.origin ?? 'manual', fromAiSuggestionId: input.fromAiSuggestionId ?? null }, ip: ctx.ip }, tx);
    });
    return this.get(id, p.id);
  }
  private async assertRequirements(projectId: string, ids: string[]) {
    for (const rid of ids) { const r = await this.db.get(`SELECT 1 FROM requirements WHERE id = ? AND project_id = ?`, [rid, projectId]); if (!r) throw badRequest(`requirement ${rid} not in project`); }
  }
  async update(ctx: Ctx, p: ProjectRow, s: ScenarioRow, patch: Record<string, unknown>) {
    const before = scenarioView(s);
    const steps = patch.steps !== undefined ? this.validateSteps(patch.steps) : before.steps;
    const expected = patch.expected !== undefined ? (patch.expected as string | null) : before.expected;
    const stepsChanged = JSON.stringify(steps) !== JSON.stringify(before.steps); const expectedChanged = expected !== before.expected; const titleChanged = patch.title !== undefined && patch.title !== before.title;
    const version = stepsChanged || expectedChanged ? s.version + 1 : s.version;
    const next = { title: (patch.title as string) ?? before.title, description: (patch.description as string) ?? before.description, preconditions: (patch.preconditions as string) ?? before.preconditions, priority: (patch.priority as string) ?? before.priority, tags: (patch.tags as string[]) ?? before.tags, browsers: patch.browsers !== undefined ? (patch.browsers as string[] | null) : before.browsers, dataProfileId: (patch.dataProfileId as string) ?? before.dataProfileId, status: (patch.status as string) ?? before.status, destructive: patch.destructive !== undefined ? !!patch.destructive : (stepsChanged ? steps.some(isStepPotentiallyDestructive) : before.destructive) };
    if (patch.requirementIds) await this.assertRequirements(p.id, patch.requirementIds as string[]);
    await this.db.tx(async (tx) => {
      await tx.run(`UPDATE scenarios SET title = ?, description = ?, preconditions = ?, steps_json = ?, expected = ?, priority = ?, tags_json = ?, browsers_json = ?, data_profile_id = ?, version = ?, status = ?, destructive = ?, updated_at = ? WHERE id = ?`,
        [next.title, next.description, next.preconditions, JSON.stringify(steps), expected, next.priority, JSON.stringify(next.tags), next.browsers ? JSON.stringify(next.browsers) : null, next.dataProfileId, version, next.status, next.destructive ? 1 : 0, nowIso(), s.id]);
      if (version !== s.version || titleChanged) await tx.run(`INSERT INTO scenario_versions (id, org_id, scenario_id, version, steps_json, expected, title, changed_by, change_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [ulid(), p.org_id, s.id, version, JSON.stringify(steps), expected, next.title, ctx.actor.id, (patch.changeReason as string) ?? null, nowIso()]);
      if (patch.requirementIds) { await tx.run(`DELETE FROM scenario_requirements WHERE scenario_id = ?`, [s.id]); for (const rid of patch.requirementIds as string[]) await tx.run(`INSERT INTO scenario_requirements (org_id, scenario_id, requirement_id) VALUES (?,?,?)`, [p.org_id, s.id, rid]); }
      await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'scenario.update', targetType: 'scenario', targetId: s.id, projectId: p.id, before: { version: s.version, title: before.title, expected: before.expected, stepCount: before.steps.length, status: before.status }, after: { version, title: next.title, expected, stepCount: steps.length, status: next.status, stepsChanged, expectedChanged, changeReason: patch.changeReason ?? null }, ip: ctx.ip }, tx);
    });
    return this.get(s.id, p.id);
  }
  async versions(scenarioId: string) { return (await this.db.all<{ id: string; version: number; steps_json: string; expected: string | null; title: string | null; changed_by: string | null; change_reason: string | null; created_at: string }>(`SELECT * FROM scenario_versions WHERE scenario_id = ? ORDER BY version DESC`, [scenarioId])).map((v) => ({ id: v.id, version: v.version, steps: asJson<Step[]>(v.steps_json, []), expected: v.expected, title: v.title, changedBy: v.changed_by, changeReason: v.change_reason, createdAt: v.created_at })); }
  async remove(ctx: Ctx, p: ProjectRow, s: ScenarioRow) {
    const used = await this.db.get(`SELECT 1 FROM test_results WHERE scenario_id = ? LIMIT 1`, [s.id]);
    if (used) { await this.db.run(`UPDATE scenarios SET status = 'archived', updated_at = ? WHERE id = ?`, [nowIso(), s.id]); }
    else await this.db.run(`DELETE FROM scenarios WHERE id = ?`, [s.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: used ? 'scenario.archive' : 'scenario.delete', targetType: 'scenario', targetId: s.id, projectId: p.id, before: { key: s.key, title: s.title }, ip: ctx.ip });
  }

  // ---------- Suites ----------
  async suites(projectId: string) {
    const rows = await this.db.all<{ id: string; project_id: string; name: string; kind: string; description: string | null; matrix_json: string | null; required_for_release: number; created_at: string; updated_at: string }>(`SELECT * FROM suites WHERE project_id = ? ORDER BY name`, [projectId]);
    return Promise.all(rows.map((r) => this.suiteView(r)));
  }
  private async suiteView(r: { id: string; project_id: string; name: string; kind: string; description: string | null; matrix_json: string | null; required_for_release: number; created_at: string; updated_at: string }) {
    const ids = (await this.db.all<{ scenario_id: string }>(`SELECT scenario_id FROM suite_scenarios WHERE suite_id = ? ORDER BY order_index`, [r.id])).map((x) => x.scenario_id);
    return { id: r.id, projectId: r.project_id, name: r.name, kind: r.kind, description: r.description, matrix: asJson<Matrix>(r.matrix_json, DEFAULT_MATRIX), requiredForRelease: asBool(r.required_for_release), scenarioIds: ids, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  async getSuite(id: string, projectId: string) {
    const r = await this.db.get<{ id: string; project_id: string; name: string; kind: string; description: string | null; matrix_json: string | null; required_for_release: number; created_at: string; updated_at: string }>(`SELECT * FROM suites WHERE id = ? AND project_id = ?`, [id, projectId]);
    if (!r) throw notFound('suite');
    return this.suiteView(r);
  }
  async createSuite(ctx: Ctx, p: ProjectRow, input: { name: string; kind: string; description?: string; matrix?: Matrix; scenarioIds?: string[]; requiredForRelease?: boolean }) {
    if (await this.db.get(`SELECT 1 FROM suites WHERE project_id = ? AND name = ?`, [p.id, input.name])) throw conflict('suite name exists');
    const id = ulid(); const now = nowIso();
    await this.db.run(`INSERT INTO suites (id, org_id, project_id, name, kind, description, matrix_json, required_for_release, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, input.name, input.kind, input.description ?? null, JSON.stringify(input.matrix ?? DEFAULT_MATRIX), input.requiredForRelease ? 1 : 0, ctx.actor.id, now, now]);
    await this.setSuiteScenarios(p, id, input.scenarioIds ?? []);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'suite.create', targetType: 'suite', targetId: id, projectId: p.id, after: { name: input.name, kind: input.kind, scenarioCount: input.scenarioIds?.length ?? 0 }, ip: ctx.ip });
    return this.getSuite(id, p.id);
  }
  private async setSuiteScenarios(p: ProjectRow, suiteId: string, ids: string[]) {
    for (const sid of ids) { const s = await this.db.get(`SELECT 1 FROM scenarios WHERE id = ? AND project_id = ?`, [sid, p.id]); if (!s) throw badRequest(`scenario ${sid} not in project`); }
    await this.db.run(`DELETE FROM suite_scenarios WHERE suite_id = ?`, [suiteId]);
    let i = 0; for (const sid of ids) await this.db.run(`INSERT INTO suite_scenarios (org_id, suite_id, scenario_id, order_index) VALUES (?,?,?,?)`, [p.org_id, suiteId, sid, i++]);
  }
  async updateSuite(ctx: Ctx, p: ProjectRow, suiteId: string, patch: { name?: string; kind?: string; description?: string; matrix?: Matrix; scenarioIds?: string[]; requiredForRelease?: boolean }) {
    const before = await this.getSuite(suiteId, p.id);
    await this.db.run(`UPDATE suites SET name = ?, kind = ?, description = ?, matrix_json = ?, required_for_release = ?, updated_at = ? WHERE id = ?`, [patch.name ?? before.name, patch.kind ?? before.kind, patch.description ?? before.description, JSON.stringify(patch.matrix ?? before.matrix), (patch.requiredForRelease ?? before.requiredForRelease) ? 1 : 0, nowIso(), suiteId]);
    if (patch.scenarioIds) await this.setSuiteScenarios(p, suiteId, patch.scenarioIds);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'suite.update', targetType: 'suite', targetId: suiteId, projectId: p.id, before: { name: before.name, scenarioCount: before.scenarioIds.length, matrix: before.matrix }, after: { name: patch.name ?? before.name, scenarioCount: patch.scenarioIds?.length ?? before.scenarioIds.length, matrix: patch.matrix ?? before.matrix }, ip: ctx.ip });
    return this.getSuite(suiteId, p.id);
  }
  async deleteSuite(ctx: Ctx, p: ProjectRow, suiteId: string) {
    const s = await this.getSuite(suiteId, p.id);
    await this.db.run(`DELETE FROM suites WHERE id = ?`, [suiteId]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'suite.delete', targetType: 'suite', targetId: suiteId, projectId: p.id, before: { name: s.name }, ip: ctx.ip });
  }

  // ---------- Test data profiles ----------
  async dataProfiles(projectId: string) { return (await this.db.all<{ id: string; name: string; kind: string; data_json: string | null; cleanup_json: string | null; created_at: string }>(`SELECT * FROM test_data_profiles WHERE project_id = ? ORDER BY name`, [projectId])).map((r) => ({ id: r.id, name: r.name, kind: r.kind, data: asJson<Record<string, unknown>>(r.data_json, {}), cleanup: asJson<unknown[]>(r.cleanup_json, []), createdAt: r.created_at })); }
  async putDataProfile(ctx: Ctx, p: ProjectRow, input: { id?: string; name: string; kind: string; data: Record<string, unknown>; cleanup?: unknown[] }) {
    // Real personal information must not be used as test data: reject obvious email domains / card numbers heuristically.
    const json = JSON.stringify(input.data);
    if (/\b[0-9]{13,19}\b/.test(json)) throw badRequest('test data must not contain card-like numbers (use fake data)');
    if (/@(gmail|yahoo|outlook|hotmail|icloud)\.com\b/i.test(json)) throw badRequest('test data must not contain real-looking personal email addresses (use example.com / mailinator-style fake addresses)');
    const now = nowIso();
    const id = input.id ?? ulid();
    const existing = input.id ? await this.db.get(`SELECT 1 FROM test_data_profiles WHERE id = ? AND project_id = ?`, [id, p.id]) : null;
    if (existing) await this.db.run(`UPDATE test_data_profiles SET name = ?, kind = ?, data_json = ?, cleanup_json = ?, updated_at = ? WHERE id = ?`, [input.name, input.kind, json, JSON.stringify(input.cleanup ?? []), now, id]);
    else await this.db.run(`INSERT INTO test_data_profiles (id, org_id, project_id, name, kind, data_json, cleanup_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, input.name, input.kind, json, JSON.stringify(input.cleanup ?? []), now, now]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: existing ? 'data_profile.update' : 'data_profile.create', targetType: 'test_data_profile', targetId: id, projectId: p.id, after: { name: input.name, kind: input.kind }, ip: ctx.ip });
    return { id };
  }
  async resolveDataProfile(projectId: string, id: string | null): Promise<Record<string, unknown>> {
    if (!id) return {};
    const r = await this.db.get<{ data_json: string | null }>(`SELECT data_json FROM test_data_profiles WHERE id = ? AND project_id = ?`, [id, projectId]);
    return asJson<Record<string, unknown>>(r?.data_json, {});
  }
}
