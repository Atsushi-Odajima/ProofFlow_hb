/**
 * ProofFlow 不具合報告 (merged from ErrorRelay): turns end-user / tester error reports into ProofFlow Defects.
 *
 * - ProofFlow 個人情報マスク (ErrorRelay privacy scanner + redaction) is applied on the server BEFORE anything is stored:
 *   report text, environment values, attachment file names and text attachments. Images are re-written without EXIF / text chunks.
 *   High-risk categories (keys, tokens, passwords, OTP, cards) are always masked, whatever the reporter chose.
 * - Submission is idempotent per project (client-generated key, UNIQUE(project_id, idempotency_key)).
 * - External reporters use a per-project intake (token hashed with sha256, hourly cap). They never see existing defects.
 */
import type { Readable } from 'node:stream';
import type { Db } from '../db/db.js';
import { nowIso, asJson } from '../db/db.js';
import { ulid, randomToken, bugreport as br } from '@proofflow/shared';
import { badRequest, conflict, notFound, HttpError, type Ctx, type Actor } from '../context.js';
import { sha256, safeEqual } from '../crypto.js';
import type { AuditService } from './audit.js';
import type { ProjectRow } from './projects.js';
import type { ArtifactService } from './artifacts.js';
import type { DefectService, DefectRow } from './defects.js';

export interface IntakeRow { id: string; org_id: string; project_id: string; name: string; token_hash: string; token_prefix: string; default_severity: string; default_priority: string; release_candidate_id: string | null; environment_id: string | null; max_per_hour: number; last_used_at: string | null; created_by: string | null; created_at: string; revoked_at: string | null; }
export interface BugReportRow { id: string; org_id: string; project_id: string; key: string; source: string; intake_id: string | null; idempotency_key: string; status: string; title: string; language: string; release_candidate_id: string | null; environment_id: string | null; defect_id: string | null; content_json: string; redaction_json: string; findings_json: string | null; similar_json: string | null; attachment_ids_json: string | null; report_ja: string; report_en: string; reporter_kind: string; reporter_id: string | null; created_at: string; updated_at: string; }
interface AttachmentRow { artifact_id: string; org_id: string; project_id: string; bug_report_id: string | null; intake_id: string | null; uploaded_by: string | null; file_name: string; content_type: string; processing_json: string | null; created_at: string; }

export type SubmitInput = Omit<br.BugReportContent, 'environment'> & { environment: Partial<Record<br.EnvKey, br.EnvField>>; idempotencyKey: string; attachmentIds: string[]; decisions: Record<string, 'redact' | 'keep'>; releaseCandidateId?: string; environmentId?: string; severity?: string; priority?: string; existingDefectId?: string };
export type PreviewInput = Omit<SubmitInput, 'idempotencyKey' | 'attachmentIds' | 'releaseCandidateId' | 'environmentId' | 'severity' | 'priority' | 'existingDefectId'>;

const OPEN_DEFECT = ['new', 'triaged', 'in_progress', 'ready_for_retest', 'reopened'];
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'application/json']);
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const intakeView = (i: IntakeRow) => ({ id: i.id, projectId: i.project_id, name: i.name, tokenPrefix: i.token_prefix, defaultSeverity: i.default_severity, defaultPriority: i.default_priority, releaseCandidateId: i.release_candidate_id, environmentId: i.environment_id, maxPerHour: Number(i.max_per_hour), lastUsedAt: i.last_used_at, createdAt: i.created_at, revokedAt: i.revoked_at, formPath: `/intake/${i.id}` });
export const bugReportView = (r: BugReportRow) => ({ id: r.id, projectId: r.project_id, key: r.key, source: r.source, intakeId: r.intake_id, status: r.status, title: r.title, language: r.language, releaseCandidateId: r.release_candidate_id, environmentId: r.environment_id, defectId: r.defect_id, redaction: asJson<br.RedactionSummary | null>(r.redaction_json, null), similar: asJson<Array<{ defectId: string; key: string; title: string; status: string; similarity: number }>>(r.similar_json, []), attachmentIds: asJson<string[]>(r.attachment_ids_json, []), reporterKind: r.reporter_kind, createdAt: r.created_at, updatedAt: r.updated_at });

