import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, signup, api, createProject, login, type TestApp, type Session } from '../helpers/app.js';
import { MockProvider } from '@proofflow/server/ai/provider';

let t: TestApp; let a: Session; let project: { id: string }; let mock: MockProvider;
beforeAll(async () => {
  mock = new MockProvider();
  t = await createTestApp({}, { PROOFFLOW_AI_PROVIDER: 'mock' });
  (t.app.svc.ai as unknown as { provider: MockProvider }).provider = mock;
  a = await signup(t.app, 'qa@a.example', 'Tenant A');
  project = await createProject(t.app, a, 'Shop');
});
afterAll(async () => { await t.close(); });

const steps = [
  { type: 'navigate', url: '/login' },
  { type: 'fill', target: { label: 'Email' }, value: 'user@example.com' },
  { type: 'fill', target: { label: 'Password' }, value: '{{secret:LOGIN_PASSWORD}}' },
  { type: 'click', target: { role: 'button', name: 'Log in' } },
  { type: 'assert_url', url: '/dashboard', match: 'contains' },
];

describe('Requirement + Acceptance Criteria', () => {
  it('creates requirement with GWT criteria and REQ-n keys', async () => {
    const A = api(t.app, { cookie: a.cookie });
    const r1 = await A.post(`/api/v1/projects/${project.id}/requirements`, { title: 'ログインできる', priority: 'p0', acceptanceCriteria: [{ format: 'gwt', given: '登録済みユーザー', when: '正しい資格情報でログイン', then: 'ダッシュボードが表示される' }] });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().data.key).toBe('REQ-1');
    expect(r1.json().data.acceptanceCriteria[0].then).toContain('ダッシュボード');
    const r2 = await A.post(`/api/v1/projects/${project.id}/requirements`, { title: '会員登録', priority: 'p1' });
    expect(r2.json().data.key).toBe('REQ-2');
  });
});

