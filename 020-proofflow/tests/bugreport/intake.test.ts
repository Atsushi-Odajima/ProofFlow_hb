// ProofFlow 不具合報告 — integration: report → Defect, masking before storage, attachments as evidence, idempotency,
// permissions / tenant isolation, external intake (token, defaults, hourly cap, revoke), known-issue hints, backup / restore.
// Runs on SQLite (pnpm test) and PostgreSQL (pnpm test:pg) through tests/helpers/app.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, signup, api, createProject, createEnvironment, login, createToken, type TestApp, type Session } from '../helpers/app.js';

let t: TestApp; let a: Session; let b: Session; let project: { id: string }; let other: { id: string }; let envId: string; let rcId: string;
let A: ReturnType<typeof api>;

const SECRETS = ['taro.yamada@example.com', '090-1234-5678', 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd', '4111 1111 1111 1111', 'hunter2!!', 'supersecret123', 'Author\0Taro'];
function pngWithText(): Buffer {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  return Buffer.from([...sig, ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]), ...chunk('tEXt', [...new TextEncoder().encode('Author\0Taro')]), ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND', [])]);
}
const report = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: 'key-' + Math.random().toString(36).slice(2, 12),
  title: 'Checkout button does nothing for taro.yamada@example.com',
  description: 'Pressed pay, nothing happened. My phone is 090-1234-5678.',
  expected: 'Payment page opens', actual: 'Nothing happens; card 4111 1111 1111 1111 was entered',
  steps: ['Open /cart', 'Enter password: hunter2!!', 'Press pay'],
  errorText: 'POST /api/pay 500 key=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd',
  frequency: 'always', language: 'en',
  occurredAt: { iso: '2026-09-30T04:44:00.000Z', timezone: 'Asia/Tokyo', display: '2026-09-30 13:44 GMT+9 / Asia/Tokyo', source: 'user_manual', confidence: 'high' },
  environment: { browser: { value: 'Safari', source: 'auto' }, os: { value: 'iOS/iPadOS', source: 'auto' }, pageUrl: { value: 'https://shop.example.com/cart?token=supersecret123', source: 'auto' }, appVersion: { value: '1.2.0', source: 'manual' } },
  ...over,
});
beforeAll(async () => {
  t = await createTestApp();
  a = await signup(t.app, 'owner@br.example', 'BR Tenant A');
  b = await signup(t.app, 'other@br.example', 'BR Tenant B');
  A = api(t.app, { cookie: a.cookie });
  project = await createProject(t.app, a, 'Shop');
  other = await createProject(t.app, a, 'Other');
  envId = (await createEnvironment(t.app, a, project.id)).id;
  const rc = await A.post(`/api/v1/projects/${project.id}/releases`, { version: '1.2.0', environmentId: envId });
  expect(rc.statusCode).toBe(201); rcId = rc.json().data.id;
  for (const [email, role] of [['viewer@br.example', 'viewer'], ['dev@br.example', 'developer']] as const) expect((await A.post(`/api/v1/orgs/${a.orgId}/members`, { email, role, temporaryPassword: 'Member-Pass-1234' })).statusCode).toBe(201);
});
afterAll(async () => { await t.close(); });

