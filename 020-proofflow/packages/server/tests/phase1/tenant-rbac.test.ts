import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, signup, api, createProject, createEnvironment, login, type TestApp, type Session } from '../helpers/app.js';

let t: TestApp; let a: Session; let b: Session; let projectA: { id: string };
beforeAll(async () => {
  t = await createTestApp();
  a = await signup(t.app, 'alice@a.example', 'Tenant A');
  b = await signup(t.app, 'bob@b.example', 'Tenant B');
  projectA = await createProject(t.app, a, 'A Project');
});
afterAll(async () => { await t.close(); });

describe('必須テスト1: tenant A→B の Project/API/artifact 拒否', () => {
  it('tenant B cannot read, update or list tenant A project', async () => {
    const bApi = api(t.app, { cookie: b.cookie });
    expect((await bApi.get(`/api/v1/projects/${projectA.id}`)).statusCode).toBe(404);
    expect((await bApi.patch(`/api/v1/projects/${projectA.id}`, { name: 'hacked' })).statusCode).toBe(404);
    expect((await bApi.get(`/api/v1/projects/${projectA.id}/environments`)).statusCode).toBe(404);
    expect((await bApi.get(`/api/v1/projects/${projectA.id}/secrets`)).statusCode).toBe(404);
    expect((await bApi.get(`/api/v1/orgs/${a.orgId}/projects`)).statusCode).toBe(403);
    expect((await bApi.get(`/api/v1/orgs/${a.orgId}/members`)).statusCode).toBe(403);
    expect((await bApi.get(`/api/v1/orgs/${a.orgId}/audit`)).statusCode).toBe(403);
    // and A's data is untouched
    const own = await api(t.app, { cookie: a.cookie }).get(`/api/v1/projects/${projectA.id}`);
    expect(own.json().data.name).toBe('A Project');
  });
  it('a service token of tenant B cannot access tenant A even with owner role', async () => {
    const tok = await api(t.app, { cookie: b.cookie }).post(`/api/v1/orgs/${b.orgId}/tokens`, { name: 'ci', kind: 'service', role: 'owner' });
    expect(tok.statusCode).toBe(201);
    const bTok = api(t.app, { token: tok.json().data.token });
    expect((await bTok.get(`/api/v1/projects/${projectA.id}`)).statusCode).toBe(404);
    expect((await bTok.get(`/api/v1/orgs/${a.orgId}`)).statusCode).toBe(403);
    expect((await bTok.get(`/api/v1/orgs/${b.orgId}`)).statusCode).toBe(200);
  });
  it('anonymous is rejected', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/projects/${projectA.id}` })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/auth/me`, headers: { authorization: 'Bearer pf_bogus' } })).statusCode).toBe(401);
  });
});

describe('必須テスト2: Viewer が Scenario/Project 設定を変更できない (API 認可)', () => {
  it('viewer gets 403 on writes but 200 on reads', async () => {
    const add = await api(t.app, { cookie: a.cookie }).post(`/api/v1/orgs/${a.orgId}/members`, { email: 'viewer@a.example', role: 'viewer', temporaryPassword: 'Viewer-Pass-1234' });
    expect(add.statusCode).toBe(201);
    const vCookie = await login(t.app, 'viewer@a.example', 'Viewer-Pass-1234');
    const v = api(t.app, { cookie: vCookie });
    expect((await v.get(`/api/v1/projects/${projectA.id}`)).statusCode).toBe(200);
    expect((await v.patch(`/api/v1/projects/${projectA.id}`, { name: 'nope' })).statusCode).toBe(403);
    expect((await v.post(`/api/v1/projects/${projectA.id}/environments`, { name: 'x', kind: 'staging', baseUrl: 'https://x.example.com' })).statusCode).toBe(403);
    expect((await v.put(`/api/v1/projects/${projectA.id}/secrets`, { name: 'X', value: 'y' })).statusCode).toBe(403);
    expect((await v.post(`/api/v1/orgs/${a.orgId}/members`, { email: 'z@a.example', role: 'viewer' })).statusCode).toBe(403);
    expect((await v.post(`/api/v1/orgs/${a.orgId}/tokens`, { name: 't', kind: 'service', role: 'admin' })).statusCode).toBe(403);
  });
  it('role escalation is blocked: tester cannot grant admin, token role capped by creator role', async () => {
    await api(t.app, { cookie: a.cookie }).post(`/api/v1/orgs/${a.orgId}/members`, { email: 'tester@a.example', role: 'tester', temporaryPassword: 'Tester-Pass-1234' });
    const tc = await login(t.app, 'tester@a.example', 'Tester-Pass-1234');
    const tr = api(t.app, { cookie: tc });
    expect((await tr.post(`/api/v1/orgs/${a.orgId}/members`, { email: 'n@a.example', role: 'admin' })).statusCode).toBe(403);
    const personal = await tr.post(`/api/v1/orgs/${a.orgId}/tokens`, { name: 'p', kind: 'personal' });
    expect(personal.statusCode).toBe(201);
    expect(personal.json().data.role).toBe('tester');
    const svc = await tr.post(`/api/v1/orgs/${a.orgId}/tokens`, { name: 's', kind: 'service', role: 'admin' });
    expect(svc.statusCode).toBe(403);
  });
});