describe('Scenario (typed steps, versions, traceability)', () => {
  let reqId: string; let scenarioId: string;
  it('creates a scenario linked to a requirement; secret refs are detected, no JS allowed', async () => {
    const A = api(t.app, { cookie: a.cookie });
    reqId = (await A.get(`/api/v1/projects/${project.id}/requirements`)).json().data.find((r: { key: string }) => r.key === 'REQ-1').id;
    const res = await A.post(`/api/v1/projects/${project.id}/scenarios`, { title: 'ログイン正常系', steps, expected: 'ダッシュボードが表示される', priority: 'p0', requirementIds: [reqId], tags: ['smoke'] });
    expect(res.statusCode).toBe(201);
    scenarioId = res.json().data.id;
    expect(res.json().data.key).toBe('SCN-1');
    expect(res.json().data.secretRefs).toEqual(['LOGIN_PASSWORD']);
    expect(res.json().data.version).toBe(1);
    // arbitrary JavaScript / unknown step types are rejected by the schema
    const bad = await A.post(`/api/v1/projects/${project.id}/scenarios`, { title: 'evil', steps: [{ type: 'evaluate', script: 'process.exit()' }] });
    expect(bad.statusCode).toBe(400);
    const bad2 = await A.post(`/api/v1/projects/${project.id}/scenarios`, { title: 'evil2', steps: [{ type: 'click', target: {} }] });
    expect(bad2.statusCode).toBe(400);
  });
  it('changing steps/expected bumps version and keeps history (audit of Expected change)', async () => {
    const A = api(t.app, { cookie: a.cookie });
    const upd = await A.patch(`/api/v1/projects/${project.id}/scenarios/${scenarioId}`, { expected: '歓迎メッセージが表示される', changeReason: '仕様変更 #12' });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().data.version).toBe(2);
    const versions = (await A.get(`/api/v1/projects/${project.id}/scenarios/${scenarioId}/versions`)).json().data;
    expect(versions.length).toBe(2);
    expect(versions[0].changeReason).toBe('仕様変更 #12');
    const audit = (await A.get(`/api/v1/orgs/${a.orgId}/audit?targetType=scenario&targetId=${scenarioId}`)).json().data;
    const change = audit.find((x: { action: string }) => x.action === 'scenario.update');
    expect(JSON.parse(change.after_json).expectedChanged).toBe(true);
    // title-only change does not bump version
    const upd2 = await A.patch(`/api/v1/projects/${project.id}/scenarios/${scenarioId}`, { title: 'ログイン正常系 (renamed)' });
    expect(upd2.json().data.version).toBe(2);
  });
  it('traceability lists the scenario under the requirement', async () => {
    const A = api(t.app, { cookie: a.cookie });
    const tr = await A.get(`/api/v1/projects/${project.id}/requirements/${reqId}/traceability`);
    expect(tr.statusCode).toBe(200);
    expect(tr.json().data.scenarios[0].scenario.id).toBe(scenarioId);
  });
  it('必須テスト2: viewer cannot create or modify scenarios / suites', async () => {
    const A = api(t.app, { cookie: a.cookie });
    await A.post(`/api/v1/orgs/${a.orgId}/members`, { email: 'v2@a.example', role: 'viewer', temporaryPassword: 'Viewer-Pass-1234' });
    const V = api(t.app, { cookie: await login(t.app, 'v2@a.example', 'Viewer-Pass-1234') });
    expect((await V.get(`/api/v1/projects/${project.id}/scenarios`)).statusCode).toBe(200);
    expect((await V.post(`/api/v1/projects/${project.id}/scenarios`, { title: 'x', steps })).statusCode).toBe(403);
    expect((await V.patch(`/api/v1/projects/${project.id}/scenarios/${scenarioId}`, { expected: 'tampered' })).statusCode).toBe(403);
    expect((await V.del(`/api/v1/projects/${project.id}/scenarios/${scenarioId}`)).statusCode).toBe(403);
    expect((await V.post(`/api/v1/projects/${project.id}/suites`, { name: 'S', kind: 'smoke' })).statusCode).toBe(403);
    const s = await A.get(`/api/v1/projects/${project.id}/scenarios/${scenarioId}`);
    expect(s.json().data.expected).toBe('歓迎メッセージが表示される');
  });
  it('suite composition with matrix', async () => {
    const A = api(t.app, { cookie: a.cookie });
    const res = await A.post(`/api/v1/projects/${project.id}/suites`, { name: 'Smoke', kind: 'smoke', scenarioIds: [scenarioId], matrix: { browsers: ['chromium'], viewports: [{ width: 1280, height: 800, name: 'desktop' }, { width: 390, height: 664, name: 'iphone13', isMobile: true, hasTouch: true }], retries: 1, video: 'on_failure', trace: 'on_failure' }, requiredForRelease: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.scenarioIds).toEqual([scenarioId]);
    expect(res.json().data.matrix.viewports.length).toBe(2);
    const other = await createProject(t.app, a, 'Other');
    const cross = await A.post(`/api/v1/projects/${other.id}/suites`, { name: 'X', kind: 'smoke', scenarioIds: [scenarioId] });
    expect(cross.statusCode).toBe(400); // scenario from another project cannot be attached
  });
  it('test data profiles reject real-looking personal data', async () => {
    const A = api(t.app, { cookie: a.cookie });
    expect((await A.put(`/api/v1/projects/${project.id}/data-profiles`, { name: 'bad', kind: 'fixture', data: { email: 'someone@gmail.com' } })).statusCode).toBe(400);
    expect((await A.put(`/api/v1/projects/${project.id}/data-profiles`, { name: 'bad2', kind: 'fixture', data: { card: '4111111111111111' } })).statusCode).toBe(400);
    expect((await A.put(`/api/v1/projects/${project.id}/data-profiles`, { name: 'ok', kind: 'fixture', data: { email: 'tester+1@example.com', name: 'テスト 太郎' } })).statusCode).toBe(201);
  });
});