function toContent(i: PreviewInput): br.BugReportContent {
  const env = br.emptyEnvironment();
  for (const k of br.ENV_KEYS) { const f = i.environment?.[k]; if (f && f.value != null && f.value !== '') env[k] = f; }
  return { title: i.title, description: i.description, expected: i.expected, actual: i.actual, steps: i.steps.map((s) => s.trim()).filter(Boolean), errorText: i.errorText, frequency: i.frequency, occurredAt: i.occurredAt, environment: env, reporterName: i.reporterName, additionalNotes: i.additionalNotes, language: i.language };
}
/** Mask the file name first (it may carry an e-mail / user name), then reduce it to safe characters. */
function safeFileName(name: string): { fileName: string; masked: boolean } {
  const scan = br.redactText(name.split(/[\\/]/).pop() ?? '');
  const base = scan.redacted.replace(/[^\p{L}\p{N}._ \[\]-]+/gu, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return { fileName: base || 'attachment', masked: scan.findings.length > 0 };
}
async function readLimited(body: Readable | Buffer, max: number): Promise<Buffer> {
  if (Buffer.isBuffer(body)) { if (body.length > max) throw new HttpError(413, 'too_large', `attachment exceeds ${max} bytes`); return body; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of body) { const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array); size += b.length; if (size > max) throw new HttpError(413, 'too_large', `attachment exceeds ${max} bytes`); chunks.push(b); }
  return Buffer.concat(chunks);
}

export class BugReportService {
  constructor(private db: Db, private audit: AuditService, private artifacts: ArtifactService, private defects: DefectService, private nextKey: (db: Db, projectId: string, prefix: string) => Promise<string>) {}

  // ---------------- preview (no storage) ----------------
  /** Masked preview + generated ja/en report + quality checklist. `withSimilar` only for internal users (defect:read). */
  async preview(p: ProjectRow, input: PreviewInput, opts: { withSimilar: boolean }) {
    const s = br.sanitizeReport(toContent(input), input.decisions as br.Decisions);
    const reports = { ja: br.generateDetailed(s.content, 'ja', { redaction: s.summary }), en: br.generateDetailed(s.content, 'en', { redaction: s.summary }) };
    return { content: s.content, findings: s.findings, redaction: s.summary, quality: br.checkReportQuality(s.content), report: reports, similar: opts.withSimilar ? await this.similarOpenDefects(p.id, s.content) : [], disclaimer: br.SCANNER_DISCLAIMER, imageChecklist: br.IMAGE_MANUAL_CHECKLIST };
  }