describe('必須テスト3 (環境ポリシー部分): Production の destructive は default 拒否', () => {
  it('production environment is created with destructivePolicy=deny regardless of input', async () => {
    const env = await createEnvironment(t.app, a, projectA.id, { name: 'Prod', kind: 'production', baseUrl: 'https://www.example.com', destructivePolicy: 'allow' });
    expect(env.destructivePolicy).toBe('deny');
    const upd = await api(t.app, { cookie: a.cookie }).patch(`/api/v1/projects/${projectA.id}/environments/${env.id}`, { destructivePolicy: 'allow' });
    expect(upd.statusCode).toBe(400);
    expect(upd.json().error.details.code).toBe('production_destructive_confirmation_required');
    const upd2 = await api(t.app, { cookie: a.cookie }).patch(`/api/v1/projects/${projectA.id}/environments/${env.id}`, { destructivePolicy: 'allow', confirmProductionDestructive: true });
    expect(upd2.statusCode).toBe(200);
    expect(upd2.json().data.destructivePolicy).toBe('allow');
  });
  it('localhost / private targets are rejected unless local env with allowPrivateNetwork', async () => {
    const r1 = await api(t.app, { cookie: a.cookie }).post(`/api/v1/projects/${projectA.id}/environments`, { name: 'bad', kind: 'staging', baseUrl: 'http://localhost:3000' });
    expect(r1.statusCode).toBe(400);
    const r2 = await api(t.app, { cookie: a.cookie }).post(`/api/v1/projects/${projectA.id}/environments`, { name: 'meta', kind: 'staging', baseUrl: 'http://169.254.169.254/latest/meta-data/' });
    expect(r2.statusCode).toBe(400);
    const r3 = await api(t.app, { cookie: a.cookie }).post(`/api/v1/projects/${projectA.id}/environments`, { name: 'local', kind: 'local', baseUrl: 'http://localhost:3000', allowPrivateNetwork: true });
    expect(r3.statusCode).toBe(201);
  });
});

describe('必須テスト4 (vault 部分): secret 値が API 応答・監査ログに平文で出ない', () => {
  it('stores encrypted, lists metadata only, audit has no value', async () => {
    const put = await api(t.app, { cookie: a.cookie }).put(`/api/v1/projects/${projectA.id}/secrets`, { name: 'LOGIN_PASSWORD', value: 'SuperSecretValue!987' });
    expect(put.statusCode).toBe(201);
    expect(JSON.stringify(put.json())).not.toContain('SuperSecretValue');
    const list = await api(t.app, { cookie: a.cookie }).get(`/api/v1/projects/${projectA.id}/secrets`);
    expect(JSON.stringify(list.json())).not.toContain('SuperSecretValue');
    const raw = await t.db.get<{ ciphertext: string }>(`SELECT ciphertext FROM secrets WHERE name = 'LOGIN_PASSWORD'`);
    expect(raw!.ciphertext).not.toContain('SuperSecretValue');
    expect(raw!.ciphertext.startsWith('v1.k1.')).toBe(true);
    const audit = await api(t.app, { cookie: a.cookie }).get(`/api/v1/orgs/${a.orgId}/audit?targetType=secret`);
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.json())).not.toContain('SuperSecretValue');
    // server-side resolution works (used only for runner leases)
    const resolved = await t.app.svc.projects.resolveSecrets(projectA.id, 'none', ['LOGIN_PASSWORD']);
    expect(resolved.LOGIN_PASSWORD).toBe('SuperSecretValue!987');
  });
});

describe('必須テスト38 (基盤): audit log に RBAC/secret/environment 変更が残る', () => {
  it('records member add, secret create, environment create/update with actor', async () => {
    const audit = (await api(t.app, { cookie: a.cookie }).get(`/api/v1/orgs/${a.orgId}/audit?limit=200`)).json().data as { action: string; actor_id: string }[];
    const actions = new Set(audit.map((x) => x.action));
    for (const need of ['org.create', 'project.create', 'member.add', 'secret.create', 'environment.create', 'environment.update', 'token.create']) expect(actions.has(need)).toBe(true);
    expect(audit.every((x) => x.actor_id)).toBe(true);
  });
});
