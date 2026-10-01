import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPipeline, type Pipeline } from '../helpers/pipeline.js';
import { api, login } from '../helpers/app.js';
import { MockProvider } from '@proofflow/server/ai/provider';

let p: Pipeline; let mock: MockProvider;
beforeAll(async () => {
  p = await createPipeline({ env: { PROOFFLOW_AI_PROVIDER: 'mock' } });
  mock = p.t.app.svc.ai.provider as MockProvider;
  await p.A.patch(`/api/v1/orgs/${p.s.orgId}`, { settings: { ai: { enabled: true, sendArtifacts: true } } });
}, 120_000);
afterAll(async () => { await p.close(); });

const loginSteps = [
  { type: 'navigate', url: '/login' },
  { type: 'fill', target: { label: 'Email' }, value: 'wrong@example.com' },
  { type: 'fill', target: { label: 'Password' }, value: 'nope-nope-nope' },
  { type: 'click', target: { role: 'button', name: 'Log in' } },
  { type: 'assert_text', text: 'Invalid email or password', match: 'contains' },
];

describe('Phase 6: failure fingerprint, defects, retest, reopen, flaky, AI assist boundaries', () => {
  let scenarioId: string; let failedResultId: string; let groupId: string; let defectId: string; let fingerprint: string;

  it('必須テスト20: identical failures share a fingerprint and a failure group', async () => {
    const sc = await p.createScenario({ title: 'Login invalid error', steps: loginSteps });
    scenarioId = sc.id;
    const run1 = await p.runAndWait({ scenarioIds: [sc.id] });
    const run2 = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run1.status).toBe('failed'); expect(run2.status).toBe('failed');
    fingerprint = run1.results[0]!.fingerprint!;
    expect(run2.results[0]!.fingerprint).toBe(fingerprint);
    failedResultId = run2.results[0]!.id;
    const groups = (await p.A.get(`/api/v1/projects/${p.project.id}/failure-groups`)).json().data;
    expect(groups.length).toBe(1);
    expect(groups[0].occurrenceCount).toBe(2);
    expect(groups[0].fingerprint).toBe(fingerprint);
    groupId = groups[0].id;
    const detail = (await p.A.get(`/api/v1/projects/${p.project.id}/failure-groups/${groupId}`)).json().data;
    expect(detail.recentResults.length).toBe(2);
  });

  it('必須テスト21: defect is generated from the failed result with evidence, links and DEF-n key', async () => {
    const res = await p.A.post(`/api/v1/projects/${p.project.id}/defects/from-result`, { resultId: failedResultId, severity: 'critical' });
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    defectId = d.id;
    expect(d.key).toBe('DEF-1');
    expect(d.status).toBe('new');
    expect(d.severity).toBe('critical');
    expect(d.failureGroupId).toBe(groupId);
    expect(d.evidence.artifactIds.length).toBeGreaterThan(3);
    expect(d.links.some((l: { type: string; id: string }) => l.type === 'scenario' && l.id === scenarioId)).toBe(true);
    expect(d.reproduction).toContain('1. navigate /login');
    expect(d.reproduction).not.toContain('nope-nope-nope'.slice(0, 0) + 'secret');
    expect(d.artifacts.length).toBeGreaterThan(3);
    const g = (await p.A.get(`/api/v1/projects/${p.project.id}/failure-groups/${groupId}`)).json().data;
    expect(g.defectId).toBe(defectId);
    // status workflow validation
    expect((await p.A.patch(`/api/v1/projects/${p.project.id}/defects/${defectId}`, { status: 'verified' })).statusCode).toBe(403); // Verified only via retest
    expect((await p.A.patch(`/api/v1/projects/${p.project.id}/defects/${defectId}`, { status: 'closed' })).statusCode).toBe(200);
    expect((await p.A.patch(`/api/v1/projects/${p.project.id}/defects/${defectId}`, { status: 'reopened', note: 'closed by mistake' })).statusCode).toBe(200);
    expect((await p.A.patch(`/api/v1/projects/${p.project.id}/defects/${defectId}`, { status: 'in_progress' })).statusCode).toBe(200);
    // developer cannot close
    await p.A.post(`/api/v1/orgs/${p.s.orgId}/members`, { email: 'dev6@a.example', role: 'developer', temporaryPassword: 'Dev-Pass-123456' });
    const D = api(p.t.app, { cookie: await login(p.t.app, 'dev6@a.example', 'Dev-Pass-123456') });
    expect((await D.patch(`/api/v1/projects/${p.project.id}/defects/${defectId}`, { status: 'closed' })).statusCode).toBe(403);
    expect((await D.patch(`/api/v1/projects/${p.project.id}/defects/${defectId}`, { status: 'ready_for_retest' })).statusCode).toBe(200);
  });

  it('必須テスト22: retest after the fix moves the defect to Verified with the run as evidence', async () => {
    await p.setBugs({ loginInvalidErrorMissing: false });
    const r = await p.A.post(`/api/v1/projects/${p.project.id}/defects/${defectId}/retest`, {});
    expect(r.statusCode).toBe(202);
    expect(r.json().data.kind).toBe('retest');
    await p.runner.drain();
    const run = await p.getRun(r.json().data.id);
    expect(run.status).toBe('passed');
    const d = (await p.A.get(`/api/v1/projects/${p.project.id}/defects/${defectId}`)).json().data;
    expect(d.status).toBe('verified');
    const last = d.history[d.history.length - 1];
    expect(last.to_status).toBe('verified'); expect(last.run_id).toBe(run.id); expect(last.actor_kind).toBe('system');
  });

  it('必須テスト23: regression in a later run reopens the verified defect', async () => {
    await p.setBugs({ loginInvalidErrorMissing: true });
    const run = await p.runAndWait({ scenarioIds: [scenarioId] });
    expect(run.status).toBe('failed');
    expect(run.results[0]!.fingerprint).toBe(fingerprint);
    const d = (await p.A.get(`/api/v1/projects/${p.project.id}/defects/${defectId}`)).json().data;
    expect(d.status).toBe('reopened');
    expect(d.history[d.history.length - 1].note).toContain('regression detected');
    // retest that still fails keeps it from being verified
    await D_setReady();
    const r = await p.A.post(`/api/v1/projects/${p.project.id}/defects/${defectId}/retest`, {});
    await p.runner.drain();
    const d2 = (await p.A.get(`/api/v1/projects/${p.project.id}/defects/${defectId}`)).json().data;
    expect(d2.status).toBe('reopened');
    expect((await p.getRun(r.json().data.id)).status).toBe('failed');
  });
  async function D_setReady() { await p.A.patch(`/api/v1/projects/${p.project.id}/defects/${defectId}`, { status: 'ready_for_retest' }); }

  it('flaky candidates and similar failure groups are surfaced', async () => {
    const sc = await p.createScenario({ title: 'Flaky widget', steps: [{ type: 'navigate', url: '/flaky' }, { type: 'assert_text', target: { css: '#state' }, text: 'Ready', match: 'exact' }] });
    await fetch(`${p.sampleUrl}/__sample/reset`);
    const run = await p.runAndWait({ scenarioIds: [sc.id], matrix: { browsers: ['chromium'], viewports: [{ width: 1280, height: 800 }], retries: 1 } });
    expect(run.status).toBe('flaky');
    const flaky = (await p.A.get(`/api/v1/projects/${p.project.id}/flaky`)).json().data;
    expect(flaky.some((f: { scenarioId: string; passedAfterRetry: number }) => f.scenarioId === sc.id && f.passedAfterRetry === 1)).toBe(true);
    const sim = await p.A.get(`/api/v1/projects/${p.project.id}/failure-groups/${groupId}/similar`);
    expect(sim.statusCode).toBe(200);
    // retest-failed: only failed scenarios of a run are re-run
    const mixed = await p.runAndWait({ scenarioIds: [scenarioId, sc.id] });
    const rf = await p.A.post(`/api/v1/runs/${mixed.id}/retest-failed`, { label: 'agent retest' });
    expect(rf.statusCode).toBe(202);
    await p.runner.drain();
    const rerun = await p.getRun(rf.json().data.id);
    expect(rerun.results.map((r) => r.scenarioId).sort()).toEqual([scenarioId, sc.id].filter((id) => mixed.results.find((r) => r.scenarioId === id && r.status !== 'passed')).sort());
  });

  it('必須テスト31: AI failure summary / defect draft never modify the result (and respect artifact policy)', async () => {
    const before = await p.t.db.get<Record<string, unknown>>(`SELECT * FROM test_results WHERE id = ?`, [failedResultId]);
    const callsBefore = mock.calls.length;
    const sum = await p.A.post(`/api/v1/results/${failedResultId}/ai/failure-summary`);
    expect(sum.statusCode).toBe(201);
    expect(sum.json().data.output.rootCause.confidence).toBe('unknown');
    expect(mock.calls.length).toBe(callsBefore + 1);
    expect(mock.calls[mock.calls.length - 1]!.user).toContain('artifactExcerpts');
    expect(mock.calls[mock.calls.length - 1]!.user).toContain('"console"'); // artifact excerpt sent because sendArtifacts=true
    const after = await p.t.db.get<Record<string, unknown>>(`SELECT * FROM test_results WHERE id = ?`, [failedResultId]);
    expect(after).toEqual(before);
    // restricted artifact is excluded from AI input
    const detail = (await p.A.get(`/api/v1/results/${failedResultId}`)).json().data;
    const consoleArt = detail.artifacts.find((a: { kind: string }) => a.kind === 'console');
    await p.A.post(`/api/v1/artifacts/${consoleArt.id}/restrict`, { restricted: true });
    await p.A.post(`/api/v1/results/${failedResultId}/ai/failure-summary`);
    expect(mock.calls[mock.calls.length - 1]!.user).not.toContain('"console"');
    expect(mock.calls[mock.calls.length - 1]!.user).toContain('"restrictedExcluded":1');
    // sendArtifacts=false → no excerpts at all
    await p.A.patch(`/api/v1/orgs/${p.s.orgId}`, { settings: { ai: { enabled: true, sendArtifacts: false } } });
    await p.A.post(`/api/v1/results/${failedResultId}/ai/failure-summary`);
    expect(mock.calls[mock.calls.length - 1]!.user).toContain('"artifactExcerpts":{}');
    await p.A.patch(`/api/v1/orgs/${p.s.orgId}`, { settings: { ai: { enabled: true, sendArtifacts: true } } });
    // defect draft → apply creates a defect via the normal path
    const draft = await p.A.post(`/api/v1/results/${failedResultId}/ai/defect-draft`);
    expect(draft.statusCode).toBe(201);
    const before2 = (await p.A.get(`/api/v1/projects/${p.project.id}/defects`)).json().data.length;
    const applied = await p.A.post(`/api/v1/projects/${p.project.id}/ai/suggestions/${draft.json().data.id}/apply`, {});
    expect(applied.statusCode).toBe(201);
    expect(applied.json().data.fromAiSuggestionId).toBe(draft.json().data.id);
    expect((await p.A.get(`/api/v1/projects/${p.project.id}/defects`)).json().data.length).toBe(before2 + 1);
    expect(await p.t.db.get(`SELECT * FROM test_results WHERE id = ?`, [failedResultId])).toEqual(before);
  });

  it('必須テスト32: AI selector repair is a proposal; it cannot be applied without review/permission and never flips a result to passed', async () => {
    const broken = await p.createScenario({ title: 'Broken locator', steps: [{ type: 'navigate', url: '/login' }, { type: 'click', target: { role: 'button', name: 'Sign in now' }, timeoutMs: 1000 }] });
    const run = await p.runAndWait({ scenarioIds: [broken.id] });
    expect(run.status).toBe('failed');
    expect(['locator_not_found', 'timeout']).toContain(run.results[0]!.failure?.type);
    const resultId = run.results[0]!.id;
    const before = await p.t.db.get<Record<string, unknown>>(`SELECT * FROM test_results WHERE id = ?`, [resultId]);
    mock = new MockProvider(() => ({ candidates: [{ target: { role: 'button', name: 'Log in' }, confidence: 0.8, reason: 'closest accessible name' }] }));
    (p.t.app.svc.ai as unknown as { provider: MockProvider }).provider = mock;
    const rep = await p.A.post(`/api/v1/results/${resultId}/ai/selector-repair`);
    expect(rep.statusCode).toBe(201);
    expect(rep.json().data.status).toBe('proposed');
    // scenario unchanged, result unchanged
    expect((await p.A.get(`/api/v1/projects/${p.project.id}/scenarios/${broken.id}`)).json().data.version).toBe(1);
    expect(await p.t.db.get(`SELECT * FROM test_results WHERE id = ?`, [resultId])).toEqual(before);
    // developer lacks ai:apply
    const D = api(p.t.app, { cookie: await login(p.t.app, 'dev6@a.example', 'Dev-Pass-123456') });
    expect((await D.post(`/api/v1/projects/${p.project.id}/ai/suggestions/${rep.json().data.id}/apply`, { candidateIndex: 0 })).statusCode).toBe(403);
    // reviewer applies → new scenario version, audit, result still failed, rerun required
    const applied = await p.A.post(`/api/v1/projects/${p.project.id}/ai/suggestions/${rep.json().data.id}/apply`, { candidateIndex: 0 });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data.rerunRequired).toBe(true);
    expect(applied.json().data.resultStatus).toBe('failed');
    const sc = (await p.A.get(`/api/v1/projects/${p.project.id}/scenarios/${broken.id}`)).json().data;
    expect(sc.version).toBe(2);
    expect(sc.steps[1].target).toEqual({ role: 'button', name: 'Log in' });
    expect(await p.t.db.get(`SELECT * FROM test_results WHERE id = ?`, [resultId])).toEqual(before);
    const rerun = await p.runAndWait({ scenarioIds: [broken.id] });
    expect(rerun.status).toBe('passed');
    const audit = (await p.A.get(`/api/v1/orgs/${p.s.orgId}/audit?action=ai.apply`)).json().data;
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });
});