  /** Known-issue hinting: similar OPEN defects in the project (never auto-merged). */
  async similarOpenDefects(projectId: string, c: br.BugReportContent, limit = 5) {
    const clean = (x: string) => x.replace(/\[REDACTED_[A-Z_]+_\d+\]/g, ' ');
    const title = clean(c.title); const q = clean([c.title, c.actual, c.errorText.split('\n')[0] ?? ''].join(' '));
    const rows = await this.db.all<{ id: string; key: string; title: string; status: string; actual: string | null }>(`SELECT id, key, title, status, actual FROM defects WHERE project_id = ? AND status IN (${OPEN_DEFECT.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 300`, [projectId, ...OPEN_DEFECT]);
    return rows.map((d) => ({ defectId: d.id, key: d.key, title: d.title, status: d.status, similarity: Number(Math.max(br.similarity(title, d.title), br.similarity(q, `${d.title} ${d.actual ?? ''}`)).toFixed(2)) }))
      .filter((x) => x.similarity >= 0.3).sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  // ---------------- attachments ----------------
  async uploadAttachment(ctx: Ctx, p: ProjectRow, input: { fileName: string; contentType: string; body: Readable | Buffer; intake?: IntakeRow }) {
    const ct = input.contentType.toLowerCase();
    if (!IMAGE_TYPES.has(ct) && !TEXT_TYPES.has(ct)) throw badRequest('attachment must be PNG / JPEG or a text file (text/plain, text/csv, application/json)');
    if (input.intake) await this.assertIntakeQuota(input.intake, 'attachment');
    let bytes = await readLimited(input.body, MAX_ATTACHMENT_BYTES);
    if (bytes.length === 0) throw badRequest('empty attachment');
    const { fileName, masked } = safeFileName(input.fileName);
    const processing: Record<string, unknown> = { fileNameRedacted: masked };
    let kind: 'screenshot' | 'attachment';
    if (IMAGE_TYPES.has(ct)) {
      const t = br.detectImageType(bytes);
      if ((ct === 'image/png' && t !== 'png') || (ct === 'image/jpeg' && t !== 'jpeg')) throw badRequest('image content does not match its content type');
      const r = br.stripImageMetadata(bytes);
      bytes = Buffer.from(r.bytes); processing.metadataRemoved = r.removed; processing.metadataSupported = r.supported;
      kind = 'screenshot';
    } else {
      const text = bytes.toString('utf8');
      const r = br.redactText(text);
      bytes = Buffer.from(r.redacted, 'utf8'); processing.redaction = r.summary.counts;
      kind = 'attachment';
    }
    const a = await this.artifacts.create({ orgId: p.org_id, projectId: p.id, kind, label: fileName, contentType: ct, body: bytes, retentionClass: 'failed', createdBy: ctx.actor.id, maxBytes: MAX_ATTACHMENT_BYTES });
    await this.db.run(`INSERT INTO bug_report_attachments (artifact_id, org_id, project_id, bug_report_id, intake_id, uploaded_by, file_name, content_type, processing_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [a.id, p.org_id, p.id, null, input.intake?.id ?? null, ctx.actor.id, fileName, ct, JSON.stringify(processing), nowIso()]);
    return { id: a.id, fileName, contentType: ct, sizeBytes: a.sizeBytes, sha256: a.sha256, kind, processing };
  }

  // ---------------- submit ----------------
  async submit(ctx: Ctx, p: ProjectRow, input: SubmitInput, opts: { intake?: IntakeRow } = {}) {
    const intake = opts.intake;
    const existing = await this.db.get<BugReportRow>(`SELECT * FROM bug_reports WHERE project_id = ? AND idempotency_key = ?`, [p.id, input.idempotencyKey]);
    if (existing) return this.replay(ctx, existing, intake);
    if (intake) await this.assertIntakeQuota(intake, 'report');

    // Ownership / tenant checks before anything is written.
    const attIds = [...new Set(input.attachmentIds)];
    const atts = attIds.length ? await this.db.all<AttachmentRow>(`SELECT * FROM bug_report_attachments WHERE artifact_id IN (${attIds.map(() => '?').join(',')}) AND project_id = ? AND bug_report_id IS NULL`, [...attIds, p.id]) : [];
    for (const a of atts) { if (intake ? a.intake_id !== intake.id : a.intake_id !== null || a.uploaded_by !== ctx.actor.id) throw badRequest(`attachment ${a.artifact_id} was not uploaded by this reporter`); }
    if (atts.length !== attIds.length) throw badRequest('unknown or already used attachment id');
    const rcId = intake ? intake.release_candidate_id : input.releaseCandidateId ?? null;
    const envId = intake ? intake.environment_id : input.environmentId ?? null;
    if (rcId && !(await this.db.get(`SELECT 1 FROM release_candidates WHERE id = ? AND project_id = ?`, [rcId, p.id]))) throw badRequest('release candidate not in project');
    if (envId && !(await this.db.get(`SELECT 1 FROM environments WHERE id = ? AND project_id = ?`, [envId, p.id]))) throw badRequest('environment not in project');
    let target: DefectRow | null = null;
    if (!intake && input.existingDefectId) target = await this.defects.getRow(input.existingDefectId, p.id).catch(() => { throw badRequest('defect not in project'); });

    // ProofFlow 個人情報マスク — nothing below this line sees unmasked text.
    const s = br.sanitizeReport(toContent(input), input.decisions as br.Decisions);
    const c = s.content;
    const similar = await this.similarOpenDefects(p.id, c);
    const now = nowIso();
    const refs = atts.map((a) => ({ fileName: a.file_name, redacted: true }));
    const reportJa = br.generateDetailed(c, 'ja', { attachments: refs, reportedAt: now, redaction: s.summary });
    const reportEn = br.generateDetailed(c, 'en', { attachments: refs, reportedAt: now, redaction: s.summary });
    const leaks = br.containsAnyOriginal(JSON.stringify(c) + reportJa + reportEn, s.raw);
    if (leaks.length) throw new HttpError(500, 'redaction_guard', 'masking guard failed; report not stored'); // defensive: should be unreachable

    const id = ulid();
    const key = await this.nextKey(this.db, p.id, 'BR');
    const source = intake ? 'intake' : ctx.actor.kind === 'user' ? 'web' : 'api';
    const ins = await this.db.run(`INSERT INTO bug_reports (id, org_id, project_id, key, source, intake_id, idempotency_key, status, title, language, release_candidate_id, environment_id, defect_id, content_json, redaction_json, findings_json, similar_json, attachment_ids_json, report_ja, report_en, reporter_kind, reporter_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (project_id, idempotency_key) DO NOTHING`,
      [id, p.org_id, p.id, key, source, intake?.id ?? null, input.idempotencyKey, 'processing', c.title, c.language, rcId, envId, null, JSON.stringify(c), JSON.stringify(s.summary), JSON.stringify(s.findings), JSON.stringify(similar), JSON.stringify(attIds), reportJa, reportEn, ctx.actor.kind, ctx.actor.id, now, now]);
    if (!ins.changes) { const raced = await this.db.get<BugReportRow>(`SELECT * FROM bug_reports WHERE project_id = ? AND idempotency_key = ?`, [p.id, input.idempotencyKey]); if (raced) return this.replay(ctx, raced, intake); throw conflict('idempotency conflict'); }

    try {
      if (attIds.length) {
        const claimed = await this.db.run(`UPDATE bug_report_attachments SET bug_report_id = ? WHERE artifact_id IN (${attIds.map(() => '?').join(',')}) AND bug_report_id IS NULL`, [id, ...attIds]);
        if (claimed.changes !== attIds.length) throw conflict('attachment already used by another report');
      }
      const lang = c.language;
      const browser = [c.environment.browser.value, c.environment.os.value].filter(Boolean).join(' / ').slice(0, 60) || undefined;
      const reproduction = `${br.generateShort(c, lang, { attachments: refs })}\n\n${lang === 'ja' ? '不具合報告' : 'Bug report'}: ${key} (${source})`.slice(0, 10_000);
      let defectId: string; let status: string;
      if (target) {
        await this.defects.update(ctx, p, target, { artifactIds: attIds });
        if (attIds.length) await this.artifacts.setRetentionClass(attIds, 'release_evidence');
        defectId = target.id; status = 'attached_to_defect';
      } else {
        const d = await this.defects.create(ctx, p, {
          title: c.title.slice(0, 300), severity: intake ? intake.default_severity : input.severity ?? 'medium', priority: intake ? intake.default_priority : input.priority ?? 'p2',
          environmentId: envId ?? undefined, browser, reproduction, expected: c.expected.slice(0, 5000) || undefined, actual: (c.actual || c.description).slice(0, 5000) || undefined, artifactIds: attIds,
        });
        defectId = d.id; status = 'defect_created';
      }
      await this.db.run(`INSERT INTO defect_links (org_id, defect_id, target_type, target_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`, [p.org_id, defectId, 'bug_report', id, now]);
      if (rcId) await this.db.run(`INSERT INTO defect_links (org_id, defect_id, target_type, target_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`, [p.org_id, defectId, 'release_candidate', rcId, now]);
      await this.db.run(`UPDATE bug_reports SET status = ?, defect_id = ?, updated_at = ? WHERE id = ?`, [status, defectId, nowIso(), id]);
      if (intake) await this.db.run(`UPDATE bug_report_intakes SET last_used_at = ? WHERE id = ?`, [now, intake.id]);
      await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'bug_report.submit', targetType: 'bug_report', targetId: id, projectId: p.id, after: { key, source, defectId, status, attachments: attIds.length, redaction: s.summary.counts, kept: s.summary.keptCategories }, ip: ctx.ip });
    } catch (e) {
      // Leave no half-processed report behind: the same idempotency key can be retried.
      await this.db.run(`UPDATE bug_report_attachments SET bug_report_id = NULL WHERE bug_report_id = ?`, [id]);
      await this.db.run(`DELETE FROM bug_reports WHERE id = ?`, [id]);
      throw e;
    }
    const row = (await this.db.get<BugReportRow>(`SELECT * FROM bug_reports WHERE id = ?`, [id]))!;
    return { ...this.receipt(row, !!intake), replayed: false };
  }

  private async replay(ctx: Ctx, r: BugReportRow, intake?: IntakeRow) {
    const sameReporter = intake ? r.intake_id === intake.id : r.intake_id === null && r.reporter_id === ctx.actor.id;
    if (!sameReporter) throw conflict('idempotency key already used in this project');
    if (r.status === 'processing') throw new HttpError(409, 'in_progress', 'the same report is still being processed; retry shortly');
    return { ...this.receipt(r, !!intake), replayed: true };
  }
  /** External reporters get a receipt only (no defect ids, no similar internal defects). */
  private receipt(r: BugReportRow, external: boolean) {
    const v = bugReportView(r);
    if (external) return { id: v.id, key: v.key, status: 'received', redaction: v.redaction, createdAt: v.createdAt };
    return v;
  }

  // ---------------- read ----------------
  async list(projectId: string, opts: { limit?: number; cursor?: string; source?: string } = {}) {
    const where = ['project_id = ?']; const params: (string | number)[] = [projectId];
    if (opts.source) { where.push('source = ?'); params.push(opts.source); }
    if (opts.cursor) { where.push('id < ?'); params.push(opts.cursor); }
    params.push(Math.min(opts.limit ?? 100, 500));
    const rows = await this.db.all<BugReportRow>(`SELECT * FROM bug_reports WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params);
    const keys = new Map<string, string>();
    for (const r of rows) if (r.defect_id && !keys.has(r.defect_id)) { const d = await this.db.get<{ key: string }>(`SELECT key FROM defects WHERE id = ?`, [r.defect_id]); if (d) keys.set(r.defect_id, d.key); }
    return rows.map((r) => ({ ...bugReportView(r), defectKey: r.defect_id ? keys.get(r.defect_id) ?? null : null }));
  }
  async getRow(id: string, projectId: string): Promise<BugReportRow> {
    const r = await this.db.get<BugReportRow>(`SELECT * FROM bug_reports WHERE id = ?`, [id]);
    if (!r || r.project_id !== projectId) throw notFound('bug report');
    return r;
  }
  async get(id: string, projectId: string) {
    const r = await this.getRow(id, projectId);
    const atts = await this.db.all<AttachmentRow>(`SELECT * FROM bug_report_attachments WHERE bug_report_id = ? ORDER BY artifact_id`, [id]);
    const d = r.defect_id ? await this.db.get<{ key: string; status: string }>(`SELECT key, status FROM defects WHERE id = ?`, [r.defect_id]) : undefined;
    return { ...bugReportView(r), content: asJson<br.BugReportContent | null>(r.content_json, null), findings: asJson<br.PublicFinding[]>(r.findings_json, []), report: { ja: r.report_ja, en: r.report_en }, attachments: atts.map((a) => ({ artifactId: a.artifact_id, fileName: a.file_name, contentType: a.content_type, processing: asJson<Record<string, unknown>>(a.processing_json, {}) })), defect: d ? { id: r.defect_id, key: d.key, status: d.status } : null };
  }

  // ---------------- intakes ----------------
  async createIntake(ctx: Ctx, p: ProjectRow, input: { name: string; defaultSeverity: string; defaultPriority: string; releaseCandidateId?: string; environmentId?: string; maxPerHour: number }) {
    if (input.releaseCandidateId && !(await this.db.get(`SELECT 1 FROM release_candidates WHERE id = ? AND project_id = ?`, [input.releaseCandidateId, p.id]))) throw badRequest('release candidate not in project');
    if (input.environmentId && !(await this.db.get(`SELECT 1 FROM environments WHERE id = ? AND project_id = ?`, [input.environmentId, p.id]))) throw badRequest('environment not in project');
    const id = ulid(); const token = `pfi_${randomToken(24)}`; const now = nowIso();
    await this.db.run(`INSERT INTO bug_report_intakes (id, org_id, project_id, name, token_hash, token_prefix, default_severity, default_priority, release_candidate_id, environment_id, max_per_hour, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, p.org_id, p.id, input.name, sha256(token), token.slice(0, 10), input.defaultSeverity, input.defaultPriority, input.releaseCandidateId ?? null, input.environmentId ?? null, input.maxPerHour, ctx.actor.id, now]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'bug_intake.create', targetType: 'bug_report_intake', targetId: id, projectId: p.id, after: { name: input.name, defaultSeverity: input.defaultSeverity, maxPerHour: input.maxPerHour }, ip: ctx.ip });
    const row = (await this.db.get<IntakeRow>(`SELECT * FROM bug_report_intakes WHERE id = ?`, [id]))!;
    // The token is shown exactly once; only its sha256 is stored.
    return { ...intakeView(row), token, formUrlPath: `/intake/${id}#token=${token}` };
  }
  async listIntakes(projectId: string) { return (await this.db.all<IntakeRow>(`SELECT * FROM bug_report_intakes WHERE project_id = ? ORDER BY id DESC`, [projectId])).map(intakeView); }
  async revokeIntake(ctx: Ctx, p: ProjectRow, id: string) {
    const r = await this.db.run(`UPDATE bug_report_intakes SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL`, [nowIso(), id, p.id]);
    if (!r.changes) throw notFound('intake');
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'bug_intake.revoke', targetType: 'bug_report_intake', targetId: id, projectId: p.id, ip: ctx.ip });
  }
  /** Resolve an intake by id + token. Unknown / revoked → 404, wrong token → 401 (no timing difference on the hash compare). */
  async resolveIntake(id: string, token: string | undefined): Promise<{ intake: IntakeRow; actor: Actor }> {
    const row = await this.db.get<IntakeRow>(`SELECT * FROM bug_report_intakes WHERE id = ?`, [id]);
    if (!row || row.revoked_at) throw notFound('intake');
    if (!token || !safeEqual(sha256(token), row.token_hash)) throw new HttpError(401, 'unauthorized', 'invalid intake token');
    return { intake: row, actor: { kind: 'intake', id: row.id, name: `intake:${row.name}` } };
  }
  intakePublicInfo(i: IntakeRow, projectName: string) { return { id: i.id, name: i.name, projectName, maxAttachments: 10, maxAttachmentBytes: MAX_ATTACHMENT_BYTES, disclaimer: br.SCANNER_DISCLAIMER, imageChecklist: br.IMAGE_MANUAL_CHECKLIST }; }
  private async assertIntakeQuota(i: IntakeRow, what: 'report' | 'attachment') {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const n = what === 'report'
      ? await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM bug_reports WHERE intake_id = ? AND created_at > ?`, [i.id, since])
      : await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM bug_report_attachments WHERE intake_id = ? AND created_at > ?`, [i.id, since]);
    const limit = what === 'report' ? Number(i.max_per_hour) : Number(i.max_per_hour) * 5;
    if (Number(n?.c ?? 0) >= limit) throw new HttpError(429, 'rate_limited', `intake limit reached (${limit} ${what}s per hour)`);
  }
}
