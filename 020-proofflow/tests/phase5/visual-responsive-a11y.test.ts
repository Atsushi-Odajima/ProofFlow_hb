import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPipeline, type Pipeline } from '../helpers/pipeline.js';
import { api, login } from '../helpers/app.js';

let p: Pipeline;
beforeAll(async () => { p = await createPipeline(); }, 120_000);
afterAll(async () => { await p.close(); });

describe('Phase 5: visual regression, responsive, accessibility, links, crawl', () => {
  let visualScenarioId: string;
  it('必須テスト10/11: baseline → CSS change → diff; unauthorized baseline update is refused; approval is reasoned and historized', async () => {
    await p.setBugs({ visualButtonShift: false });
    const sc = await p.createScenario({ title: 'Landing visual', steps: [{ type: 'navigate', url: '/' }, { type: 'screenshot', label: 'landing', visualCheck: true }] });
    visualScenarioId = sc.id;
    const run1 = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run1.status).toBe('passed'); // no baseline yet → new_baseline_needed, not a failure
    let cmps = (await p.A.get(`/api/v1/projects/${p.project.id}/visual/comparisons`)).json().data;
    expect(cmps[0].status).toBe('new_baseline_needed');
    // viewer / developer cannot approve baselines
    await p.A.post(`/api/v1/orgs/${p.s.orgId}/members`, { email: 'dev@a.example', role: 'developer', temporaryPassword: 'Dev-Pass-123456' });
    const D = api(p.t.app, { cookie: await login(p.t.app, 'dev@a.example', 'Dev-Pass-123456') });
    expect((await D.post(`/api/v1/projects/${p.project.id}/visual/approve`, { comparisonIds: [cmps[0].id], reason: 'looks fine' })).statusCode).toBe(403);
    // a reason is mandatory
    expect((await p.A.post(`/api/v1/projects/${p.project.id}/visual/approve`, { comparisonIds: [cmps[0].id], reason: '' })).statusCode).toBe(400);
    const ap = await p.A.post(`/api/v1/projects/${p.project.id}/visual/approve`, { comparisonIds: [cmps[0].id], reason: 'initial baseline from release 1.1' });
    expect(ap.statusCode).toBe(200);
    const baselines = (await p.A.get(`/api/v1/projects/${p.project.id}/visual/baselines`)).json().data;
    expect(baselines.length).toBe(1);
    // same rendering → match
    const run2 = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run2.status).toBe('passed');
    cmps = (await p.A.get(`/api/v1/projects/${p.project.id}/visual/comparisons?runId=${run2.id}`)).json().data;
    expect(cmps[0].status).toBe('match');
    // CSS change (button shift) → diff with evidence
    await p.setBugs({ visualButtonShift: true });
    const run3 = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run3.status).toBe('failed');
    expect(run3.results[0]!.failure?.type).toBe('visual');
    const kinds = run3.results[0]!.artifacts.map((a) => a.kind);
    expect(kinds).toContain('diff'); expect(kinds).toContain('screenshot');
    cmps = (await p.A.get(`/api/v1/projects/${p.project.id}/visual/comparisons?runId=${run3.id}`)).json().data;
    expect(cmps[0].status).toBe('diff'); expect(cmps[0].diffPixels).toBeGreaterThan(0); expect(cmps[0].diffArtifactId).toBeTruthy(); expect(cmps[0].baselineArtifactId).toBeTruthy();
    // intended change → approve as new baseline with reason → history has from/to
    const ap2 = await p.A.post(`/api/v1/projects/${p.project.id}/visual/approve`, { comparisonIds: [cmps[0].id], reason: 'button spacing redesign (PR #42)' });
    expect(ap2.statusCode).toBe(200);
    const hist = (await p.A.get(`/api/v1/projects/${p.project.id}/baselines/history?kind=visual`)).json().data;
    expect(hist.length).toBe(2);
    expect(hist[0].action).toBe('update'); expect(hist[0].reason).toContain('PR #42'); expect(hist[0].from_ref).toBeTruthy(); expect(hist[0].to_ref).toBe(cmps[0].currentArtifactId);
    const run4 = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run4.status).toBe('passed');
    // bulk approvals require confirmation
    const ids = Array.from({ length: 11 }, () => cmps[0].id);
    expect((await p.A.post(`/api/v1/projects/${p.project.id}/visual/approve`, { comparisonIds: ids, reason: 'mass' })).statusCode).toBe(400);
  });

  it('必須テスト12: viewport overflow / off-screen CTA detected on mobile viewport with evidence (E2E-3 shape)', async () => {
    const sc = await p.createScenario({ title: 'Landing responsive', steps: [{ type: 'navigate', url: '/' }, { type: 'responsive_check' }, { type: 'assert_no_horizontal_scroll' }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id], matrix: { browsers: ['chromium'], viewports: [{ width: 1280, height: 800, name: 'desktop' }, { width: 390, height: 664, name: 'iphone13', isMobile: true, hasTouch: true }], retries: 0 } });
    expect(run.status).toBe('failed');
    const desktop = run.results.find((r) => r.viewport.width === 1280)!; const mobile = run.results.find((r) => r.viewport.width === 390)!;
    expect(desktop.status).toBe('passed');
    expect(mobile.status).toBe('failed');
    expect(mobile.failure?.type).toBe('responsive');
    expect(mobile.failure?.message).toMatch(/cta_offscreen|horizontal_overflow/);
    expect(mobile.artifacts.some((a) => a.kind === 'screenshot' && a.label?.startsWith('responsive'))).toBe(true);
    await p.setBugs({ mobileCtaOffscreen: false });
    const run2 = await p.runAndWait({ scenarioIds: [sc.id], matrix: { browsers: ['chromium'], viewports: [{ width: 390, height: 664, name: 'iphone13', isMobile: true, hasTouch: true }], retries: 0 } });
    expect(run2.status).toBe('passed');
    await p.setBugs({ mobileCtaOffscreen: true });
  });

  it('必須テスト13: accessibility known violations (missing label / alt / lang) are detected by axe', async () => {
    const sc = await p.createScenario({ title: 'Settings accessibility', steps: [{ type: 'login_profile' }, { type: 'navigate', url: '/settings' }, { type: 'accessibility_check', tags: ['wcag2a', 'wcag2aa'] }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('failed');
    expect(run.results[0]!.failure?.type).toBe('accessibility');
    const a11y = (run.results[0]!.checks as { accessibility: Array<{ violations: Array<{ id: string; impact: string }>; engine: string }> }).accessibility[0]!;
    const ids = a11y.violations.map((v) => v.id);
    expect(ids).toContain('label'); expect(ids).toContain('image-alt'); expect(ids).toContain('html-has-lang');
    expect(a11y.engine).toContain('axe-core');
    expect(run.results[0]!.artifacts.some((a) => a.kind === 'report' && a.label?.startsWith('axe'))).toBe(true);
    await p.setBugs({ a11yMissingLabel: false });
    const run2 = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run2.status).toBe('passed');
    await p.setBugs({ a11yMissingLabel: true });
  });

  it('必須テスト14: broken link detection within the allowed origin', async () => {
    const sc = await p.createScenario({ title: 'Landing links are not broken', steps: [{ type: 'navigate', url: '/' }, { type: 'link_check', sameOriginOnly: true, maxLinks: 50 }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('failed');
    expect(run.results[0]!.failure?.type).toBe('link');
    expect(run.results[0]!.failure?.message).toContain('/pricing-old');
    expect(run.results[0]!.failure?.status).toBe(404);
    await p.setBugs({ brokenLink: false });
    const run2 = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run2.status).toBe('passed');
    await p.setBugs({ brokenLink: true });
  });

  it('crawl inventory stays within the environment origin and records pages/forms', async () => {
    const sc = await p.createScenario({ title: 'Crawl inventory', steps: [{ type: 'crawl_inventory', maxPages: 20, maxDepth: 2 }] });
    const run = await p.runAndWait({ scenarioIds: [sc.id] });
    expect(run.status).toBe('passed');
    const inv = (await p.A.get(`/api/v1/projects/${p.project.id}/environments/${p.env.id}/inventory`)).json().data as Array<{ url: string; kind: string; status_code: number }>;
    expect(inv.length).toBeGreaterThanOrEqual(5);
    expect(inv.every((i) => i.url.startsWith(p.sampleUrl))).toBe(true);
    expect(inv.some((i) => i.kind === 'form_page' && i.url.endsWith('/login'))).toBe(true);
    expect(inv.some((i) => i.status_code === 404)).toBe(true); // /pricing-old recorded, not hidden
  });
});
