/**
 * Web UI verification on PC / iPhone / Android viewports (完成条件 29, Phase 11).
 * Boots the control plane (serving the built SPA) + Sample SaaS + a Chromium runner, seeds the demo project, runs the RC 1.2.0
 * demo flow, then drives the UI with Playwright: every page × viewport is checked for page errors, console errors and horizontal
 * overflow, and a screenshot is stored under docs/ui-verification/<viewport>/<page>.jpg with a machine-readable summary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPipeline, type Pipeline } from '../helpers/pipeline.js';
import { seedSample, type SeedResult } from '@proofflow/server/seed/sample';
import { runDemoFlow, type DemoState } from '../helpers/demo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'docs', 'ui-verification');
const VIEWPORTS = [
  { name: 'pc', width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  { name: 'iphone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' },
  { name: 'android', width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' },
];

let p: Pipeline; let seed: SeedResult; let demo: DemoState; let browser: Browser;
const summary: Array<{ viewport: string; page: string; path: string; url: string; ok: boolean; overflowPx: number; pageErrors: string[]; consoleErrors: string[]; ms: number }> = [];

beforeAll(async () => {
  if (!existsSync(join(ROOT, 'packages', 'web', 'dist', 'index.html'))) throw new Error('packages/web/dist is missing — run `pnpm build:web` first');
  p = await createPipeline({ projectName: 'Pipeline (empty)' });
  await p.A.del(`/api/v1/projects/${p.project.id}`); // only the seeded "Sample SaaS" project should be visible in the screenshots
  seed = await seedSample(p.t.app, { sampleUrl: p.sampleUrl, account: { cookie: p.s.cookie, orgId: p.s.orgId, userId: p.s.userId } });
  demo = await runDemoFlow(p, seed, (m) => console.log('[demo] ' + m));
  browser = await chromium.launch();
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
}, 600_000);
afterAll(async () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), chromium: browser?.version(), viewports: VIEWPORTS.map((v) => ({ name: v.name, width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor })), pages: summary }, null, 2));
  await browser?.close(); await p?.close();
});

async function settle(page: Page) {
  await page.waitForLoadState('load');
  try { await page.waitForFunction(() => !document.querySelector('.loading, [aria-busy="true"]'), null, { timeout: 8000 }); } catch { /* keep going; the screenshot will show it */ }
  await page.waitForTimeout(700);
}
async function capture(ctx: BrowserContext, page: Page, vp: typeof VIEWPORTS[number], name: string, url: string, errors: { page: string[]; console: string[] }) {
  const t = Date.now();
  errors.page.length = 0; errors.console.length = 0;
  await page.goto(`${p.controlUrl}${url}`);
  await settle(page);
  const overflowPx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const dir = join(OUT, vp.name); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.jpg`);
  await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 72 });
  const ok = errors.page.length === 0 && errors.console.filter((e) => !(name === 'login' && /401 \(Unauthorized\)/.test(e))).length === 0 && overflowPx <= 1;
  summary.push({ viewport: vp.name, page: name, path: `docs/ui-verification/${vp.name}/${name}.jpg`, url, ok, overflowPx, pageErrors: [...errors.page], consoleErrors: [...errors.console], ms: Date.now() - t });
  return { overflowPx, pageErrors: [...errors.page], consoleErrors: [...errors.console] };
}

describe('Web UI on PC / iPhone / Android', () => {
  it('serves the SPA with history fallback and keeps API 404s as JSON', async () => {
    const html = await fetch(`${p.controlUrl}/projects/${seed.projectId}/runs`); expect(html.status).toBe(200); expect(html.headers.get('content-type')).toContain('text/html');
    expect((await fetch(`${p.controlUrl}/manifest.webmanifest`)).status).toBe(200);
    const api = await fetch(`${p.controlUrl}/api/v1/nope`); expect(api.status).toBe(404); expect(api.headers.get('content-type')).toContain('application/json');
    expect(demo.gateBefore).toBe('BLOCKED'); expect(demo.gateAfter).toBe('READY');
  });

  for (const vp of VIEWPORTS) {
    it(`${vp.name} ${vp.width}x${vp.height}: every page renders without errors or horizontal overflow`, async () => {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor, userAgent: vp.userAgent, locale: 'ja-JP' });
      const page = await ctx.newPage();
      const errors = { page: [] as string[], console: [] as string[] };
      page.on('pageerror', (e) => errors.page.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.console.push(m.text()); });
      const P = `/projects/${seed.projectId}`;
      const problems: string[] = [];
      const check = async (name: string, url: string, expectText?: string) => {
        const r = await capture(ctx, page, vp, name, url, errors);
        if (expectText) { const body = await page.locator('body').innerText(); if (!body.includes(expectText)) problems.push(`${name}: text "${expectText}" not found`); }
        if (r.pageErrors.length) problems.push(`${name}: page errors ${r.pageErrors.join(' | ')}`);
        const consoleErrors = name === 'login' ? r.consoleErrors.filter((e) => !/401 \(Unauthorized\)/.test(e)) : r.consoleErrors; // the login page probes /auth/me (401 by design)
        if (consoleErrors.length) problems.push(`${name}: console errors ${consoleErrors.join(' | ')}`);
        if (r.overflowPx > 1) problems.push(`${name}: horizontal overflow ${r.overflowPx}px`);
      };
      // login (unauthenticated) → sign in through the form
      await check('login', '/login', 'ProofFlow');
      await page.fill('input[name="email"]', p.s.email); await page.fill('input[name="password"]', 'Password-123456');
      await page.getByRole('button', { name: 'ログイン', exact: true }).last().click();
      await page.waitForSelector('nav.side', { state: 'attached', timeout: 15000 }); // app shell = logged in (the sidebar is hidden on phones; the bottom nav shows instead)
      await check('projects', '/projects', 'Sample SaaS');
      await check('dashboard', `${P}/dashboard`);
      await check('requirements', `${P}/requirements`, 'ログイン失敗時');
      await check('scenarios', `${P}/scenarios`, 'トップページ');
      await check('suites', `${P}/suites`, 'Critical');
      await check('runs', `${P}/runs`, 'RC 1.2.0');
      await check('run-detail-failed', `${P}/runs/${demo.runs.critical1}`, 'Critical #1');
      await check('run-detail-passed', `${P}/runs/${demo.runs.critical2}`, 'after fix');
      await check('run-detail-mobile', `${P}/runs/${demo.runs.mobile1}`, 'Mobile #1');
      await check('visual', `${P}/visual`);
      await check('defects', `${P}/defects`, demo.defects[0]?.key);
      if (demo.defects[0]) await check('defect-detail', `${P}/defects/${demo.defects[0].id}`, demo.defects[0].key);
      await check('bug-reports', `${P}/bug-reports`, 'ProofFlow 不具合報告');
      await check('releases', `${P}/releases`, '1.2.0');
      await check('release-detail', `${P}/releases/${demo.rcId}`, 'READY');
      await check('manual', `${P}/manual`, 'iPhone');
      await check('schedules', `${P}/schedules`, 'Critical');
      await check('project-settings', `${P}/settings`, 'Local (Sample SaaS)');
      await check('org-settings', '/settings');
      await ctx.close();
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
});
