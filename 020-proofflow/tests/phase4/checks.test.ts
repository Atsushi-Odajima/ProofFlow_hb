import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPipeline, type Pipeline } from '../helpers/pipeline.js';

let p: Pipeline;
beforeAll(async () => { p = await createPipeline(); }, 120_000);
afterAll(async () => { await p.close(); });

describe('Phase 4: console / network / form / upload / download / API checks', () => {
  it('必須テスト8: console rule — errors are evidence by default and only fail when asserted (with ignore rules)', async () => {
    const noAssert = await p.createScenario({ title: 'Signup page loads (no console assertion)', steps: [{ type: 'navigate', url: '/signup' }, { type: 'wait', ms: 200 }, { type: 'assert_element', target: { role: 'button', name: 'Create account' } }] });
    let run = await p.runAndWait({ scenarioIds: [noAssert.id] });
    expect(run.status).toBe('passed'); // console error present but not asserted
    expect(run.results[0]!.consoleSummary!.uncaught).toBeGreaterThanOrEqual(1);
    const withAssert = await p.createScenario({ title: 'Signup page has no console errors', steps: [{ type: 'navigate', url: '/signup' }, { type: 'wait', ms: 200 }, { type: 'assert_console', maxErrors: 0 }] });
    run = await p.runAndWait({ scenarioIds: [withAssert.id] });
    expect(run.status).toBe('failed');
    expect(run.results[0]!.failure?.type).toBe('console');
    expect(run.results[0]!.failure?.message).toContain('widget init failed');
    const ignored = await p.createScenario({ title: 'Signup console with known-noise ignore', steps: [{ type: 'navigate', url: '/signup' }, { type: 'wait', ms: 200 }, { type: 'assert_console', maxErrors: 0, ignorePatterns: ['widget init failed'] }] });
    run = await p.runAndWait({ scenarioIds: [ignored.id] });
    expect(run.status).toBe('passed');
  });

  it('必須テスト9: network 500 detection on dashboard profile API', async () => {
    const sc = await p.createScenario({ title: 'Dashboard has no 5xx', steps: [{ type: 'login_profile' }, { type: 'wait', ms: 1800 }, { type: 'assert_network', noStatusAtLeast: 500 }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('failed');
    expect(run.results[0]!.failure?.type).toBe('network');
    expect(run.results[0]!.failure?.message).toContain('/api/profile');
    expect(run.results[0]!.failure?.status).toBe(500);
    expect(run.results[0]!.networkSummary!.status5xx).toBeGreaterThanOrEqual(1);
    await p.setBugs({ profileApi500: false });
    const run2 = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run2.status).toBe('passed');
    await p.setBugs({ profileApi500: true });
  });

  it('必須テスト15: form double submit is detected, required validation works', async () => {
    const sc = await p.createScenario({ title: 'Signup form guards double submit', steps: [
      { type: 'navigate', url: '/signup' },
      { type: 'form_check', target: { css: '#signup-form' }, submitTarget: { css: '#signup-submit' }, expectErrorOnEmpty: true },
      { type: 'fill', target: { label: 'Name' }, value: 'Test User' }, { type: 'fill', target: { label: 'Email' }, value: 'new-user@example.com' }, { type: 'fill', target: { label: 'Password' }, value: 'Passw0rd-xyz' },
      { type: 'form_check', target: { css: '#signup-form' }, submitTarget: { css: '#signup-submit' }, expectDoubleSubmitGuard: true },
    ] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('failed');
    expect(run.results[0]!.failure?.type).toBe('form');
    expect(run.results[0]!.failure?.message).toContain('double submit');
    await p.setBugs({ signupDoubleSubmit: false });
    await fetch(`${p.sampleUrl}/__sample/reset`);
    const run2 = await p.runAndWait({ scenarioIds: [sc.id] });
    if (run2.status !== 'passed') console.log('double-submit run2 failure:', JSON.stringify(run2.results[0]!.failure), JSON.stringify(run2.results[0]!.checks));
    expect(run2.status).toBe('passed');
    await p.setBugs({ signupDoubleSubmit: true });
  });

  it('必須テスト16: upload of an invalid file type must be rejected by the app', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    expect((await p.t.app.inject({ method: 'PUT', url: `/api/v1/projects/${p.project.id}/fixtures?name=avatar.png`, headers: { cookie: p.s.cookie, 'content-type': 'image/png' }, payload: png })).statusCode).toBe(201);
    expect((await p.t.app.inject({ method: 'PUT', url: `/api/v1/projects/${p.project.id}/fixtures?name=notes.txt`, headers: { cookie: p.s.cookie, 'content-type': 'text/plain' }, payload: 'hello' })).statusCode).toBe(201);
    expect((await p.t.app.inject({ method: 'PUT', url: `/api/v1/projects/${p.project.id}/fixtures?name=evil.exe`, headers: { cookie: p.s.cookie, 'content-type': 'application/octet-stream' }, payload: 'MZ' })).statusCode).toBe(400);
    const ok = await p.createScenario({ title: 'Avatar upload accepts PNG', steps: [{ type: 'login_profile' }, { type: 'navigate', url: '/settings' }, { type: 'upload', target: { label: 'Avatar (PNG/JPEG)' }, fixture: 'avatar.png' }, { type: 'click', target: { css: '#avatar-submit' } }, { type: 'assert_text', target: { css: '#avatar-msg' }, text: 'Uploaded avatar.png' }] });
    const bad = await p.createScenario({ title: 'Avatar upload rejects text files', steps: [{ type: 'login_profile' }, { type: 'navigate', url: '/settings' }, { type: 'upload', target: { label: 'Avatar (PNG/JPEG)' }, fixture: 'notes.txt' }, { type: 'click', target: { css: '#avatar-submit' } }, { type: 'assert_text', target: { css: '#avatar-msg' }, text: 'Rejected' }] });
    const run = await p.runAndWait({ scenarioIds: [ok.id, bad.id] });
    const byKey = Object.fromEntries(run.results.map((r) => [r.scenario!.key, r]));
    expect(byKey[ok.key]!.status).toBe('passed');
    expect(byKey[bad.key]!.status).toBe('failed'); // app accepted an invalid type (seeded bug)
    await p.setBugs({ uploadInvalidTypeAccepted: false });
    const run2 = await p.runAndWait({ scenarioIds: [bad.id] });
    expect(run2.status).toBe('passed');
    await p.setBugs({ uploadInvalidTypeAccepted: true });
  });

  it('必須テスト17: download filename and MIME are verified and the file is kept as evidence', async () => {
    const sc = await p.createScenario({ title: 'Report download is report.csv text/csv', steps: [{ type: 'login_profile' }, { type: 'download', target: { css: '#export' }, expectFilename: 'report.csv', expectMime: 'text/csv' }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('failed');
    expect(run.results[0]!.failure?.type).toBe('download');
    expect(run.results[0]!.failure?.message).toContain('filename');
    expect(run.results[0]!.artifacts.some((a) => a.kind === 'download')).toBe(true);
    await p.setBugs({ downloadFilenameError: false });
    const run2 = await p.runAndWait({ scenarioIds: [sc.id] });
    if (run2.status !== 'passed') console.log('download run2 failure:', JSON.stringify(run2.results[0]!.failure));
    expect(run2.status).toBe('passed');
    expect((run2.results[0]!.checks as { downloads: Array<{ filename: string; mime: string }> }).downloads[0]).toMatchObject({ filename: 'report.csv', mime: 'text/csv' });
    await p.setBugs({ downloadFilenameError: true });
  });

  it('必須テスト18: API JSON schema failure + status + latency; OpenAPI import and breaking-change candidates', async () => {
    await p.setBugs({ profileApi500: false, slowApi: false });
    const schema = { type: 'object', required: ['id', 'email', 'name', 'plan'], properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, plan: { type: 'string' } } };
    const sc = await p.createScenario({ title: 'Profile API contract', steps: [
      { type: 'api_request', method: 'POST', url: '/api/auth/login', body: { email: '{{secret:LOGIN_EMAIL}}', password: '{{secret:LOGIN_PASSWORD}}' }, expectStatus: 200, saveAs: 'login' },
      { type: 'api_request', method: 'GET', url: '/api/profile', headers: { authorization: 'Bearer {{var:login.token}}' }, expectStatus: 200, expectSchema: schema, expectJsonPath: [{ path: 'email', equals: 'demo@example.com' }], maxLatencyMs: 3000 },
    ] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('failed');
    expect(run.results[0]!.failure?.type).toBe('api_contract');
    expect(run.results[0]!.failure?.message).toContain('plan');
    expect(JSON.stringify(run)).not.toContain('demo-pass-123');
    await p.setBugs({ apiSchemaBreak: false });
    const run2 = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run2.status).toBe('passed');
    expect((run2.results[0]!.checks as { api: Array<{ latencyMs: number; status: number }> }).api.length).toBe(2);
    // latency budget
    await p.setBugs({ slowApi: true });
    const slow = await p.createScenario({ title: 'Profile API latency', steps: [{ type: 'api_request', method: 'POST', url: '/api/auth/login', body: { email: 'demo@example.com', password: '{{secret:LOGIN_PASSWORD}}' }, saveAs: 'login' }, { type: 'api_request', method: 'GET', url: '/api/profile', headers: { authorization: 'Bearer {{var:login.token}}' }, maxLatencyMs: 500 }] });
    const run3 = await p.runAndWait({ scenarioIds: [slow.id] });
    expect(run3.status).toBe('failed');
    expect(run3.results[0]!.failure?.type).toBe('performance');
    await p.setBugs({ slowApi: false, apiSchemaBreak: true, profileApi500: true });
    // OpenAPI inventory + contract diff
    const v1 = { openapi: '3.0.0', paths: { '/api/profile': { get: { operationId: 'getProfile', responses: { '200': { content: { 'application/json': { schema: { type: 'object', required: ['id', 'plan'], properties: { id: { type: 'string' }, plan: { type: 'string' } } } } } } } } }, '/api/export.csv': { get: { responses: { '200': {} } } } } };
    const r1 = await p.A.post(`/api/v1/projects/${p.project.id}/openapi`, { spec: v1, source: 'v1' });
    expect(r1.statusCode).toBe(201); expect(r1.json().data.isBaseline).toBe(true); expect(r1.json().data.endpoints.length).toBe(2);
    const v2 = { openapi: '3.0.0', paths: { '/api/profile': { get: { operationId: 'getProfile', responses: { '200': { content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, plan: { type: 'integer' } } } } } } } } } } };
    const r2 = await p.A.post(`/api/v1/projects/${p.project.id}/openapi`, { spec: v2, source: 'v2' });
    expect(r2.statusCode).toBe(201); expect(r2.json().data.isBaseline).toBe(false);
    const diff = r2.json().data.diffFromBaseline;
    expect(diff.removed).toContain('GET /api/export.csv');
    expect(diff.breakingCandidates.join('\n')).toMatch(/required fields removed: plan/);
    expect(diff.breakingCandidates.join('\n')).toMatch(/"plan" type changed/);
    expect((await p.A.post(`/api/v1/projects/${p.project.id}/openapi`, { spec: { info: {} } })).statusCode).toBe(400);
  });

  it('SSE run events endpoint streams a snapshot', async () => {
    const run = (await p.A.get(`/api/v1/projects/${p.project.id}/runs?limit=1`)).json().data[0];
    const ctrl = new AbortController();
    const res = await fetch(`${p.controlUrl}/api/v1/runs/${run.id}/events`, { headers: { cookie: p.s.cookie }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value!).toString()).toContain('event: snapshot');
    ctrl.abort();
  });
});
