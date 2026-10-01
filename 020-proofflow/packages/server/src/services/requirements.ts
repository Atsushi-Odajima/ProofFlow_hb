import type { Db } from '../db/db.js';
import { nowIso, asJson } from '../db/db.js';
import { ulid } from '@proofflow/shared';
import { notFound, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { ProjectService, ProjectRow } from './projects.js';

export interface RequirementRow { id: string; org_id: string; project_id: string; key: string; title: string; description: string | null; priority: string; source: string | null; owner_user_id: string | null; status: string; created_by: string | null; created_at: string; updated_at: string; }
interface AcInput { format: 'gwt' | 'text'; given?: string; when?: string; then?: string; text?: string; }

export class RequirementService {
  constructor(private db: Db, private audit: AuditService, private projects: ProjectService) {}

  private async withAc(r: RequirementRow) {
    const ac = await this.db.all<{ id: string; order_index: number; format: string; given: string | null; when_: string | null; then_: string | null; text: string | null }>(`SELECT * FROM acceptance_criteria WHERE requirement_id = ? ORDER BY order_index`, [r.id]);
    const links = await this.db.all<{ scenario_id: string }>(`SELECT scenario_id FROM scenario_requirements WHERE requirement_id = ? ORDER BY scenario_id`, [r.id]);
    return { id: r.id, projectId: r.project_id, key: r.key, title: r.title, description: r.description, priority: r.priority, source: r.source, ownerUserId: r.owner_user_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
      acceptanceCriteria: ac.map((a) => ({ id: a.id, format: a.format, given: a.given, when: a.when_, then: a.then_, text: a.text })), scenarioIds: links.map((l) => l.scenario_id) };
  }
  async list(projectId: string, opts: { status?: string; limit?: number; cursor?: string } = {}) {
    const where = ['project_id = ?']; const params: (string | number)[] = [projectId];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.cursor) { where.push('id < ?'); params.push(opts.cursor); }
    params.push(Math.min(opts.limit ?? 100, 500));
    const rows = await this.db.all<RequirementRow>(`SELECT * FROM requirements WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params);
    return Promise.all(rows.map((r) => this.withAc(r)));
  }
  async getRow(id: string, projectId: string): Promise<RequirementRow> {
    const r = await this.db.get<RequirementRow>(`SELECT * FROM requirements WHERE id = ? AND project_id = ?`, [id, projectId]);
    if (!r) throw notFound('requirement');
    return r;
  }
  async get(id: string, projectId: string) { return this.withAc(await this.getRow(id, projectId)); }
  async create(ctx: Ctx, p: ProjectRow, input: { title: string; description?: string; priority: string; source?: string; ownerUserId?: string; status: string; acceptanceCriteria?: AcInput[] }) {
    const id = ulid(); const now = nowIso();
    const key = await this.projects.nextKey(this.db, p.id, 'REQ');
    await this.db.run(`INSERT INTO requirements (id, org_id, project_id, key, title, description, priority, source, owner_user_id, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, key, input.title, input.description ?? null, input.priority, input.source ?? null, input.ownerUserId ?? null, input.status, ctx.actor.id, now, now]);
    await this.replaceAc(p.org_id, id, input.acceptanceCriteria ?? []);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'requirement.create', targetType: 'requirement', targetId: id, projectId: p.id, after: { key, title: input.title, priority: input.priority }, ip: ctx.ip });
    return this.get(id, p.id);
  }
  private async replaceAc(orgId: string, requirementId: string, ac: AcInput[]) {
    await this.db.run(`DELETE FROM acceptance_criteria WHERE requirement_id = ?`, [requirementId]);
    let i = 0;
    for (const a of ac) await this.db.run(`INSERT INTO acceptance_criteria (id, org_id, requirement_id, order_index, format, given, when_, then_, text) VALUES (?,?,?,?,?,?,?,?,?)`, [ulid(), orgId, requirementId, i++, a.format ?? 'gwt', a.given ?? null, a.when ?? null, a.then ?? null, a.text ?? null]);
  }
  async update(ctx: Ctx, p: ProjectRow, r: RequirementRow, patch: Partial<{ title: string; description: string; priority: string; source: string; ownerUserId: string; status: string; acceptanceCriteria: AcInput[] }>) {
    const next = { title: patch.title ?? r.title, description: patch.description ?? r.description, priority: patch.priority ?? r.priority, source: patch.source ?? r.source, ownerUserId: patch.ownerUserId ?? r.owner_user_id, status: patch.status ?? r.status };
    await this.db.run(`UPDATE requirements SET title = ?, description = ?, priority = ?, source = ?, owner_user_id = ?, status = ?, updated_at = ? WHERE id = ?`, [next.title, next.description, next.priority, next.source, next.ownerUserId, next.status, nowIso(), r.id]);
    if (patch.acceptanceCriteria) await this.replaceAc(p.org_id, r.id, patch.acceptanceCriteria);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'requirement.update', targetType: 'requirement', targetId: r.id, projectId: p.id, before: { title: r.title, status: r.status, priority: r.priority }, after: { title: next.title, status: next.status, priority: next.priority, acChanged: !!patch.acceptanceCriteria }, ip: ctx.ip });
    return this.get(r.id, p.id);
  }
  async remove(ctx: Ctx, p: ProjectRow, r: RequirementRow) {
    await this.db.run(`DELETE FROM requirements WHERE id = ?`, [r.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'requirement.delete', targetType: 'requirement', targetId: r.id, projectId: p.id, before: { key: r.key, title: r.title }, ip: ctx.ip });
  }
  /** Traceability: requirement → scenarios → latest results → defects. */
  async traceability(projectId: string, requirementId: string) {
    const r = await this.get(requirementId, projectId);
    const scenarios = await this.db.all<{ id: string; key: string; title: string; status: string }>(`SELECT s.id, s.key, s.title, s.status FROM scenarios s JOIN scenario_requirements sr ON sr.scenario_id = s.id WHERE sr.requirement_id = ?`, [requirementId]);
    const out = [] as Array<Record<string, unknown>>;
    for (const s of scenarios) {
      const results = await this.db.all<{ id: string; run_id: string; status: string; outcome_detail: string; browser: string; completed_at: string | null }>(`SELECT id, run_id, status, outcome_detail, browser, completed_at FROM test_results WHERE scenario_id = ? ORDER BY id DESC LIMIT 10`, [s.id]);
      const defects = await this.db.all<{ id: string; key: string; title: string; status: string; severity: string }>(`SELECT d.id, d.key, d.title, d.status, d.severity FROM defects d JOIN defect_links l ON l.defect_id = d.id WHERE l.target_type = 'scenario' AND l.target_id = ?`, [s.id]);
      out.push({ scenario: s, latestResults: results, defects });
    }
    const manual = await this.db.all<{ id: string; key: string; title: string }>(`SELECT m.id, m.key, m.title FROM manual_cases m JOIN manual_case_requirements r ON r.manual_case_id = m.id WHERE r.requirement_id = ?`, [requirementId]);
    const reqDefects = await this.db.all<{ id: string; key: string; title: string; status: string; severity: string }>(`SELECT d.id, d.key, d.title, d.status, d.severity FROM defects d JOIN defect_links l ON l.defect_id = d.id WHERE l.target_type = 'requirement' AND l.target_id = ?`, [requirementId]);
    return { requirement: r, scenarios: out, manualCases: manual, defects: reqDefects };
  }
  async countForProject(projectId: string) { return Number((await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM requirements WHERE project_id = ?`, [projectId]))?.c ?? 0); }
  parseJson = asJson;
}
