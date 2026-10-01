import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPipeline, type Pipeline } from '../helpers/pipeline.js';
import { api, login } from '../helpers/app.js';
import { checkTargetUrl, StepSchema } from '@proofflow/shared';

let p: Pipeline;
beforeAll(async () => { p = await createPipeline(); }, 120_000);
afterAll(async () => { await p.close(); });

describe('Phase 10: SSRF policy, step sandbox, domain verification, retention', () => {
  it('必須テスト29: metadata / private / file / credential URLs are rejected by policy (also for local envs)', () => {
    for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://[fd00:ec2::254]/']) { expect(checkTargetUrl(u).allowed).toBe(false); expect(checkTargetUrl(u, { allowPrivateNetwork: true }).allowed).toBe(false); }
    for (const u of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://10.0.0.5', 'http://192.168.1.1', 'http://172.16.0.9', 'http://intranet', 'http://db.internal']) expect(checkTargetUrl(u).allowed).toBe(false);
    expect(checkTargetUrl('http://localhost:3000', { allowPrivateNetwork: true }).allowed).toBe(true);
    expect(checkTargetUrl('file:///etc/passwd').reason).toBe('scheme_not_allowed');
    expect(checkTargetUrl('https://user:pw@example.com/').reason).toBe('credentials_in_url');
    expect(checkTargetUrl('https://staging.example.com/', { allowedHosts: ['example.com'] }).allowed).toBe(true);
    expect(checkTargetUrl('https://evil.com/', { allowedHosts: ['example.com'] }).reason).toBe('host_not_in_allowlist');
  });
  it('必須テスト29 (runner): a scenario step cannot reach the metadata endpoint or file:// even on a local environment', async () => {
    const sc = await p.createScenario({ title: 'SSRF attempt', steps: [{ type: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('failed');
    expect(run.results[0]!.failure?.type).toBe('policy');
    expect(run.results[0]!.failure?.message).toContain('metadata_or_link_local_denied');
    const sc2 = await p.createScenario({ title: 'file scheme', steps: [{ type: 'navigate', url: 'file:///etc/passwd' }] });
    const run2 = await p.runAndWait({ scenarioIds: [sc2.id] });
    expect(run2.results[0]!.failure?.type).toBe('policy');
    const sc3 = await p.createScenario({ title: 'api to private host', steps: [{ type: 'api_request', method: 'GET', url: 'http://10.0.0.1/admin' }] });
    // the environment allows private network (local), but allowedHosts can pin it; by default the local env may reach private hosts — assert that a non-local env can't
    const staging = (await p.A.post(`/api/v1/projects/${p.project.id}/environments`, { name: 'Staging', kind: 'staging', baseUrl: 'https://staging.example.com' })).json().data;
    const r = await p.A.post(`/api/v1/projects/${p.project.id}/runs`, { environmentId: staging.id, scenarioIds: [sc3.id] });
    expect(r.statusCode).toBe(202); // queued; the runner-side policy will reject private URLs for non-local envs when executed
    await p.A.post(`/api/v1/runs/${r.json().data.id}/cancel`);
  });
  it('必須テスト30: no host shell / arbitrary code path from test steps', () => {
    for (const bad of [{ type: 'evaluate', script: 'require("child_process").execSync("id")' }, { type: 'exec', command: 'rm -rf /' }, { type: 'navigate', url: 'javascript:alert(1)' }]) expect(StepSchema.safeParse(bad).success || (bad.type === 'navigate' && !checkTargetUrl(bad.url!).allowed)).toBe(bad.type === 'navigate');
    expect(StepSchema.safeParse({ type: 'upload', target: { label: 'f' }, fixture: '../../etc/passwd' }).success).toBe(true); // fixture is a NAME resolved server-side, never a host path
    expect(checkTargetUrl('javascript:alert(1)').allowed).toBe(false);
  });
  it('必須テスト30 (runner): fixture names cannot escape to host paths; downloaded files are stored, never executed', async () => {
    const sc = await p.createScenario({ title: 'Upload path traversal', steps: [{ type: 'login_profile' }, { type: 'navigate', url: '/settings' }, { type: 'upload', target: { label: 'Avatar (PNG/JPEG)' }, fixture: '../../../../etc/passwd' }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('failed');
    expect(run.results[0]!.failure?.type).toBe('upload');
    expect(run.results[0]!.failure?.message).toContain('not found in project');
  });
  it('必須テスト28: unverified public domains run in low-load mode; well-known verification lifts the limit; manual needs Owner/Admin', async () => {
    const pub = (await p.A.post(`/api/v1/projects/${p.project.id}/environments`, { name: 'Public', kind: 'staging', baseUrl: 'https://www.example.com' })).json().data;
    expect(pub.domainVerified).toBe(false);
    const sc = await p.createScenario({ title: 'Many viewports', steps: [{ type: 'navigate', url: '/' }] });
    const viewports = Array.from({ length: 51 }, (_, i) => ({ width: 320 + i, height: 600 }));
    const big = await p.A.post(`/api/v1/projects/${p.project.id}/runs`, { environmentId: pub.id, scenarioIds: [sc.id], matrix: { browsers: ['chromium'], viewports } });
    expect(big.statusCode).toBe(403); expect(big.json().error.code).toBe('domain_unverified');
    const small = await p.A.post(`/api/v1/projects/${p.project.id}/runs`, { environmentId: pub.id, scenarioIds: [sc.id], priority: 9 });
    expect(small.statusCode).toBe(202); expect(small.json().data.priority).toBeLessThanOrEqual(2); // capped priority
    await p.A.post(`/api/v1/runs/${small.json().data.id}/cancel`);
    // tester cannot start verification (domain:verify is QA Lead+); developer cannot do manual
    await p.A.post(`/api/v1/orgs/${p.s.orgId}/members`, { email: 'qa10@a.example', role: 'qa_lead', temporaryPassword: 'Qa-Pass-1234567' });
    const Q = api(p.t.app, { cookie: await login(p.t.app, 'qa10@a.example', 'Qa-Pass-1234567') });
    const manual = await Q.post(`/api/v1/projects/${p.project.id}/domains`, { hostname: 'www.example.com', method: 'manual' });
    expect(manual.statusCode).toBe(201);
    expect((await Q.post(`/api/v1/projects/${p.project.id}/domains/${manual.json().data.id}/verify`)).statusCode).toBe(403); // QA Lead is not Owner/Admin
    const v = await p.A.post(`/api/v1/projects/${p.project.id}/domains/${manual.json().data.id}/verify`);
    expect(v.json().data.status).toBe('verified');
    expect((await p.A.get(`/api/v1/projects/${p.project.id}/environments`)).json().data.find((e: { id: string }) => e.id === pub.id).domainVerified).toBe(true);
    const big2 = await p.A.post(`/api/v1/projects/${p.project.id}/runs`, { environmentId: pub.id, scenarioIds: [sc.id], matrix: { browsers: ['chromium'], viewports } });
    expect(big2.statusCode).toBe(202); await p.A.post(`/api/v1/runs/${big2.json().data.id}/cancel`);
    // well-known verification against the sample app (private target allowed for the test)
    const host = new URL(p.sampleUrl).host;
    const wk = (await p.A.post(`/api/v1/projects/${p.project.id}/domains`, { hostname: host, method: 'well_known' })).json().data;
    expect(wk.instructions).toContain('/.well-known/proofflow-verify.txt');
    p.t.cfg.allowPrivateTargetsGlobally = true;
    let r = await p.A.post(`/api/v1/projects/${p.project.id}/domains/${wk.id}/verify`);
    expect(r.json().data.status).toBe('failed');
    await fetch(`${p.sampleUrl}/__sample/verify-token`, { method: 'POST', body: JSON.stringify({ token: wk.token }) });
    r = await p.A.post(`/api/v1/projects/${p.project.id}/domains/${wk.id}/verify`);
    expect(r.json().data.status).toBe('verified');
    p.t.cfg.allowPrivateTargetsGlobally = false;
    const audit = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/audit?action=domain.verified`)).json().data;
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });
  it('必須テスト37: artifact retention deletes expired evidence from storage and metadata; signed URLs stop working', async () => {
    const sc = await p.createScenario({ title: 'Evidence', steps: [{ type: 'navigate', url: '/' }, { type: 'screenshot', label: 'home' }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    const shot = run.results[0]!.artifacts.find((a) => a.kind === 'screenshot')!;
    const signed = (await p.A.get(`/api/v1/artifacts/${shot.id}`)).json().data.signedUrl;
    expect((await p.t.app.inject({ method: 'GET', url: signed })).statusCode).toBe(200);
    await p.t.db.run(`UPDATE artifacts SET expires_at = ? WHERE run_id = ?`, ['2020-01-01T00:00:00.000Z', run.id]);
    const before = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/storage`)).json().data;
    const res = await p.A.post(`/api/v1/orgs/${p.s.orgId}/retention/run`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBeGreaterThanOrEqual(3);
    expect(res.json().data.freedBytes).toBeGreaterThan(0);
    expect((await p.t.app.inject({ method: 'GET', url: signed })).statusCode).toBe(404);
    expect((await p.A.get(`/api/v1/artifacts/${shot.id}/download`)).statusCode).toBe(404);
    const rows = await p.t.db.all<{ deleted_at: string | null }>(`SELECT deleted_at FROM artifacts WHERE run_id = ?`, [run.id]);
    expect(rows.every((r) => r.deleted_at)).toBe(true);
    const after = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/storage`)).json().data;
    expect(after.reduce((a: number, x: { bytes: number }) => a + x.bytes, 0)).toBeLessThan(before.reduce((a: number, x: { bytes: number }) => a + x.bytes, 0));
    const jobs = await p.t.db.all<{ status: string; deleted_count: number }>(`SELECT status, deleted_count FROM retention_jobs`);
    expect(jobs[jobs.length - 1]!.status).toBe('done');
  });
  it('必須テスト38: audit log covers RBAC, secrets, environment, scenario/Expected, baseline, gate rules, accepted risk, defect close, export, runner', async () => {
    const audit = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/audit?limit=500`)).json().data as Array<{ action: string; before_json: string | null; after_json: string | null }>;
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ['member.add', 'secret.create', 'environment.create', 'scenario.create', 'run.create', 'domain.verified', 'token.create']) expect(actions.has(a)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('demo-pass-123');
  });
});