describe('AI Scenario Draft (必須テスト31/33 の前提: 提案のみ、AI OFF で呼び出しゼロ)', () => {
  it('AI is off by default at the organization level → 409 and zero provider calls', async () => {
    const A = api(t.app, { cookie: a.cookie });
    const res = await A.post(`/api/v1/projects/${project.id}/ai/scenario-draft`, { prompt: '会員登録をテスト' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ai_disabled');
    expect(mock.calls.length).toBe(0);
  });
  it('with AI enabled, drafts are stored as suggestions; Expected is not invented; apply creates draft scenarios', async () => {
    const A = api(t.app, { cookie: a.cookie });
    await A.patch(`/api/v1/orgs/${a.orgId}`, { settings: { ai: { enabled: true, sendArtifacts: false } } });
    const reqId = (await A.get(`/api/v1/projects/${project.id}/requirements`)).json().data.find((r: { key: string }) => r.key === 'REQ-2').id;
    const res = await A.post(`/api/v1/projects/${project.id}/ai/scenario-draft`, { prompt: '会員登録をテスト', requirementId: reqId });
    expect(res.statusCode).toBe(201);
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]!.user).toContain('会員登録');
    const sug = res.json().data;
    expect(sug.status).toBe('proposed');
    expect(sug.output.drafts.length).toBe(3);
    expect(sug.output.drafts.every((d: { expectedSource: string; expected: null }) => d.expectedSource === 'unspecified' && d.expected === null)).toBe(true);
    // nothing created yet
    const before = (await A.get(`/api/v1/projects/${project.id}/scenarios`)).json().data.length;
    const apply = await A.post(`/api/v1/projects/${project.id}/ai/suggestions/${sug.id}/apply`, { indexes: [0, 2] });
    expect(apply.statusCode).toBe(200);
    expect(apply.json().data.scenarioIds.length).toBe(2);
    const after = (await A.get(`/api/v1/projects/${project.id}/scenarios`)).json().data;
    expect(after.length).toBe(before + 2);
    const created = after.find((s: { id: string }) => s.id === apply.json().data.scenarioIds[0]);
    expect(created.origin).toBe('ai_draft');
    expect(created.status).toBe('draft');
    expect(created.expected).toBeNull();
    expect(created.requirementIds).toEqual([reqId]);
    // re-apply is refused, viewer cannot apply
    expect((await A.post(`/api/v1/projects/${project.id}/ai/suggestions/${sug.id}/apply`, {})).statusCode).toBe(400);
    const V = api(t.app, { cookie: await login(t.app, 'v2@a.example', 'Viewer-Pass-1234') });
    expect((await V.post(`/api/v1/projects/${project.id}/ai/scenario-draft`, { prompt: 'viewer attempt' })).statusCode).toBe(403);
    const usage = await A.get(`/api/v1/orgs/${a.orgId}/ai/usage`);
    expect(usage.json().data.some((u: { status: string }) => u.status === 'ok')).toBe(true);
  });
  it('invalid provider output is rejected (schema validation) and not stored', async () => {
    const A = api(t.app, { cookie: a.cookie });
    const bad = new MockProvider(() => ({ drafts: [{ title: 'x', steps: [{ type: 'evaluate', script: 'alert(1)' }], expected: 'y', expectedSource: 'requirement' }] }));
    (t.app.svc.ai as unknown as { provider: MockProvider }).provider = bad;
    const res = await A.post(`/api/v1/projects/${project.id}/ai/scenario-draft`, { prompt: 'invalid output case' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('ai_invalid_output');
    (t.app.svc.ai as unknown as { provider: MockProvider }).provider = mock;
  });
  it('AI OFF at server level (provider=none): no provider object call path exists', async () => {
    const t2 = await createTestApp({}, { PROOFFLOW_AI_PROVIDER: 'none' });
    const s2 = await signup(t2.app, 'x@none.example', 'None Org');
    const p2 = await createProject(t2.app, s2, 'P');
    await api(t2.app, { cookie: s2.cookie }).patch(`/api/v1/orgs/${s2.orgId}`, { settings: { ai: { enabled: true } } });
    const res = await api(t2.app, { cookie: s2.cookie }).post(`/api/v1/projects/${p2.id}/ai/scenario-draft`, { prompt: 'test' });
    expect(res.statusCode).toBe(409);
    expect((await api(t2.app, { cookie: s2.cookie }).get('/api/v1/ai/status')).json().data).toEqual({ provider: 'none', enabled: false });
    await t2.close();
  });
});
