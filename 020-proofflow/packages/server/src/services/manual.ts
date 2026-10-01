import type { Db } from '../db/db.js';
import { nowIso, asJson } from '../db/db.js';
import { ulid } from '@proofflow/shared';
import { badRequest, notFound, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { ProjectService, ProjectRow } from './projects.js';
import type { ArtifactService } from './artifacts.js';
import type { Readable } from 'node:stream';

export interface SessionView { id: string; charter: string; environment_id: string | null; tester_user_id: string; started_at: string; ended_at: string | null; duration_min: number | null; notes: string | null; ai_summary: string | null; status: string; artifactIds: string[]; defectIds: string[]; [k: string]: unknown; }

/** Manual test cases, device check results (real iPhone/Android, Bluetooth, camera, push, share, payment sandbox, email, human visual judgement) and exploratory sessions. */
export class ManualService {
  constructor(private db: Db, private audit: AuditService, private projects: ProjectService, private artifacts: ArtifactService) {}

  async cases(projectId: string) {
    const rows = await this.db.all<{ id: string; key: string; title: string; category: string; label: string | null; description: string | null; steps: string | null; expected: string | null; created_at: string }>(`SELECT * FROM manual_cases WHERE project_id = ? ORDER BY key`, [projectId]);
    return Promise.all(rows.map(async (r) => ({ id: r.id, key: r.key, title: r.title, category: r.category, label: r.label, description: r.description, steps: r.steps, expected: r.expected, createdAt: r.created_at, requirementIds: (await this.db.all<{ requirement_id: string }>(`SELECT requirement_id FROM manual_case_requirements WHERE manual_case_id = ?`, [r.id])).map((x) => x.requirement_id) })));
  }
  async createCase(ctx: Ctx, p: ProjectRow, input: { title: string; category: string; description?: string; steps?: string; expected?: string; requirementIds?: string[]; label?: string }) {
    const id = ulid(); const now = nowIso(); const key = await this.projects.nextKey(this.db, p.id, 'MC');
    await this.db.run(`INSERT INTO manual_cases (id, org_id, project_id, key, title, category, label, description, steps, expected, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, key, input.title, input.category, input.label ?? null, input.description ?? null, input.steps ?? null, input.expected ?? null, ctx.actor.id, now, now]);
    for (const rid of input.requirementIds ?? []) { if (!(await this.db.get(`SELECT 1 FROM requirements WHERE id = ? AND project_id = ?`, [rid, p.id]))) throw badRequest(`requirement ${rid} not in project`); await this.db.run(`INSERT INTO manual_case_requirements (org_id, manual_case_id, requirement_id) VALUES (?,?,?)`, [p.org_id, id, rid]); }
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'manual_case.create', targetType: 'manual_case', targetId: id, projectId: p.id, after: { key, title: input.title, category: input.category }, ip: ctx.ip });
    return { id, key };
  }
  async checks(projectId: string, opts: { releaseCandidateId?: string; limit?: number } = {}) {
    const rows = opts.releaseCandidateId ? await this.db.all(`SELECT * FROM manual_check_results WHERE project_id = ? AND release_candidate_id = ? ORDER BY performed_at DESC LIMIT ?`, [projectId, opts.releaseCandidateId, Math.min(opts.limit ?? 100, 500)]) : await this.db.all(`SELECT * FROM manual_check_results WHERE project_id = ? ORDER BY performed_at DESC LIMIT ?`, [projectId, Math.min(opts.limit ?? 100, 500)]);
    return rows.map((r) => ({ ...r, artifact_ids_json: undefined, artifactIds: asJson<string[]>(r.artifact_ids_json as string | null, []) }));
  }
  async recordCheck(ctx: Ctx, p: ProjectRow, input: { manualCaseId?: string; releaseCandidateId?: string; runId?: string; label?: string; device: string; osVersion?: string; browser?: string; performedAt?: string; result: string; notes?: string; artifactIds?: string[]; defectId?: string }) {
    if (!ctx.actor.userId && ctx.actor.kind !== 'user') throw badRequest('manual checks must be recorded by a human tester');
    if (input.manualCaseId && !(await this.db.get(`SELECT 1 FROM manual_cases WHERE id = ? AND project_id = ?`, [input.manualCaseId, p.id]))) throw badRequest('manual case not in project');
    if (input.releaseCandidateId && !(await this.db.get(`SELECT 1 FROM release_candidates WHERE id = ? AND project_id = ?`, [input.releaseCandidateId, p.id]))) throw badRequest('release candidate not in project');
    for (const aid of input.artifactIds ?? []) { const a = await this.artifacts.getRow(aid); if (!a || a.project_id !== p.id) throw badRequest(`artifact ${aid} not in project`); }
    const id = ulid(); const now = nowIso();
    await this.db.run(`INSERT INTO manual_check_results (id, org_id, project_id, manual_case_id, release_candidate_id, run_id, label, device, os_version, browser, tester_user_id, performed_at, result, notes, artifact_ids_json, defect_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, input.manualCaseId ?? null, input.releaseCandidateId ?? null, input.runId ?? null, input.label ?? null, input.device, input.osVersion ?? null, input.browser ?? null, ctx.actor.userId ?? ctx.actor.id, input.performedAt ?? now, input.result, input.notes ?? null, JSON.stringify(input.artifactIds ?? []), input.defectId ?? null, now]);
    if (input.artifactIds?.length) await this.artifacts.setRetentionClass(input.artifactIds, 'manual');
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'manual_check.record', targetType: 'manual_check', targetId: id, projectId: p.id, after: { label: input.label ?? null, device: input.device, result: input.result, releaseCandidateId: input.releaseCandidateId ?? null }, ip: ctx.ip });
    return { id, performedAt: input.performedAt ?? now };
  }
  async uploadEvidence(ctx: Ctx, p: ProjectRow, label: string, contentType: string, body: Readable | Buffer) {
    if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime)|application\/pdf|text\/plain)$/.test(contentType)) throw badRequest('evidence must be an image, video, PDF or text file');
    return this.artifacts.create({ orgId: p.org_id, projectId: p.id, kind: 'manual_evidence', label, contentType, body, retentionClass: 'manual', createdBy: ctx.actor.id, maxBytes: 100 * 1024 * 1024 });
  }
  /** Manual accessibility / device checklist templates (automated checks cannot cover these). */
  checklist() {
    return {
      accessibility: ['キーボードのみで全操作が完了できる', 'フォーカス順序と可視フォーカス', 'スクリーンリーダーでフォーム・エラーが読み上げられる', '200% ズームでレイアウト崩れがない', '色だけで情報を伝えていない', '動画・音声に代替テキスト/字幕', 'エラーメッセージが具体的で近接している'],
      device: ['実機 iPhone Safari（ズーム、スクロール、キーボード、戻る）', '実機 Android Chrome', 'ネイティブ共有・ファイル選択・カメラ', 'プッシュ通知の受信と遷移', 'Bluetooth 接続', '決済サンドボックス（本番決済は行わない）', 'メール配信（受信・リンク・文面）', '人間による見た目の最終判断'],
    };
  }
  // ---------- exploratory ----------
  async sessions(projectId: string) { return (await this.db.all(`SELECT * FROM exploratory_sessions WHERE project_id = ? ORDER BY id DESC LIMIT 200`, [projectId])).map((r) => ({ ...r, artifactIds: asJson<string[]>(r.artifact_ids_json as string | null, []), defectIds: asJson<string[]>(r.defect_ids_json as string | null, []), artifact_ids_json: undefined, defect_ids_json: undefined })); }
  async getSession(id: string, projectId: string): Promise<SessionView> {
    const r = await this.db.get<Record<string, unknown>>(`SELECT * FROM exploratory_sessions WHERE id = ? AND project_id = ?`, [id, projectId]);
    if (!r) throw notFound('exploratory session');
    return { ...r, artifactIds: asJson<string[]>(r.artifact_ids_json as string | null, []), defectIds: asJson<string[]>(r.defect_ids_json as string | null, []), artifact_ids_json: undefined, defect_ids_json: undefined } as unknown as SessionView;
  }
  async createSession(ctx: Ctx, p: ProjectRow, input: { environmentId?: string; charter: string; startedAt?: string; endedAt?: string; durationMin?: number; notes?: string; artifactIds?: string[]; defectIds?: string[] }) {
    const id = ulid(); const now = nowIso();
    await this.db.run(`INSERT INTO exploratory_sessions (id, org_id, project_id, environment_id, charter, tester_user_id, started_at, ended_at, duration_min, notes, artifact_ids_json, defect_ids_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, input.environmentId ?? null, input.charter, ctx.actor.userId ?? ctx.actor.id, input.startedAt ?? now, input.endedAt ?? null, input.durationMin ?? null, input.notes ?? null, JSON.stringify(input.artifactIds ?? []), JSON.stringify(input.defectIds ?? []), input.endedAt ? 'closed' : 'open', now, now]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'exploratory.create', targetType: 'exploratory_session', targetId: id, projectId: p.id, after: { charter: input.charter.slice(0, 200) }, ip: ctx.ip });
    return this.getSession(id, p.id);
  }
  async updateSession(ctx: Ctx, p: ProjectRow, id: string, patch: Record<string, unknown>) {
    const cur = await this.getSession(id, p.id);
    const next = { charter: (patch.charter as string) ?? cur.charter, endedAt: (patch.endedAt as string) ?? cur.ended_at, durationMin: (patch.durationMin as number) ?? cur.duration_min, notes: (patch.notes as string) ?? cur.notes, artifactIds: [...new Set([...(cur.artifactIds as string[]), ...((patch.artifactIds as string[]) ?? [])])], defectIds: [...new Set([...(cur.defectIds as string[]), ...((patch.defectIds as string[]) ?? [])])], status: (patch.status as string) ?? (patch.endedAt ? 'closed' : cur.status), aiSummary: (patch.aiSummary as string) ?? cur.ai_summary };
    await this.db.run(`UPDATE exploratory_sessions SET charter = ?, ended_at = ?, duration_min = ?, notes = ?, artifact_ids_json = ?, defect_ids_json = ?, status = ?, ai_summary = ?, updated_at = ? WHERE id = ?`, [next.charter, next.endedAt, next.durationMin, next.notes, JSON.stringify(next.artifactIds), JSON.stringify(next.defectIds), next.status, next.aiSummary, nowIso(), id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'exploratory.update', targetType: 'exploratory_session', targetId: id, projectId: p.id, after: { status: next.status, defects: next.defectIds.length }, ip: ctx.ip });
    return this.getSession(id, p.id);
  }
}
