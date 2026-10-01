import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import JSZip from 'jszip';
import { createPipeline, type Pipeline } from '../helpers/pipeline.js';
import { api, signup } from '../helpers/app.js';

let p: Pipeline;
beforeAll(async () => { p = await createPipeline(); }, 120_000);
afterAll(async () => { await p.close(); });

const SECRET = 'demo-pass-123';

describe('Phase 3: run lifecycle with a real Chromium runner', () => {
  it('passes a healthy scenario and records steps, metrics, console/network summaries', async () => {
    const sc = await p.createScenario({ title: 'Landing loads', steps: [{ type: 'navigate', url: '/' }, { type: 'assert_title', title: 'Sample SaaS' }, { type: 'assert_element', target: { role: 'link', name: 'Start free trial' }, state: 'visible' }, { type: 'screenshot', label: 'landing' }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('passed');
    expect(run.counts.passed).toBe(1);
    const r = run.results[0]!;
    expect(r.outcomeDetail).toBe('passed_first_try');
    expect(r.steps.length).toBe(4);
    expect(r.metrics?.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(r.artifacts.some((a) => a.kind === 'screenshot' && a.label === 'landing')).toBe(true);
    expect(r.artifacts.some((a) => a.kind === 'console')).toBe(true);
    expect(r.artifacts.some((a) => a.kind === 'network')).toBe(true);
    expect(r.artifacts.some((a) => a.kind === 'trace')).toBe(false); // trace only on failure
    expect(r.artifacts.some((a) => a.kind === 'video')).toBe(false);
    expect(run.jobs[0]!.status).toBe('done');
  });

  it('必須テスト6/4: failing scenario gets screenshot+DOM+trace+video evidence; secrets never appear in any evidence', async () => {
    const sc = await p.createScenario({ title: 'Login shows error on invalid credentials', steps: [
      { type: 'navigate', url: '/login' },
      { type: 'fill', target: { label: 'Email' }, value: 'wrong@example.com' },
      { type: 'fill', target: { label: 'Password' }, value: '{{secret:LOGIN_PASSWORD}}' },
      { type: 'click', target: { role: 'button', name: 'Log in' } },
      { type: 'assert_text', text: 'Invalid email or password', match: 'contains' },
    ], requirementIds: [] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('failed');
    const r = run.results[0]!;
    expect(r.status).toBe('failed');
    expect(r.outcomeDetail).toBe('failed_first_try');
    expect(r.failure?.type).toBe('assertion');
    expect(r.failure?.stepIndex).toBe(4);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    const kinds = r.artifacts.map((a) => a.kind);
    for (const k of ['screenshot', 'dom', 'trace', 'video', 'console', 'network']) expect(kinds).toContain(k);
    // nothing in the API response contains the secret
    expect(JSON.stringify(run)).not.toContain(SECRET);
    // artifacts: dom / console / network / trace do not contain the secret
    for (const a of r.artifacts.filter((x) => ['dom', 'console', 'network', 'trace'].includes(x.kind))) {
      const res = await p.A.get(`/api/v1/artifacts/${a.id}/download`);
      expect(res.statusCode).toBe(200);
      const body = res.rawPayload;
      if (a.kind === 'trace') {
        const zip = await JSZip.loadAsync(body);
        let hits = 0; let entries = 0;
        for (const [name, f] of Object.entries(zip.files)) { if (f.dir) continue; entries++; const txt = (await f.async('nodebuffer')).toString('utf8'); if (txt.includes(SECRET)) { hits++; console.log('secret leaked in trace entry', name); } }
        expect(entries).toBeGreaterThan(2);
        expect(hits).toBe(0);
      } else {
        expect(body.toString('utf8')).not.toContain(SECRET);
      }
    }
    // audit log and DB rows do not contain the secret either
    const rows = await p.t.db.all<{ failure_json: string | null; steps_json: string | null }>(`SELECT failure_json, steps_json FROM test_results`);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it('必須テスト7: trace/screenshot artifacts are reachable only via valid, unexpired signed URLs or authorized sessions', async () => {
    const run = (await p.A.get(`/api/v1/projects/${p.project.id}/runs?status=failed`)).json().data[0];
    const detail = await p.getRun(run.id);
    const trace = detail.results[0]!.artifacts.find((a) => a.kind === 'trace')!;
    const meta = await p.A.get(`/api/v1/artifacts/${trace.id}`);
    expect(meta.statusCode).toBe(200);
    const signed = meta.json().data.signedUrl as string;
    expect((await p.t.app.inject({ method: 'GET', url: signed })).statusCode).toBe(200);
    expect((await p.t.app.inject({ method: 'GET', url: signed.replace(/sig=.{5}/, 'sig=XXXXX') })).statusCode).toBe(403);
    const expired = `/artifacts/${trace.id}?exp=${Math.floor(Date.now() / 1000) - 10}&sig=abc`;
    expect((await p.t.app.inject({ method: 'GET', url: expired })).statusCode).toBe(403);
    expect((await p.t.app.inject({ method: 'GET', url: `/api/v1/artifacts/${trace.id}/download` })).statusCode).toBe(401);
    // another tenant cannot read it even when authenticated
    const b = await signup(p.t.app, 'other@b.example', 'Other Org');
    expect((await api(p.t.app, { cookie: b.cookie }).get(`/api/v1/artifacts/${trace.id}`)).statusCode).toBe(404);
    expect((await api(p.t.app, { cookie: b.cookie }).get(`/api/v1/runs/${run.id}`)).statusCode).toBe(404);
    // signed URL TTL is bounded by config
    expect(Number(new URL(signed, 'http://x').searchParams.get('exp'))).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + p.t.cfg.artifactUrlTtlSec + 1);
  });

  it('必須テスト5: infrastructure error (missing browser) is separated from test failure and retried once', async () => {
    const sc = await p.createScenario({ title: 'Landing on webkit', steps: [{ type: 'navigate', url: '/' }, { type: 'assert_title', title: 'Sample SaaS' }] });
    // The runner advertises webkit although the executable is missing in this environment → launch fails → infra error, never a test failure.
    const { createRunner } = await import('@proofflow/runner/index');
    const bad = createRunner({ controlUrl: p.controlUrl, token: p.runnerToken, name: 'webkit-claimer', browsers: ['webkit'], allowPrivateNetwork: true, log: () => undefined });
    await bad.register();
    const r0 = await p.A.post(`/api/v1/projects/${p.project.id}/runs`, { environmentId: p.env.id, scenarioIds: [sc.id], matrix: { browsers: ['webkit'], viewports: [{ width: 1280, height: 800 }], retries: 0 } });
    expect(r0.statusCode).toBe(202);
    const runId = r0.json().data.id as string;
    await bad.drain();
    let run = await p.getRun(runId);
    expect(run.jobs[0]!.attempt).toBe(1);
    expect(['queued', 'running']).toContain(run.status); // requeued for a second attempt
    await new Promise((r) => setTimeout(r, 5500));
    await bad.drain();
    run = await p.getRun(runId);
    expect(run.status).toBe('infra_error');
    expect(run.results[0]!.status).toBe('infra_error');
    expect(run.results[0]!.outcomeDetail).toBe('infra_error');
    expect(run.results[0]!.failure?.message).toMatch(/browser launch failed|Executable doesn't exist/);
    expect(run.counts.failed).toBe(0);
    expect(run.counts.infraError).toBe(1);
    await bad.stop();
  });

  it('必須テスト19: passed after retry is reported as flaky, not hidden as passed', async () => {
    const sc = await p.createScenario({ title: 'Flaky widget shows Ready', steps: [{ type: 'navigate', url: '/flaky' }, { type: 'assert_text', target: { css: '#state' }, text: 'Ready', match: 'exact' }] });
    await fetch(`${p.sampleUrl}/__sample/reset`);
    const run = await p.runAndWait({ scenarioIds: [sc.id], matrix: { browsers: ['chromium'], viewports: [{ width: 1280, height: 800 }], retries: 1, video: 'on_retry', trace: 'on_failure' } });
    expect(run.status).toBe('flaky');
    const r = run.results[0]!;
    expect(r.status).toBe('flaky');
    expect(r.outcomeDetail).toBe('passed_after_retry');
    expect(r.attempts).toBe(2);
    expect(r.attemptsDetail.map((a) => a.status)).toEqual(['failed', 'passed']);
    expect(run.counts.passedAfterRetry).toBe(0);
    expect(run.counts.flaky).toBe(1);
    expect(run.counts.passed).toBe(0);
  });

  it('必須テスト3: destructive scenario on production is refused at run creation', async () => {
    const prod = await p.A.post(`/api/v1/projects/${p.project.id}/environments`, { name: 'Production', kind: 'production', baseUrl: 'https://www.example.com' });
    expect(prod.statusCode).toBe(201);
    const sc = await p.createScenario({ title: 'Delete account via API', steps: [{ type: 'api_request', method: 'DELETE', url: '/api/account', expectStatus: 204 }] });
    expect((await p.A.get(`/api/v1/projects/${p.project.id}/scenarios/${sc.id}`)).json().data.destructive).toBe(true);
    const r = await p.A.post(`/api/v1/projects/${p.project.id}/runs`, { environmentId: prod.json().data.id, scenarioIds: [sc.id] });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('destructive_denied');
    // even with allowDestructive, policy=deny wins; after explicit policy change still needs allowDestructive + permission
    await p.A.patch(`/api/v1/projects/${p.project.id}/environments/${prod.json().data.id}`, { destructivePolicy: 'allow', confirmProductionDestructive: true });
    const r2 = await p.A.post(`/api/v1/projects/${p.project.id}/runs`, { environmentId: prod.json().data.id, scenarioIds: [sc.id] });
    expect(r2.statusCode).toBe(403);
    expect(r2.json().error.code).toBe('destructive_confirmation_required');
    const nonDestructive = await p.createScenario({ title: 'Read-only', steps: [{ type: 'navigate', url: '/' }] });
    const r3 = await p.A.post(`/api/v1/projects/${p.project.id}/runs`, { environmentId: prod.json().data.id, scenarioIds: [nonDestructive.id] });
    expect(r3.statusCode).toBe(202); // read-only scenarios are fine on production (queued; no runner picks it up here)
    await p.A.post(`/api/v1/runs/${r3.json().data.id}/cancel`);
  });

  it('login profile + run events + cancel', async () => {
    const sc = await p.createScenario({ title: 'Dashboard after login', steps: [{ type: 'login_profile' }, { type: 'assert_url', url: '/dashboard' }, { type: 'assert_text', text: 'Welcome back' }] });
    const events: string[] = [];
    p.t.app.svc.runs.events.on('any', (e: { event: string }) => events.push(e.event));
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('passed');
    expect(events).toContain('run.queued'); expect(events).toContain('job.completed'); expect(events).toContain('run.completed');
    expect(JSON.stringify(run)).not.toContain(SECRET);
  });
});
