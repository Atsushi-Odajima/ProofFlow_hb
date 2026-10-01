import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPipeline, type Pipeline } from '../helpers/pipeline.js';
import { api, login, createToken } from '../helpers/app.js';

let p: Pipeline;
beforeAll(async () => { p = await createPipeline(); }, 120_000);
afterAll(async () => { await p.close(); });

describe('Phase 7: release candidate, gate, accepted risk, evidence report (RC 1.2.0 demo flow)', () => {
  let criticalSuite: { id: string }; let rcId: string; let loginScenario: { id: string }; let landingScenario: { id: string }; let defectId: string;

  it('必須テスト24: critical suite failure → gate BLOCKED', async () => {
    loginScenario = await p.createScenario({ title: 'Login invalid shows error', priority: 'p0', steps: [{ type: 'navigate', url: '/login' }, { type: 'fill', target: { label: 'Email' }, value: 'wrong@example.com' }, { type: 'fill', target: { label: 'Password' }, value: 'bad-password-1' }, { type: 'click', target: { role: 'button', name: 'Log in' } }, { type: 'assert_text', text: 'Invalid email or password' }] });
    landingScenario = await p.createScenario({ title: 'Landing loads', priority: 'p0', steps: [{ type: 'navigate', url: '/' }, { type: 'assert_title', title: 'Sample SaaS' }] });
    criticalSuite = await p.createSuite({ name: 'Critical', kind: 'critical', scenarioIds: [loginScenario.id, landingScenario.id], requiredForRelease: true });
    const rc = await p.A.post(`/api/v1/projects/${p.project.id}/releases`, { version: '1.2.0', commitSha: 'abc1234', buildId: 'build-77', environmentId: p.env.id, includedChanges: 'login redesign', requiredManualChecks: ['iPhone smoke'] });
    expect(rc.statusCode).toBe(201);
    rcId = rc.json().data.id;
    expect(rc.json().data.requiredSuiteIds).toEqual([criticalSuite.id]);
    expect(rc.json().data.gateRules.map((r: { type: string }) => r.type)).toEqual(['suite_pass_rate', 'open_defects_max', 'open_defects_max', 'visual_approved', 'manual_check_required', 'accessibility_max', 'no_infra_errors']);
    // no run yet → BLOCKED
    let ev = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/evaluate`);
    expect(ev.json().data.result).toBe('BLOCKED');
    expect(ev.json().data.rules[0].message).toContain('no completed run');
    // critical suite run with the seeded login bug → failure → BLOCKED
    const run = await p.runAndWait({ suiteId: criticalSuite.id, releaseCandidateId: rcId });
    expect(run.status).toBe('failed');
    ev = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/evaluate`);
    expect(ev.json().data.result).toBe('BLOCKED');
    const suiteRule = ev.json().data.rules.find((r: { rule: { type: string } }) => r.rule.type === 'suite_pass_rate');
    expect(suiteRule.pass).toBe(false); expect(suiteRule.evidence.failed).toBe(1); expect(suiteRule.evidence.runId).toBe(run.id);
    expect((await p.A.get(`/api/v1/projects/${p.project.id}/releases/${rcId}`)).json().data.status).toBe('blocked');
    // release attempt is refused while BLOCKED
    expect((await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/release`, {})).statusCode).toBe(409);
    // defect from the failure → fix → retest → verified
    const failed = run.results.find((r) => r.status === 'failed')!;
    defectId = (await p.A.post(`/api/v1/projects/${p.project.id}/defects/from-result`, { resultId: failed.id, severity: 'critical' })).json().data.id;
  });

  it('必須テスト25: accepted risk requires approver + reason + review date + impact (and is recorded)', async () => {
    const bad = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/accepted-risks`, { defectId, reason: 'x' });
    expect(bad.statusCode).toBe(400);
    const noDate = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/accepted-risks`, { defectId, reason: 'known issue, fix scheduled', reviewDate: 'soon', impact: 'low' });
    expect(noDate.statusCode).toBe(400);
    // service tokens cannot accept risks (no human approver)
    const svcTok = await createToken(p.t.app, p.s, { kind: 'service', role: 'qa_lead' });
    expect((await api(p.t.app, { token: svcTok }).post(`/api/v1/projects/${p.project.id}/releases/${rcId}/accepted-risks`, { defectId, reason: 'known issue, fix scheduled', reviewDate: '2026-11-01', impact: 'login error text missing; users retry' })).statusCode).toBe(403);
    // developer lacks release:accept_risk
    await p.A.post(`/api/v1/orgs/${p.s.orgId}/members`, { email: 'dev7@a.example', role: 'developer', temporaryPassword: 'Dev-Pass-123456' });
    const D = api(p.t.app, { cookie: await login(p.t.app, 'dev7@a.example', 'Dev-Pass-123456') });
    expect((await D.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/accepted-risks`, { defectId, reason: 'known issue', reviewDate: '2026-11-01', impact: 'low' })).statusCode).toBe(403);
    const okRisk = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/accepted-risks`, { defectId, reason: 'known issue, fix scheduled for 1.2.1', reviewDate: '2026-11-01', impact: 'login error text missing; users can retry' });
    expect(okRisk.statusCode).toBe(201);
    expect(okRisk.json().data.approver_user_id).toBe(p.s.userId);
    // critical defects cannot be covered by accepted risk (rule allowAcceptedRisk=false) → still BLOCKED
    const ev = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/evaluate`);
    expect(ev.json().data.result).toBe('BLOCKED');
    expect(ev.json().data.rules.find((r: { rule: { severity?: string } }) => r.rule.severity === 'critical').pass).toBe(false);
  });

  it('必須テスト26: after the fix the suite passes but manual iPhone check missing → BLOCKED; after the manual check → READY', async () => {
    await p.setBugs({ loginInvalidErrorMissing: false });
    await p.A.patch(`/api/v1/projects/${p.project.id}/defects/${defectId}`, { status: 'ready_for_retest' });
    const rt = await p.A.post(`/api/v1/projects/${p.project.id}/defects/${defectId}/retest`, {});
    await p.runner.drain();
    expect((await p.A.get(`/api/v1/projects/${p.project.id}/defects/${defectId}`)).json().data.status).toBe('verified');
    expect((await p.getRun(rt.json().data.id)).status).toBe('passed');
    const run = await p.runAndWait({ suiteId: criticalSuite.id, releaseCandidateId: rcId });
    expect(run.status).toBe('passed');
    let ev = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/evaluate`);
    expect(ev.json().data.result).toBe('BLOCKED');
    const failing = ev.json().data.rules.filter((r: { pass: boolean }) => !r.pass);
    expect(failing.length).toBe(1);
    expect(failing[0].rule.type).toBe('manual_check_required');
    expect(failing[0].message).toContain('not performed');
    // record a manual iPhone check with evidence
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    const up = await p.t.app.inject({ method: 'PUT', url: `/api/v1/projects/${p.project.id}/manual-evidence?label=iphone-login`, headers: { cookie: p.s.cookie, 'content-type': 'image/png' }, payload: png });
    expect(up.statusCode).toBe(201);
    const mc = await p.A.post(`/api/v1/projects/${p.project.id}/manual-checks`, { releaseCandidateId: rcId, label: 'iPhone smoke', device: 'iPhone 15 (iOS 19.1)', browser: 'Safari', result: 'pass', notes: 'login + dashboard OK on device', artifactIds: [up.json().data.id] });
    expect(mc.statusCode).toBe(201);
    ev = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/evaluate`);
    expect(ev.json().data.result).toBe('READY');
    expect((await p.A.get(`/api/v1/projects/${p.project.id}/releases/${rcId}`)).json().data.status).toBe('ready');
  });

  it('必須テスト27: evidence report matches run results; release approval is human-only', async () => {
    // service token cannot approve a release even with owner role
    const svcTok = await createToken(p.t.app, p.s, { kind: 'service', role: 'owner' });
    expect((await api(p.t.app, { token: svcTok }).post(`/api/v1/projects/${p.project.id}/releases/${rcId}/release`, {})).statusCode).toBe(403);
    const rel = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/release`, { note: 'go' });
    expect(rel.statusCode).toBe(200);
    expect(rel.json().data.status).toBe('released');
    expect(rel.json().data.releasedBy).toBe(p.s.userId);
    const rep = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/report`, { format: 'html' });
    expect(rep.statusCode).toBe(201);
    const summary = rep.json().data.summary;
    const rcDetail = (await p.A.get(`/api/v1/projects/${p.project.id}/releases/${rcId}`)).json().data;
    const runs = rcDetail.runs as Array<{ id: string; status: string; counts_json: string }>;
    expect(summary.runs.length).toBe(runs.length);
    for (const r of summary.runs) { const real = runs.find((x) => x.id === r.id)!; expect(r.status).toBe(real.status); expect(r.counts).toEqual(JSON.parse(real.counts_json)); }
    expect(summary.gate).toBe('READY');
    expect(summary.manualChecks).toBe(1); expect(summary.acceptedRisks).toBe(1);
    const html = (await p.A.get(`/api/v1/artifacts/${rep.json().data.artifactId}/download`)).body;
    for (const r of runs) expect(html).toContain(r.id);
    expect(html).toContain('1.2.0'); expect(html).toContain('iPhone 15'); expect(html).toContain('READY'); expect(html).toContain('品質保証証明書・認証・保証書ではありません');
    expect(html).not.toMatch(/証明書<\/h/);
    const pdf = await p.A.post(`/api/v1/projects/${p.project.id}/releases/${rcId}/report`, { format: 'pdf' });
    expect([201, 400]).toContain(pdf.statusCode);
    if (pdf.statusCode === 201) { const bin = await p.A.get(`/api/v1/artifacts/${pdf.json().data.artifactId}/download`); expect(bin.rawPayload.subarray(0, 4).toString()).toBe('%PDF'); }
    const dash = await p.A.get(`/api/v1/projects/${p.project.id}/dashboard`);
    expect(dash.statusCode).toBe(200);
    expect(dash.json().data.quality.criticalRequirementCoverage).toBeDefined();
    expect(dash.json().data.note).toContain('single AI quality score');
    // released candidates are immutable
    expect((await p.A.patch(`/api/v1/projects/${p.project.id}/releases/${rcId}`, { includedChanges: 'x' })).statusCode).toBe(409);
  });
});
