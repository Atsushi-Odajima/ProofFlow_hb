/**
 * The RC 1.2.0 demo flow on the seeded Sample SaaS project (docs/buyer/Release Gate.txt):
 *   1.1.0 visual baseline → 1.2.0 runs with seeded bugs → failures → defects → gate BLOCKED → fix → retest → verified → re-run → manual iPhone check → READY.
 * Shared by the E2E tests and the UI verification so screenshots show a realistic project history.
 */
import type { Pipeline } from './pipeline.js';
import type { SeedResult } from '@proofflow/server/seed/sample';

export interface DemoState { runs: Record<string, string>; defects: Array<{ id: string; key: string; status: string; severity: string; title: string }>; gateBefore: string; gateAfter: string; rcId: string; }

export async function runDemoFlow(p: Pipeline, seed: SeedResult, log: (m: string) => void = () => undefined): Promise<DemoState> {
  const P = `/api/v1/projects/${seed.projectId}`;
  const A = p.A;
  const runSuite = async (suite: string, label: string, extra: Record<string, unknown> = {}) => {
    const r = await A.post(`${P}/runs`, { environmentId: seed.envId, suiteId: seed.suites[suite], label, trigger: 'manual', ...extra });
    if (r.statusCode !== 202 && r.statusCode !== 200) throw new Error(`run ${suite} failed: ${r.body}`);
    const id = r.json().data.id as string;
    await p.runner.drain();
    const d = await p.getRun(id);
    log(`${label}: ${d.status} ${JSON.stringify(d.counts)}`);
    for (const r of d.results) if (r.status !== 'passed') log(`  ${r.status} ${r.scenario?.key ?? r.scenarioId} [${r.browser} ${r.viewport.width}x${r.viewport.height}] attempts=${r.attempts} ${r.failure?.type ?? ''}: ${(r.failure?.message ?? '').slice(0, 160)}${r.attemptsDetail?.length ? ' | attempts: ' + r.attemptsDetail.map((a) => `${a.attempt}=${a.status}${a.failure ? ' ' + String((a.failure as { message?: string }).message ?? '').slice(0, 80) : ''}`).join('; ') : ''}`);
    return d;
  };
  const runs: Record<string, string> = {};
  // 1.1.0: approved visual baselines (design as released, button shift bug OFF)
  await p.setBugs({ visualButtonShift: false });
  const base = await runSuite('Visual', '1.1.0 visual baseline'); runs.visualBaseline = base.id;
  const cmps = (await A.get(`${P}/visual/comparisons?runId=${base.id}`)).json().data as Array<{ id: string; status: string }>;
  const ap = await A.post(`${P}/visual/approve`, { comparisonIds: cmps.map((c) => c.id), reason: 'リリース 1.1.0 の確定デザインを baseline として登録' });
  if (ap.statusCode !== 200) throw new Error('baseline approve failed ' + ap.body);
  await p.setBugs({ visualButtonShift: true });
  // RC 1.2.0 with every seeded bug
  const critical1 = await runSuite('Critical', 'RC 1.2.0 Critical #1', { releaseCandidateId: seed.rcId, commitSha: 'a1b2c3d', branch: 'release/1.2.0' }); runs.critical1 = critical1.id;
  const visual1 = await runSuite('Visual', 'RC 1.2.0 Visual #1', { releaseCandidateId: seed.rcId }); runs.visual1 = visual1.id;
  const mobile1 = await runSuite('Mobile', 'RC 1.2.0 Mobile #1', { releaseCandidateId: seed.rcId }); runs.mobile1 = mobile1.id;
  const api1 = await runSuite('API', 'RC 1.2.0 API #1', { releaseCandidateId: seed.rcId }); runs.api1 = api1.id;
  const a11y1 = await runSuite('Accessibility', 'RC 1.2.0 Accessibility #1', { releaseCandidateId: seed.rcId }); runs.a11y1 = a11y1.id;
  const smoke1 = await runSuite('Smoke', 'RC 1.2.0 Smoke #1', { releaseCandidateId: seed.rcId }); runs.smoke1 = smoke1.id;
  // defects: one per failure fingerprint, severity by suite
  const severity: Record<string, string> = { critical1: 'critical', api1: 'critical', mobile1: 'high', visual1: 'high', a11y1: 'medium' };
  const seen = new Set<string>(); const defects: DemoState['defects'] = [];
  for (const [k, run] of Object.entries({ critical1, api1, mobile1, visual1, a11y1 })) {
    for (const r of run.results) {
      if (r.status !== 'failed' || !r.fingerprint || seen.has(r.fingerprint)) continue;
      seen.add(r.fingerprint);
      const d = await A.post(`${P}/defects/from-result`, { resultId: r.id, severity: severity[k] });
      if (d.statusCode !== 201) throw new Error('defect failed ' + d.body);
      defects.push(d.json().data);
    }
  }
  log(`defects created: ${defects.length}`);
  // human visual review: the 1.2.0 diffs are the button-shift bug, not an intended change → reject with a reason
  const diffs = ((await A.get(`${P}/visual/comparisons?runId=${visual1.id}`)).json().data as Array<{ id: string; status: string }>).filter((c) => c.status === 'diff');
  for (const c of diffs) { const rj = await A.post(`${P}/visual/comparisons/${c.id}/reject`, { note: 'ボタン位置のずれは意図しない変更（DEF 登録済み）。baseline は 1.1.0 のまま維持' }); if (rj.statusCode !== 200) throw new Error('visual reject failed ' + rj.body); }
  log(`visual diffs rejected: ${diffs.length}`);
  const gateBefore = (await A.post(`${P}/releases/${seed.rcId}/evaluate`)).json().data.result as string;
  // "fix + redeploy": every seeded bug off (the flaky page stays flaky on purpose)
  await p.setBugs({ mobileCtaOffscreen: false, loginInvalidErrorMissing: false, signupDoubleSubmit: false, profileApi500: false, visualButtonShift: false, brokenLink: false, consoleException: false, downloadFilenameError: false, uploadInvalidTypeAccepted: false, a11yMissingLabel: false, apiSchemaBreak: false, slowApi: false });
  await fetch(`${p.sampleUrl}/__sample/reset`);
  for (const d of defects) {
    await A.patch(`${P}/defects/${d.id}`, { status: 'ready_for_retest', note: '修正をデプロイ済み (fix: sample bug toggles OFF)' });
    const rt = await A.post(`${P}/defects/${d.id}/retest`, {});
    if (rt.statusCode !== 202 && rt.statusCode !== 201 && rt.statusCode !== 200) throw new Error('retest failed ' + rt.body);
    await p.runner.drain();
    const after = (await A.get(`${P}/defects/${d.id}`)).json().data as { status: string };
    d.status = after.status;
  }
  log(`defects after retest: ${defects.map((d) => `${d.key}=${d.status}`).join(', ')}`);
  const critical2 = await runSuite('Critical', 'RC 1.2.0 Critical #2 (after fix)', { releaseCandidateId: seed.rcId, commitSha: 'e5f6a7b', branch: 'release/1.2.0' }); runs.critical2 = critical2.id;
  runs.visual2 = (await runSuite('Visual', 'RC 1.2.0 Visual #2 (after fix)', { releaseCandidateId: seed.rcId })).id;
  runs.mobile2 = (await runSuite('Mobile', 'RC 1.2.0 Mobile #2 (after fix)', { releaseCandidateId: seed.rcId })).id;
  runs.api2 = (await runSuite('API', 'RC 1.2.0 API #2 (after fix)', { releaseCandidateId: seed.rcId })).id;
  runs.a11y2 = (await runSuite('Accessibility', 'RC 1.2.0 Accessibility #2 (after fix)', { releaseCandidateId: seed.rcId })).id;
  // manual iPhone check with evidence
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const up = await p.t.app.inject({ method: 'PUT', url: `${P}/manual-evidence?label=iphone-dashboard`, headers: { cookie: p.s.cookie, 'content-type': 'image/png' }, payload: png });
  const mc = await A.post(`${P}/manual-checks`, { manualCaseId: seed.manualCaseId, releaseCandidateId: seed.rcId, label: 'iPhone smoke', device: 'iPhone 15 (iOS 18.6)', browser: 'Safari', result: 'pass', notes: 'ログイン → ダッシュボード → report.csv ダウンロードまで実機で確認', artifactIds: up.statusCode === 201 ? [up.json().data.id] : [] });
  if (mc.statusCode !== 201) throw new Error('manual check failed ' + mc.body);
  const gateAfter = (await A.post(`${P}/releases/${seed.rcId}/evaluate`)).json().data.result as string;
  await A.post(`${P}/releases/${seed.rcId}/report`, { format: 'html' });
  log(`gate: ${gateBefore} → ${gateAfter}`);
  return { runs, defects, gateBefore, gateAfter, rcId: seed.rcId };
}
