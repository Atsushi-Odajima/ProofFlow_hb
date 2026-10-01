/**
 * E2E-1 … E2E-10 (【E2E】 in the product brief) on the seeded Sample SaaS with a real Chromium runner.
 * Firefox / WebKit are accepted by the matrix schema and runner capability negotiation, but this environment has no
 * Firefox / WebKit binaries, so every browser run here is Chromium (TEST_REPORT.md lists this as unverified).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPipeline, type Pipeline, type RunDetail } from '../helpers/pipeline.js';
import { createTestApp, api, login, createToken, type TestApp } from '../helpers/app.js';
import { seedSample, type SeedResult } from '@proofflow/server/seed/sample';
import { ProofFlowApi } from '@proofflow/cli/api';
import { buildMcpServer } from '@proofflow/mcp/index';

let p: Pipeline; let seed: SeedResult; let P: string; let restored: TestApp | null = null;
beforeAll(async () => {
  p = await createPipeline({ projectName: 'Pipeline (empty)', env: { PROOFFLOW_AI_PROVIDER: 'mock' } });
  await p.A.patch(`/api/v1/orgs/${p.s.orgId}`, { settings: { ai: { enabled: true, sendArtifacts: false } } });
  seed = await seedSample(p.t.app, { sampleUrl: p.sampleUrl, account: { cookie: p.s.cookie, orgId: p.s.orgId, userId: p.s.userId } });
  P = `/api/v1/projects/${seed.projectId}`;
}, 180_000);
afterAll(async () => { await restored?.close(); await p.close(); });

const ALL_OFF = { mobileCtaOffscreen: false, loginInvalidErrorMissing: false, signupDoubleSubmit: false, profileApi500: false, visualButtonShift: false, brokenLink: false, consoleException: false, downloadFilenameError: false, uploadInvalidTypeAccepted: false, a11yMissingLabel: false, apiSchemaBreak: false, slowApi: false } as const;
async function run(input: Record<string, unknown>): Promise<RunDetail> {
  const r = await p.A.post(`${P}/runs`, { environmentId: seed.envId, trigger: 'manual', ...input });
  if (r.statusCode !== 202 && r.statusCode !== 200) throw new Error(`run create failed ${r.statusCode} ${r.body}`);
  await p.runner.drain();
  return p.getRun(r.json().data.id);
}
const failedOf = (d: RunDetail) => d.results.filter((r) => r.status === 'failed');

describe('E2E flows on the Sample SaaS', () => {
  it('E2E-1: Project → Staging env → Requirement → AI draft → Scenario → browser run → failure evidence → Defect → fix → Retest → Verified', async () => {
    // a staging environment on a public hostname is accepted but unverified → low-load mode until the domain is verified (DOMAIN_VERIFICATION.md)
    const staging = await p.A.post(`${P}/environments`, { name: 'Staging', kind: 'staging', baseUrl: 'https://staging.sample-saas.example', testDataPolicy: 'fixture' });
    expect(staging.statusCode).toBe(201);
    const dom = await p.A.post(`${P}/domains`, { hostname: 'staging.sample-saas.example', method: 'dns_txt' });
    expect(dom.statusCode).toBe(201); expect(dom.json().data.status).toBe('pending');
    // requirement → AI draft (mock provider; no network) → apply one suggestion → scenario linked to the requirement
    const reqId = seed.requirements['login-error']!;
    const draft = await p.A.post(`${P}/ai/scenario-draft`, { prompt: 'ログイン失敗時のエラー表示を確認するシナリオ', requirementId: reqId, targetUrl: '/login' });
    expect(draft.statusCode).toBe(201);
    const sug = draft.json().data; expect(sug.status).toBe('proposed'); expect(sug.output.drafts.length).toBeGreaterThan(0);
    const applied = await p.A.post(`${P}/ai/suggestions/${sug.id}/apply`, { indexes: [0] });
    expect(applied.statusCode).toBe(200);
    const aiScenarioId = applied.json().data.scenarioIds[0] as string;
    expect((await p.A.get(`${P}/scenarios/${aiScenarioId}`)).json().data.origin).toBe('ai_draft');
    // run the hand-written login-error scenario on the local environment (the same app the staging env would point at) — Chromium only here
    const matrix = { browsers: ['chromium'], viewports: [{ width: 1280, height: 800, name: 'desktop' }], retries: 0, video: 'on_failure', trace: 'on_failure' };
    const r1 = await run({ scenarioIds: [seed.scenarios['crit-login-error']], matrix, label: 'E2E-1 login error' });
    expect(r1.status).toBe('failed');
    const f = failedOf(r1)[0]!;
    expect(f.failure?.type).toBe('assertion');
    for (const k of ['screenshot', 'dom', 'console', 'network', 'trace', 'video']) expect(f.artifacts.map((a) => a.kind)).toContain(k);
    const defect = (await p.A.post(`${P}/defects/from-result`, { resultId: f.id, severity: 'critical' })).json().data as { id: string; key: string; status: string };
    expect(defect.key).toMatch(/^DEF-\d+$/);
    expect(((await p.A.get(`${P}/requirements/${reqId}/traceability`)).json().data.scenarios as Array<{ defects: unknown[] }>).some((s) => s.defects.length > 0)).toBe(true);
    // fix + retest → verified
    await p.setBugs({ loginInvalidErrorMissing: false });
    await p.A.patch(`${P}/defects/${defect.id}`, { status: 'ready_for_retest' });
    const rt = await p.A.post(`${P}/defects/${defect.id}/retest`, {}); expect([200, 201, 202]).toContain(rt.statusCode);
    await p.runner.drain();
    expect((await p.A.get(`${P}/defects/${defect.id}`)).json().data.status).toBe('verified');
    await p.setBugs({ loginInvalidErrorMissing: true });
  });

  it('E2E-2: landing baseline → CSS change → visual diff → review → intended change becomes a new baseline with history', async () => {
    await p.setBugs({ visualButtonShift: false });
    const matrix = { browsers: ['chromium'], viewports: [{ width: 1280, height: 800, name: 'desktop' }], retries: 0 };
    const base = await run({ scenarioIds: [seed.scenarios['visual-landing']], matrix, label: 'E2E-2 baseline' });
    expect(base.status).toBe('passed');
    let cmps = (await p.A.get(`${P}/visual/comparisons?runId=${base.id}`)).json().data as Array<{ id: string; status: string }>;
    expect(cmps[0]!.status).toBe('new_baseline_needed');
    expect((await p.A.post(`${P}/visual/approve`, { comparisonIds: [cmps[0]!.id], reason: '1.1.0 の確定デザイン' })).statusCode).toBe(200);
    await p.setBugs({ visualButtonShift: true }); // "CSS change"
    const diff = await run({ scenarioIds: [seed.scenarios['visual-landing']], matrix, label: 'E2E-2 css change' });
    expect(diff.status).toBe('failed'); expect(failedOf(diff)[0]!.failure?.type).toBe('visual');
    cmps = (await p.A.get(`${P}/visual/comparisons?runId=${diff.id}`)).json().data;
    expect(cmps[0]!.status).toBe('diff');
    // review: this time the change is intended → approve with a reason → history records from/to
    expect((await p.A.post(`${P}/visual/approve`, { comparisonIds: [cmps[0]!.id], reason: 'CTA の余白変更は意図したデザイン更新 (PR #42)' })).statusCode).toBe(200);
    const hist = (await p.A.get(`${P}/baselines/history?kind=visual`)).json().data as Array<{ action: string; reason: string; from_ref: string | null; to_ref: string | null }>;
    expect(hist[0]!.action).toBe('update'); expect(hist[0]!.reason).toContain('PR #42'); expect(hist[0]!.from_ref).toBeTruthy();
    const again = await run({ scenarioIds: [seed.scenarios['visual-landing']], matrix, label: 'E2E-2 after approval' });
    expect(again.status).toBe('passed');
    await p.setBugs({ visualButtonShift: false });
  });

  it('E2E-3: desktop passes, mobile viewport fails → Defect → fix → mobile passes', async () => {
    const matrix = { browsers: ['chromium'], viewports: [{ width: 1280, height: 800, name: 'desktop' }, { width: 390, height: 844, name: 'iPhone 15', isMobile: true, hasTouch: true, deviceScaleFactor: 3 }], retries: 0 };
    const r = await run({ scenarioIds: [seed.scenarios['mobile-landing']], matrix, label: 'E2E-3 mobile' });
    expect(r.status).toBe('failed');
    expect(r.results.find((x) => x.viewport.width === 1280)!.status).toBe('passed');
    const mobile = r.results.find((x) => x.viewport.width === 390)!;
    expect(mobile.status).toBe('failed'); expect(mobile.failure?.type).toBe('responsive');
    const d = (await p.A.post(`${P}/defects/from-result`, { resultId: mobile.id, severity: 'high' })).json().data as { id: string; viewport: { width: number } };
    expect(d.viewport.width).toBe(390);
    await p.setBugs({ mobileCtaOffscreen: false });
    await p.A.patch(`${P}/defects/${d.id}`, { status: 'ready_for_retest' });
    await p.A.post(`${P}/defects/${d.id}/retest`, {}); await p.runner.drain();
    expect((await p.A.get(`${P}/defects/${d.id}`)).json().data.status).toBe('verified');
    await p.setBugs({ mobileCtaOffscreen: true });
  });

  it('E2E-4: Critical suite passes but the manual iPhone check is missing → gate BLOCKED → device check with evidence → READY', async () => {
    await p.setBugs(ALL_OFF); await fetch(`${p.sampleUrl}/__sample/reset`);
    const crit = await run({ suiteId: seed.suites['Critical'], releaseCandidateId: seed.rcId, label: 'E2E-4 critical' });
    expect(['passed', 'flaky']).toContain(crit.status);
    expect(crit.counts.failed).toBe(0);
    let ev = (await p.A.post(`${P}/releases/${seed.rcId}/evaluate`)).json().data as { result: string; rules: Array<{ pass: boolean; rule: { type: string }; message: string }> };
    expect(ev.result).toBe('BLOCKED');
    expect(ev.rules.filter((x) => !x.pass).map((x) => x.rule.type)).toContain('manual_check_required');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    const up = await p.t.app.inject({ method: 'PUT', url: `${P}/manual-evidence?label=iphone-login`, headers: { cookie: p.s.cookie, 'content-type': 'image/png' }, payload: png });
    expect(up.statusCode).toBe(201);
    expect((await p.A.post(`${P}/manual-checks`, { manualCaseId: seed.manualCaseId, releaseCandidateId: seed.rcId, label: 'iPhone smoke', device: 'iPhone 15 (iOS 18.6)', browser: 'Safari', result: 'pass', notes: '実機で確認', artifactIds: [up.json().data.id] })).statusCode).toBe(201);
    ev = (await p.A.post(`${P}/releases/${seed.rcId}/evaluate`)).json().data;
    const blocking = ev.rules.filter((x) => !x.pass).map((x) => `${x.rule.type}: ${x.message}`);
    expect(blocking, blocking.join('\n')).toEqual([]);
    expect(ev.result).toBe('READY');
  });

  it('E2E-5: API contract breaking response → failure with schema detail → Defect', async () => {
    await p.setBugs({ apiSchemaBreak: true, slowApi: false, profileApi500: false });
    const r = await run({ scenarioIds: [seed.scenarios['api-profile-contract']], matrix: { browsers: ['chromium'], viewports: [{ width: 1280, height: 800 }], retries: 0 }, label: 'E2E-5 contract' });
    expect(r.status).toBe('failed');
    const f = failedOf(r)[0]!;
    expect(f.failure?.type).toBe('api_contract'); expect(f.failure?.message).toContain('plan');
    expect(JSON.stringify(r)).not.toContain('demo-pass-123');
    const d = (await p.A.post(`${P}/defects/from-result`, { resultId: f.id, severity: 'critical' })).json().data as { key: string; title: string };
    expect(d.title).toContain('profile API');
    await p.setBugs({ apiSchemaBreak: false });
  });

  it('E2E-6: ChatGPT/Codex plugin: "release前check" → run_test_suite → get_test_run → summarize_failures → get_release_gate (all through MCP tools)', async () => {
    const token = await createToken(p.t.app, p.s, { kind: 'mcp', role: 'qa_lead', name: 'chatgpt', projectIds: [seed.projectId] });
    const server = buildMcpServer(new ProofFlowApi(p.controlUrl, token));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'e2e-chatgpt', version: '1.0' }); await client.connect(ct);
    await p.setBugs({ loginInvalidErrorMissing: true, brokenLink: true });
    const started = client.callTool({ name: 'run_test_suite', arguments: { project: seed.projectId, suite: 'Critical', environment: seed.envId, wait: true } });
    await new Promise((r) => setTimeout(r, 500)); await p.runner.drain();
    const res = (await started) as unknown as { structuredContent: { runId: string; status: string; failures: Array<{ resultId: string }> } };
    expect(res.structuredContent.status).toBe('failed');
    expect(res.structuredContent.failures.length).toBeGreaterThanOrEqual(2);
    const detail = (await client.callTool({ name: 'get_test_run', arguments: { runId: res.structuredContent.runId } })) as unknown as { structuredContent: { status: string } };
    expect(detail.structuredContent.status).toBe('failed');
    const summary = (await client.callTool({ name: 'summarize_failures', arguments: { runId: res.structuredContent.runId } })) as unknown as { structuredContent: { groups: Array<{ type: string }> }; content: Array<{ text: string }> };
    expect(summary.structuredContent.groups.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(summary)).not.toContain('demo-pass-123');
    const gate = (await client.callTool({ name: 'get_release_gate', arguments: { project: seed.projectId, version: '1.2.0' } })) as unknown as { structuredContent: { result: string; note: string } };
    expect(gate.structuredContent.result).toBe('BLOCKED');
    expect(gate.structuredContent.note).toContain('does not approve');
    await client.close(); await server.close();
    await p.setBugs(ALL_OFF); await fetch(`${p.sampleUrl}/__sample/reset`);
  });

  it('E2E-7: AI coding agent fixes code → related retest from test impact → full Critical regression → results', async () => {
    const impact = await p.A.post(`${P}/test-impact`, { changedFiles: ['src/pages/login.tsx', 'src/api/profile.ts'] });
    expect(impact.statusCode).toBe(200);
    const candidates = impact.json().data.candidates as Array<{ scenarioId: string; key: string; reasons: string[] }>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(impact.json().data.note).toContain('required release-gate suites');
    const agentToken = await createToken(p.t.app, p.s, { kind: 'service', role: 'developer', name: 'coding-agent', projectIds: [seed.projectId] });
    const AG = api(p.t.app, { token: agentToken });
    const related = await AG.post(`${P}/runs`, { environmentId: seed.envId, scenarioIds: candidates.slice(0, 3).map((c) => c.scenarioId), trigger: 'agent', label: 'E2E-7 related retest', commitSha: 'fix-123', changedFiles: ['src/pages/login.tsx'] });
    expect(related.statusCode).toBe(202);
    await p.runner.drain();
    expect((await p.getRun(related.json().data.id)).status).toBe('passed');
    const full = await AG.post(`${P}/runs`, { environmentId: seed.envId, suiteId: seed.suites['Critical'], trigger: 'agent', label: 'E2E-7 full critical', releaseCandidateId: seed.rcId });
    expect(full.statusCode).toBe(202);
    await p.runner.drain();
    const fullRun = await p.getRun(full.json().data.id);
    expect(fullRun.counts.failed).toBe(0);
    const ci = await AG.get(`/api/v1/runs/${fullRun.id}/ci-summary`);
    expect(ci.statusCode).toBe(200); expect(ci.body).toContain('ProofFlow run');
    // the agent cannot approve a release or accept a risk (developer role + token)
    expect((await AG.post(`${P}/releases/${seed.rcId}/release`, {})).statusCode).toBe(403);
  });

  it('E2E-8: destructive scenario on a production environment is refused', async () => {
    const prod = await p.A.post(`${P}/environments`, { name: 'Production', kind: 'production', baseUrl: 'https://www.sample-saas.example' });
    expect(prod.statusCode).toBe(201); expect(prod.json().data.destructivePolicy).toBe('deny');
    const sc = await p.A.post(`${P}/scenarios`, { title: 'Delete account via API', steps: [{ type: 'api_request', method: 'DELETE', url: '/api/account', expectStatus: 204 }] });
    expect(sc.json().data.destructive).toBe(true);
    const r = await p.A.post(`${P}/runs`, { environmentId: prod.json().data.id, scenarioIds: [sc.json().data.id], allowDestructive: true });
    expect(r.statusCode).toBe(403); expect(r.json().error.code).toBe('destructive_denied');
    // a service token cannot change the production destructive policy either
    const svc = api(p.t.app, { token: await createToken(p.t.app, p.s, { kind: 'service', role: 'qa_lead' }) });
    expect((await svc.patch(`${P}/environments/${prod.json().data.id}`, { destructivePolicy: 'allow', confirmProductionDestructive: true })).statusCode).toBe(403);
  });

  it('E2E-9: PII on the tested page is masked in evidence; AI never receives unmasked or restricted artifacts', async () => {
    // The Sample SaaS dashboard greets the account holder by name (#welcome). The seeded environment masks #welcome; the vault password is redacted everywhere.
    await p.setBugs({ profileApi500: false, slowApi: false });
    const pii = await p.A.post(`${P}/scenarios`, { title: 'E2E-9 dashboard shows a text that does not exist (forces evidence capture)', steps: [{ type: 'login_profile' }, { type: 'wait', ms: 1500 }, { type: 'assert_text', text: 'no-such-text-xyz' }] });
    const r = await run({ scenarioIds: [pii.json().data.id], matrix: { browsers: ['chromium'], viewports: [{ width: 1280, height: 800 }], retries: 0, trace: 'always', video: 'off' }, label: 'E2E-9 pii' });
    expect(r.status).toBe('failed');
    const res = r.results[0]!;
    const kinds = res.artifacts.map((a) => a.kind);
    for (const k of ['screenshot', 'dom', 'console', 'network', 'trace']) expect(kinds).toContain(k);
    const dom = (await p.A.get(`/api/v1/artifacts/${res.artifacts.find((a) => a.kind === 'dom')!.id}/download`)).body;
    expect(dom).toContain('[masked]'); expect(dom).not.toContain('Demo User'); expect(dom).not.toContain('demo-pass-123');
    for (const a of res.artifacts.filter((x) => ['console', 'network'].includes(x.kind))) expect((await p.A.get(`/api/v1/artifacts/${a.id}/download`)).body).not.toContain('demo-pass-123');
    expect(JSON.stringify(r)).not.toContain('demo-pass-123');
    // restricted artifact + org policy sendArtifacts=false → the AI failure summary gets neither artifact bodies nor restricted items, and never rewrites the result (必須テスト31)
    const shot = res.artifacts.find((a) => a.kind === 'screenshot')!;
    expect((await p.A.post(`/api/v1/artifacts/${shot.id}/restrict`, { restricted: true })).statusCode).toBe(200);
    const sum = await p.A.post(`/api/v1/results/${res.id}/ai/failure-summary`, {});
    expect(sum.statusCode).toBe(201);
    expect(JSON.stringify(sum.json())).not.toContain('demo-pass-123'); expect(JSON.stringify(sum.json())).not.toContain('Demo User');
    const afterAi = (await p.A.get(`/api/v1/results/${res.id}`)).json().data as { status: string; failure: { message: string } };
    expect(afterAi.status).toBe('failed'); expect(afterAi.failure.message).toBe(res.failure!.message);
    const usage = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/ai/usage`)).json().data;
    expect(JSON.stringify(usage)).not.toContain('demo-pass-123');
    // a viewer cannot open the restricted screenshot (404: its existence is not even confirmed); the owner can
    await p.A.post(`/api/v1/orgs/${p.s.orgId}/members`, { email: 'viewer-e2e@a.example', role: 'viewer', temporaryPassword: 'Viewer-Pass-123456' });
    const V = api(p.t.app, { cookie: await login(p.t.app, 'viewer-e2e@a.example', 'Viewer-Pass-123456') });
    expect((await V.get(`/api/v1/artifacts/${shot.id}/download`)).statusCode).toBe(404);
    expect((await p.A.get(`/api/v1/artifacts/${shot.id}/download`)).statusCode).toBe(200);
    await p.setBugs(ALL_OFF);
  });

  it('E2E-10: backup → restore into an empty environment → Requirement / Scenario / Run / Defect / Gate traceability matches', async () => {
    const reqId = seed.requirements['login-error']!;
    const snapshot = async (A: ReturnType<typeof api>) => ({
      trace: (await A.get(`${P}/requirements/${reqId}/traceability`)).json().data,
      rc: (await A.get(`${P}/releases/${seed.rcId}`)).json().data,
      defects: (await A.get(`${P}/defects`)).json().data,
      runs: (await A.get(`${P}/runs?limit=100`)).json().data,
      suites: (await A.get(`${P}/suites`)).json().data,
    });
    const before = await snapshot(p.A);
    const doc = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/backup`)).json();
    restored = await createTestApp({}, { PROOFFLOW_MASTER_KEY: p.t.cfg.masterKey.toString('base64'), PROOFFLOW_SIGNING_SECRET: p.t.cfg.signingSecret });
    cpSync(join(p.t.dataDir, 'artifacts'), join(restored.dataDir, 'artifacts'), { recursive: true });
    await restored.app.svc.backup.restore(doc);
    const R = api(restored.app, { cookie: await login(restored.app, p.s.email) });
    const after = await snapshot(R);
    expect(after).toEqual(before);
    expect((await R.post(`${P}/releases/${seed.rcId}/evaluate`)).json().data.result).toBe(before.rc.lastGateResult);
  });
});