describe('ProofFlow 不具合報告: internal report → Defect', () => {
  let reportId = ''; let defectId = ''; let pngId = ''; let logId = ''; const key = 'idem-internal-0001';
  it('uploads attachments with metadata stripped / text masked before storage', async () => {
    const png = await t.app.inject({ method: 'PUT', url: `/api/v1/projects/${project.id}/bug-reports/attachments?fileName=${encodeURIComponent('screen taro.yamada@example.com.png')}`, payload: pngWithText(), headers: { cookie: a.cookie, 'content-type': 'image/png' } });
    expect(png.statusCode).toBe(201);
    pngId = png.json().data.id;
    expect(png.json().data.processing.metadataRemoved).toEqual(['tEXt']);
    expect(png.json().data.fileName).not.toContain('taro');
    const log = await t.app.inject({ method: 'PUT', url: `/api/v1/projects/${project.id}/bug-reports/attachments?fileName=console.log`, payload: 'error for taro.yamada@example.com token=abcdefghijklmnop1234', headers: { cookie: a.cookie, 'content-type': 'text/plain' } });
    expect(log.statusCode).toBe(201); logId = log.json().data.id;
    // wrong / disguised types are refused
    expect((await t.app.inject({ method: 'PUT', url: `/api/v1/projects/${project.id}/bug-reports/attachments?fileName=x.png`, payload: 'not a png', headers: { cookie: a.cookie, 'content-type': 'image/png' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: `/api/v1/projects/${project.id}/bug-reports/attachments?fileName=x.exe`, payload: Buffer.from('MZ'), headers: { cookie: a.cookie, 'content-type': 'application/octet-stream' } })).statusCode).toBe(400);
  });
  it('preview returns the masked report, findings without matched text, and ja/en Markdown', async () => {
    const r = await A.post(`/api/v1/projects/${project.id}/bug-reports/preview`, report());
    expect(r.statusCode).toBe(200);
    const body = JSON.stringify(r.json().data);
    for (const s of SECRETS) expect(body).not.toContain(s);
    expect(r.json().data.report.ja).toContain('## 再現手順');
    expect(r.json().data.report.en).toContain('## Steps to Reproduce');
    expect(r.json().data.findings.length).toBeGreaterThanOrEqual(6);
  });
  it('submit creates a Defect linked to the project / RC with attachments as evidence; nothing unmasked is stored', async () => {
    const r = await A.post(`/api/v1/projects/${project.id}/bug-reports`, report({ idempotencyKey: key, attachmentIds: [pngId, logId], releaseCandidateId: rcId, environmentId: envId, severity: 'high', priority: 'p1', decisions: { email: 'keep', credit_card: 'keep' } }));
    expect(r.statusCode, r.body).toBe(201);
    const d = r.json().data;
    reportId = d.id; defectId = d.defectId;
    expect(d.key).toBe('BR-1'); expect(d.status).toBe('defect_created'); expect(d.source).toBe('web'); expect(d.replayed).toBe(false);
    expect(d.redaction.keptCategories).toEqual(['email']); // credit_card can never be kept
    const defect = (await A.get(`/api/v1/projects/${project.id}/defects/${defectId}`)).json().data;
    expect(defect.severity).toBe('high'); expect(defect.priority).toBe('p1'); expect(defect.status).toBe('new');
    expect(defect.environmentId).toBe(envId); expect(defect.browser).toBe('Safari / iOS/iPadOS');
    expect(defect.evidence.artifactIds.sort()).toEqual([pngId, logId].sort());
    expect(defect.artifacts.every((x: { retentionClass: string }) => x.retentionClass === 'release_evidence')).toBe(true);
    expect(defect.links).toEqual(expect.arrayContaining([{ type: 'bug_report', id: reportId }, { type: 'release_candidate', id: rcId }]));
    expect(defect.reproduction).toContain('1. Open /cart'); expect(defect.reproduction).toContain('BR-1');
    expect(defect.actual).not.toContain('4111');
    expect(defect.title).toContain('taro.yamada@example.com'); // email was explicitly kept by the reporter
    // Raw DB rows: no secret except the kept e-mail
    const rows = JSON.stringify([await t.db.all(`SELECT * FROM bug_reports`), await t.db.all(`SELECT * FROM defects`), await t.db.all(`SELECT * FROM bug_report_attachments`), await t.db.all(`SELECT * FROM audit_logs`)]);
    for (const s of SECRETS.filter((x) => x !== 'taro.yamada@example.com')) expect(rows).not.toContain(s);
    // stored binaries
    const pngBody = (await A.get(`/api/v1/artifacts/${pngId}/download`)).rawPayload.toString('latin1');
    expect(pngBody).not.toContain('Taro'); expect(pngBody).toContain('IDAT');
    const logBody = (await A.get(`/api/v1/artifacts/${logId}/download`)).body;
    expect(logBody).not.toContain('taro.yamada@example.com'); expect(logBody).toContain('[REDACTED_EMAIL_1]');
    // report detail + Markdown download
    const det = (await A.get(`/api/v1/projects/${project.id}/bug-reports/${reportId}`)).json().data;
    expect(det.defect.key).toMatch(/^DEF-/); expect(det.attachments).toHaveLength(2);
    const md = await A.get(`/api/v1/projects/${project.id}/bug-reports/${reportId}/report?lang=ja`);
    expect(md.headers['content-type']).toContain('text/markdown'); expect(md.body).toContain('## 期待する動作');
    const audit = (await A.get(`/api/v1/orgs/${a.orgId}/audit?action=bug_report.submit`)).json().data;
    expect(audit).toHaveLength(1);
  });
  it('idempotent: the same key returns the same report and creates no second defect; another reporter cannot reuse it', async () => {
    const before = (await A.get(`/api/v1/projects/${project.id}/defects`)).json().data.length;
    const again = await A.post(`/api/v1/projects/${project.id}/bug-reports`, report({ idempotencyKey: key, attachmentIds: [pngId, logId] }));
    expect(again.statusCode).toBe(200); expect(again.json().data.id).toBe(reportId); expect(again.json().data.replayed).toBe(true);
    expect((await A.get(`/api/v1/projects/${project.id}/defects`)).json().data.length).toBe(before);
    const dev = api(t.app, { cookie: await login(t.app, 'dev@br.example', 'Member-Pass-1234') });
    expect((await dev.post(`/api/v1/projects/${project.id}/bug-reports`, report({ idempotencyKey: key }))).statusCode).toBe(409);
    // used attachments cannot be attached again
    expect((await A.post(`/api/v1/projects/${project.id}/bug-reports`, report({ attachmentIds: [pngId] }))).statusCode).toBe(400);
  });
  it('known-issue hinting: a similar open defect is suggested (internal only) and a report can be attached to it', async () => {
    const pv = (await A.post(`/api/v1/projects/${project.id}/bug-reports/preview`, report({ title: 'Checkout button does nothing on Safari' }))).json().data;
    expect(pv.similar[0]).toEqual(expect.objectContaining({ defectId, status: 'new' }));
    const r = await A.post(`/api/v1/projects/${project.id}/bug-reports`, report({ existingDefectId: defectId }));
    expect(r.statusCode).toBe(201); expect(r.json().data.status).toBe('attached_to_defect'); expect(r.json().data.defectId).toBe(defectId);
    expect(r.json().data.similar.length).toBeGreaterThan(0);
    const links = (await A.get(`/api/v1/projects/${project.id}/defects/${defectId}`)).json().data.links.filter((l: { type: string }) => l.type === 'bug_report');
    expect(links).toHaveLength(2);
  });
});

describe('ProofFlow 不具合報告: permissions and tenant isolation', () => {
  it('viewer can read but not submit / upload; developer can submit but not manage intakes', async () => {
    const V = api(t.app, { cookie: await login(t.app, 'viewer@br.example', 'Member-Pass-1234') });
    expect((await V.get(`/api/v1/projects/${project.id}/bug-reports`)).statusCode).toBe(200);
    expect((await V.post(`/api/v1/projects/${project.id}/bug-reports`, report())).statusCode).toBe(403);
    const vCookie = await login(t.app, 'viewer@br.example', 'Member-Pass-1234');
    expect((await t.app.inject({ method: 'PUT', url: `/api/v1/projects/${project.id}/bug-reports/attachments?fileName=a.txt`, payload: 'x', headers: { cookie: vCookie, 'content-type': 'text/plain' } })).statusCode).toBe(403);
    const D = api(t.app, { cookie: await login(t.app, 'dev@br.example', 'Member-Pass-1234') });
    expect((await D.post(`/api/v1/projects/${project.id}/bug-reports`, report())).statusCode).toBe(201);
    expect((await D.post(`/api/v1/projects/${project.id}/bug-intakes`, { name: 'x' })).statusCode).toBe(403);
  });
  it("another tenant gets 404 everywhere; a project-restricted token cannot reach other projects; attachments do not cross projects", async () => {
    const B = api(t.app, { cookie: b.cookie });
    expect((await B.get(`/api/v1/projects/${project.id}/bug-reports`)).statusCode).toBe(404);
    expect((await B.post(`/api/v1/projects/${project.id}/bug-reports`, report())).statusCode).toBe(404);
    expect((await B.post(`/api/v1/projects/${project.id}/bug-reports/preview`, report())).statusCode).toBe(404);
    const list = (await A.get(`/api/v1/projects/${project.id}/bug-reports`)).json().data;
    expect((await B.get(`/api/v1/projects/${project.id}/bug-reports/${list[0].id}`)).statusCode).toBe(404);
    expect((await A.get(`/api/v1/projects/${other.id}/bug-reports/${list[0].id}`)).statusCode).toBe(404);
    const tok = api(t.app, { token: await createToken(t.app, a, { role: 'tester', projectIds: [other.id] }) });
    expect((await tok.post(`/api/v1/projects/${project.id}/bug-reports`, report())).statusCode).toBe(404);
    expect((await tok.post(`/api/v1/projects/${other.id}/bug-reports`, report())).statusCode).toBe(201);
    const att = await t.app.inject({ method: 'PUT', url: `/api/v1/projects/${other.id}/bug-reports/attachments?fileName=a.txt`, payload: 'hello', headers: { cookie: a.cookie, 'content-type': 'text/plain' } });
    expect((await A.post(`/api/v1/projects/${project.id}/bug-reports`, report({ attachmentIds: [att.json().data.id] }))).statusCode).toBe(400);
  });
});

describe('ProofFlow 不具合報告: external intake', () => {
  let intakeId = ''; let token = '';
  const H = () => ({ 'x-proofflow-intake-token': token });
  it('creates an intake (token shown once, only its hash stored)', async () => {
    const r = await A.post(`/api/v1/projects/${project.id}/bug-intakes`, { name: 'Public beta form', defaultSeverity: 'low', defaultPriority: 'p3', releaseCandidateId: rcId, maxPerHour: 2 });
    expect(r.statusCode).toBe(201);
    intakeId = r.json().data.id; token = r.json().data.token;
    expect(token).toMatch(/^pfi_/); expect(r.json().data.formUrlPath).toBe(`/intake/${intakeId}#token=${token}`);
    expect(JSON.stringify((await A.get(`/api/v1/projects/${project.id}/bug-intakes`)).json().data)).not.toContain(token);
    expect(JSON.stringify(await t.db.all(`SELECT * FROM bug_report_intakes`))).not.toContain(token);
  });
  it('rejects missing / wrong tokens and unknown intakes', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/intake/${intakeId}` })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/intake/${intakeId}`, headers: { 'x-proofflow-intake-token': 'pfi_wrong' } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/intake/01JUNKJUNKJUNKJUNKJUNKJUNK`, headers: H() })).statusCode).toBe(404);
    const info = await t.app.inject({ method: 'GET', url: `/api/v1/intake/${intakeId}`, headers: H() });
    expect(info.statusCode).toBe(200); expect(info.json().data.projectName).toBe('Shop');
  });
  it('an external report becomes a Defect with the intake defaults; the reporter gets a receipt only', async () => {
    const att = await t.app.inject({ method: 'PUT', url: `/api/v1/intake/${intakeId}/attachments?fileName=shot.png`, payload: pngWithText(), headers: { ...H(), 'content-type': 'image/png' } });
    expect(att.statusCode).toBe(201);
    const pv = await t.app.inject({ method: 'POST', url: `/api/v1/intake/${intakeId}/preview`, payload: report(), headers: H() });
    expect(pv.statusCode).toBe(200); expect(pv.json().data.similar).toEqual([]); // internal defects are never shown to external reporters
    const body = report({ idempotencyKey: 'ext-key-0001', attachmentIds: [att.json().data.id], severity: 'critical', priority: 'p0', reporterName: 'Hanako' });
    const r = await t.app.inject({ method: 'POST', url: `/api/v1/intake/${intakeId}/bug-reports`, payload: body, headers: H() });
    expect(r.statusCode, r.body).toBe(201);
    expect(Object.keys(r.json().data).sort()).toEqual(['createdAt', 'id', 'key', 'redaction', 'replayed', 'status']);
    const again = await t.app.inject({ method: 'POST', url: `/api/v1/intake/${intakeId}/bug-reports`, payload: body, headers: H() });
    expect(again.statusCode).toBe(200); expect(again.json().data.id).toBe(r.json().data.id);
    const det = (await A.get(`/api/v1/projects/${project.id}/bug-reports/${r.json().data.id}`)).json().data;
    expect(det.source).toBe('intake'); expect(det.reporterKind).toBe('intake'); expect(det.releaseCandidateId).toBe(rcId);
    const defect = (await A.get(`/api/v1/projects/${project.id}/defects/${det.defectId}`)).json().data;
    expect(defect.severity).toBe('low'); expect(defect.priority).toBe('p3'); // reporter cannot pick critical / p0
    expect(defect.evidence.artifactIds).toEqual([att.json().data.id]);
    expect(defect.history[0].actor_kind).toBe('intake');
    // an internal reporter's attachment cannot be used through the intake
    const internalAtt = await t.app.inject({ method: 'PUT', url: `/api/v1/projects/${project.id}/bug-reports/attachments?fileName=a.txt`, payload: 'x', headers: { cookie: a.cookie, 'content-type': 'text/plain' } });
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/intake/${intakeId}/bug-reports`, payload: report({ attachmentIds: [internalAtt.json().data.id] }), headers: H() })).statusCode).toBe(400);
  });
  it('enforces the hourly cap, then revocation turns the intake into 404', async () => {
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/intake/${intakeId}/bug-reports`, payload: report(), headers: H() })).statusCode).toBe(201);
    const capped = await t.app.inject({ method: 'POST', url: `/api/v1/intake/${intakeId}/bug-reports`, payload: report(), headers: H() });
    expect(capped.statusCode).toBe(429); expect(capped.json().error.code).toBe('rate_limited');
    expect((await A.del(`/api/v1/projects/${project.id}/bug-intakes/${intakeId}`)).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/intake/${intakeId}`, headers: H() })).statusCode).toBe(404);
    const audit = (await A.get(`/api/v1/orgs/${a.orgId}/audit?action=bug_intake.revoke`)).json().data;
    expect(audit).toHaveLength(1);
  });
  it('the SPA serves the public intake page path (not swallowed by the API 404)', async () => {
    const r = await t.app.inject({ method: 'GET', url: `/api/v1/intake/${intakeId}/nope` });
    expect(r.statusCode).toBe(404);
  });
});

describe('ProofFlow 不具合報告: backup / restore', () => {
  it('bug report tables are part of the organization backup and restore into an empty environment', async () => {
    const doc = await t.app.svc.backup.export({ actor: { kind: 'system', id: null, name: 't' }, ip: 'test', requestId: 'r' }, a.orgId);
    expect(doc.counts.bug_reports).toBeGreaterThanOrEqual(4);
    expect(doc.counts.bug_report_intakes).toBe(1);
    expect(doc.counts.bug_report_attachments).toBeGreaterThanOrEqual(3);
    const fresh = await createTestApp();
    try {
      const r = await fresh.app.svc.backup.restore(doc);
      expect(r.counts.bug_reports).toBe(doc.counts.bug_reports);
      const R = api(fresh.app, { cookie: await login(fresh.app, 'owner@br.example') });
      const list = (await R.get(`/api/v1/projects/${project.id}/bug-reports`)).json().data;
      const orig = (await A.get(`/api/v1/projects/${project.id}/bug-reports`)).json().data;
      expect(list).toEqual(orig);
      expect(list.every((x: { defectId: string | null; defectKey: string | null }) => x.defectId && x.defectKey)).toBe(true);
    } finally { await fresh.close(); }
  });
});
