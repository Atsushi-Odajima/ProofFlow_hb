import type { Page, BrowserContext, Locator } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkTargetUrl, type Step, type StepTarget } from '@proofflow/shared';
import { resolveLocator, describeTarget } from './locator.js';
import { StepFailure, type JobPayload, type FailureInfo } from './types.js';
import type { EvidenceCollector, Redactor } from './evidence.js';
import { responsiveCheck } from './checks/responsive.js';
import { accessibilityCheck } from './checks/a11y.js';
import { linkCheck } from './checks/links.js';
import { compareScreenshots } from './checks/visual.js';
import { perfMetrics } from './checks/perf.js';
import { validateJsonSchema, jsonPath } from './checks/schema.js';

export interface StepContext {
  job: JobPayload; page: Page; context: BrowserContext; evidence: EvidenceCollector; red: Redactor; workDir: string; attempt: number;
  vars: Record<string, unknown>;
  checks: Record<string, unknown[]>;
  pendingArtifacts: { kind: string; label?: string; stepIndex: number; contentType: string; path?: string; buffer?: Buffer }[];
  fixtureFiles: Map<string, string>;
  baselineCache: Map<string, Buffer>;
  download: (url: string) => Promise<Buffer>;
}

const fail = (info: FailureInfo): never => { throw new StepFailure(info); };

export function interpolate(value: string, job: JobPayload, vars: Record<string, unknown>): string {
  return value.replace(/\{\{\s*(secret|data|var):([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, kind: string, key: string) => {
    if (kind === 'secret') { const v = job.secrets[key]; if (v === undefined) fail({ type: 'policy', message: `secret "${key}" is not defined for this environment` }); return v as string; }
    const src = kind === 'data' ? job.data : vars;
    const got = jsonPath(src, key);
    if (!got.exists) fail({ type: 'unknown', message: `${kind} "${key}" is not defined` });
    return typeof got.value === 'string' ? got.value : JSON.stringify(got.value);
  });
}
function resolveUrl(raw: string, job: JobPayload, api = false): string {
  const base = api ? (job.environment.apiBaseUrl || job.environment.baseUrl) : job.environment.baseUrl;
  const u = new URL(raw, base.endsWith('/') ? base : base + '/');
  const pol = checkTargetUrl(u.toString(), { allowPrivateNetwork: job.environment.allowPrivateNetwork, allowedHosts: job.environment.allowedHosts });
  if (!pol.allowed) fail({ type: 'policy', message: `URL rejected by target policy (${pol.reason}): ${u.hostname}`, url: u.toString() });
  return u.toString();
}
function loc(ctx: StepContext, t: StepTarget): Locator { return resolveLocator(ctx.page, t); }
function stepKeyOf(step: Step, index: number): string { return (step as { label?: string }).label ?? `step-${index}`; }

export async function executeStep(ctx: StepContext, step: Step, index: number): Promise<void> {
  const { page, job } = ctx;
  const timeout = step.timeoutMs ?? job.options.stepTimeoutMs;
  const txt = (s: string) => interpolate(s, job, ctx.vars);
  const push = (bucket: string, v: unknown) => { (ctx.checks[bucket] ??= []).push(v); };
  try {
    switch (step.type) {
      case 'navigate': { await page.goto(resolveUrl(txt(step.url), job), { waitUntil: step.waitUntil ?? 'load', timeout: Math.max(timeout, 30_000) }); return; }
      case 'click': { await loc(ctx, step.target).click({ button: step.button, force: step.force, timeout }); return; }
      case 'fill': { await loc(ctx, step.target).fill(txt(step.value), { timeout }); return; }
      case 'select': { await loc(ctx, step.target).selectOption(txt(step.value), { timeout }); return; }
      case 'check': { const l = loc(ctx, step.target); if (step.checked) await l.check({ timeout }); else await l.uncheck({ timeout }); return; }
      case 'press': { if (step.target) await loc(ctx, step.target).press(step.key, { timeout }); else await page.keyboard.press(step.key); return; }
      case 'hover': { await loc(ctx, step.target).hover({ timeout }); return; }
      case 'set_viewport': { await page.setViewportSize({ width: step.width, height: step.height }); return; }
      case 'wait': {
        if (step.target) await loc(ctx, step.target).waitFor({ state: step.state ?? 'visible', timeout });
        if (step.url) await page.waitForURL((u) => matchUrl(u.toString(), txt(step.url!), 'contains'), { timeout });
        if (step.ms) await page.waitForTimeout(step.ms);
        return;
      }
      case 'assert_text': {
        const expected = txt(step.text);
        const actual = step.target ? (await loc(ctx, step.target).first().innerText({ timeout }).catch(async () => (await loc(ctx, step.target!).first().textContent({ timeout })) ?? '')) : await page.locator('body').innerText({ timeout });
        const ok = step.match === 'exact' ? actual.trim() === expected : step.match === 'regex' ? new RegExp(expected).test(actual) : actual.includes(expected);
        if (ok === !!step.negate) fail({ type: 'assertion', message: `text ${step.negate ? 'should not' : 'should'} ${step.match} "${expected}"`, expected, actual: ctx.red.textPii(actual.slice(0, 500)), locator: describeTarget(step.target), url: page.url() });
        return;
      }
      case 'assert_url': { const u = page.url(); const expected = txt(step.url); if (!matchUrl(u, expected, step.match)) fail({ type: 'assertion', message: `URL should ${step.match} "${expected}"`, expected, actual: ctx.red.url(u), url: u }); return; }
      case 'assert_title': { const t = await page.title(); const ok = step.match === 'exact' ? t === step.title : t.includes(step.title); if (!ok) fail({ type: 'assertion', message: `title should ${step.match} "${step.title}"`, expected: step.title, actual: t, url: page.url() }); return; }
      case 'assert_value': { const v = await loc(ctx, step.target).inputValue({ timeout }); const expected = txt(step.value); if (v !== expected) fail({ type: 'assertion', message: `value mismatch`, expected, actual: ctx.red.textPii(v), locator: describeTarget(step.target), url: page.url() }); return; }
      case 'assert_element': {
        const l = loc(ctx, step.target);
        if (step.count !== undefined) { const c = await l.count(); if (c !== step.count) fail({ type: 'assertion', message: `expected ${step.count} elements, found ${c}`, expected: String(step.count), actual: String(c), locator: describeTarget(step.target), url: page.url() }); return; }
        const st = step.state;
        if (st === 'visible' || st === 'hidden' || st === 'attached') { try { await l.first().waitFor({ state: st, timeout }); } catch { fail({ type: st === 'hidden' ? 'assertion' : 'locator_not_found', message: `element should be ${st}`, locator: describeTarget(step.target), url: page.url() }); } return; }
        const first = l.first();
        const actual = st === 'enabled' || st === 'disabled' ? await first.isEnabled({ timeout }) : await first.isChecked({ timeout });
        const want = st === 'enabled' || st === 'checked';
        if (actual !== want) fail({ type: 'assertion', message: `element should be ${st}`, locator: describeTarget(step.target), url: page.url() });
        return;
      }
      case 'assert_no_horizontal_scroll': { const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); push('responsive', { stepIndex: index, kind: 'horizontal_scroll', scrollWidth: r.sw, clientWidth: r.cw, ok: r.sw <= r.cw + 1 }); if (r.sw > r.cw + 1) fail({ type: 'responsive', message: `horizontal scroll detected: scrollWidth ${r.sw} > clientWidth ${r.cw}`, url: page.url(), ruleId: 'horizontal_overflow' }); return; }
      case 'assert_console': {
        const extra = (step.ignorePatterns ?? []).map((p) => new RegExp(p, 'i'));
        const errors = ctx.evidence.console.filter((c) => (c.type === 'error' || c.type === 'pageerror') && !c.ignored && !extra.some((r) => r.test(c.text)));
        push('console', { stepIndex: index, errors: errors.length, maxErrors: step.maxErrors, samples: errors.slice(0, 5).map((e) => e.text.slice(0, 200)) });
        if (errors.length > step.maxErrors) fail({ type: 'console', message: `${errors.length} console error(s) (max ${step.maxErrors}): ${errors.slice(0, 3).map((e) => e.text.slice(0, 120)).join(' | ')}`, url: page.url() });
        return;
      }
      case 'assert_network': {
        const re = step.urlPattern ? new RegExp(step.urlPattern, 'i') : null;
        const bad = ctx.evidence.network.filter((n) => !n.ignored && (!re || re.test(n.url)) && ((n.status ?? 0) >= step.noStatusAtLeast || !!n.failed || (step.maxDurationMs !== undefined && (n.durationMs ?? 0) > step.maxDurationMs)));
        push('network', { stepIndex: index, violations: bad.length, samples: bad.slice(0, 5) });
        if (bad.length) { const b = bad[0]!; fail({ type: 'network', message: `${bad.length} network violation(s): ${b.method} ${b.url} → ${b.status ?? b.failed ?? ''}${b.durationMs ? ` (${b.durationMs}ms)` : ''}`, url: b.url, status: b.status }); }
        return;
      }
      case 'screenshot': {
        const stepKey = step.label ?? `step-${index}`;
        const mask = [...(job.environment.privacy.maskSelectors ?? []), ...(step.maskSelectors ?? [])].map((s) => page.locator(s));
        const buf = await page.screenshot({ fullPage: step.fullPage ?? false, mask, animations: 'disabled', caret: 'hide', timeout: Math.max(timeout, 30_000) });
        ctx.pendingArtifacts.push({ kind: 'screenshot', label: stepKey, stepIndex: index, contentType: 'image/png', buffer: buf });
        if (step.visualCheck) {
          const bl = job.baselines.find((b) => b.stepKey === stepKey);
          if (!bl) { push('visual', { stepIndex: index, stepKey, status: 'new_baseline_needed', currentLabel: stepKey }); return; }
          let base = ctx.baselineCache.get(bl.artifactId);
          if (!base) { base = await ctx.download(bl.url); ctx.baselineCache.set(bl.artifactId, base); }
          const cmp = compareScreenshots(base, buf, { maxDiffRatio: step.maxDiffRatio ?? 0.001 });
          const rec = { stepIndex: index, stepKey, status: cmp.status, diffPixels: cmp.diffPixels, diffRatio: Number(cmp.diffRatio.toFixed(5)), baselineArtifactId: bl.artifactId, currentLabel: stepKey, diffLabel: cmp.diffPng ? `${stepKey}-diff` : undefined, threshold: step.maxDiffRatio ?? 0.001 };
          push('visual', rec);
          if (cmp.diffPng) ctx.pendingArtifacts.push({ kind: 'diff', label: `${stepKey}-diff`, stepIndex: index, contentType: 'image/png', buffer: cmp.diffPng });
          if (cmp.status !== 'match') fail({ type: 'visual', message: `visual difference at "${stepKey}": ${cmp.status} (${cmp.diffPixels} px, ${(cmp.diffRatio * 100).toFixed(2)}%)`, url: page.url(), ruleId: stepKey });
        }
        return;
      }
      case 'responsive_check': {
        const r = await responsiveCheck(page);
        const buf = await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 30_000 });
        ctx.pendingArtifacts.push({ kind: 'screenshot', label: `responsive-step-${index}`, stepIndex: index, contentType: 'image/png', buffer: buf });
        push('responsive', { stepIndex: index, ...r });
        const errors = r.findings.filter((f) => f.severity === 'error');
        if (errors.length) fail({ type: 'responsive', message: `${errors.length} responsive issue(s) at ${r.viewport.width}x${r.viewport.height}: ${errors.slice(0, 3).map((f) => `${f.kind}${f.text ? ` "${f.text}"` : ''}${f.detail ? ` (${f.detail})` : ''}`).join('; ')}`, url: page.url(), ruleId: errors[0]!.kind });
        return;
      }
      case 'accessibility_check': {
        const r = await accessibilityCheck(page, { tags: step.tags, disableRules: step.disableRules });
        ctx.pendingArtifacts.push({ kind: 'report', label: `axe-step-${index}`, stepIndex: index, contentType: 'application/json', buffer: Buffer.from(JSON.stringify(r, null, 2)) });
        push('accessibility', { stepIndex: index, engine: r.engine, counts: r.counts, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })) });
        const failOn = new Set(step.failOn ?? ['critical', 'serious']);
        const blocking = r.violations.filter((v) => failOn.has(v.impact as 'critical'));
        if (blocking.length) fail({ type: 'accessibility', message: `${blocking.length} accessibility violation(s): ${blocking.slice(0, 3).map((v) => `${v.id} (${v.impact})`).join(', ')}`, url: page.url(), ruleId: blocking[0]!.id });
        return;
      }
      case 'link_check': {
        const r = await linkCheck(page, ctx.context, { sameOriginOnly: step.sameOriginOnly, maxLinks: step.maxLinks, allowPrivate: job.environment.allowPrivateNetwork, allowedHosts: job.environment.allowedHosts });
        ctx.pendingArtifacts.push({ kind: 'report', label: `links-step-${index}`, stepIndex: index, contentType: 'application/json', buffer: Buffer.from(JSON.stringify(r, null, 2)) });
        push('links', { stepIndex: index, checked: r.checked, broken: r.broken });
        if (r.broken.length) fail({ type: 'link', message: `${r.broken.length} broken link(s): ${r.broken.slice(0, 3).map((b) => `${b.url} → ${b.status ?? b.error}`).join('; ')}`, url: r.broken[0]!.url, status: r.broken[0]!.status });
        return;
      }
      case 'perf_check': {
        const m = await perfMetrics(page);
        push('performance', { stepIndex: index, ...m, url: page.url() });
        const over: string[] = [];
        if (step.maxTtfbMs && (m.ttfbMs ?? 0) > step.maxTtfbMs) over.push(`TTFB ${m.ttfbMs}ms > ${step.maxTtfbMs}ms`);
        if (step.maxLoadMs && (m.loadMs ?? 0) > step.maxLoadMs) over.push(`load ${m.loadMs}ms > ${step.maxLoadMs}ms`);
        if (step.maxLcpMs && (m.lcpMs ?? 0) > step.maxLcpMs) over.push(`LCP ${m.lcpMs}ms > ${step.maxLcpMs}ms`);
        if (over.length) fail({ type: 'performance', message: `performance budget exceeded: ${over.join(', ')}`, url: page.url() });
        return;
      }
      case 'form_check': {
        const form = loc(ctx, step.target);
        const submit = step.submitTarget ? loc(ctx, step.submitTarget) : form.locator('button[type=submit],input[type=submit],button:not([type])').first();
        const rec: Record<string, unknown> = { stepIndex: index };
        if (step.expectErrorOnEmpty) {
          await submit.click({ timeout });
          await page.waitForTimeout(300);
          const invalid = await form.evaluate((f) => { const el = f as HTMLFormElement; const req = Array.from(el.querySelectorAll('[required]')) as HTMLInputElement[]; return { requiredCount: req.length, invalid: req.filter((i) => !i.checkValidity()).length, errorText: !!el.querySelector('.error, [role=alert], .invalid-feedback, [aria-invalid=true]')?.textContent?.trim() }; });
          rec.emptySubmit = invalid;
          if (invalid.invalid === 0 && !invalid.errorText) fail({ type: 'form', message: 'form accepted an empty submission without validation errors', locator: describeTarget(step.target), url: page.url(), ruleId: 'required_validation' });
        }
        if (step.expectDoubleSubmitGuard) {
          const before = ctx.evidence.network.filter((n) => n.method === 'POST').length;
          await submit.dblclick({ timeout }); // two click events in quick succession, like an impatient user
          await page.waitForTimeout(800);
          const posts = ctx.evidence.network.filter((n) => n.method === 'POST').length - before;
          const disabledAfter = await submit.isDisabled().catch(() => false);
          rec.doubleSubmit = { postRequests: posts, disabledAfterClick: disabledAfter };
          if (posts > 1) fail({ type: 'form', message: `double submit not guarded: ${posts} POST requests after two rapid clicks`, locator: describeTarget(step.target), url: page.url(), ruleId: 'double_submit' });
        }
        push('form', rec);
        return;
      }
      case 'upload': {
        const fx = job.fixtures.find((f) => f.name === step.fixture);
        if (!fx) fail({ type: 'upload', message: `fixture "${step.fixture}" not found in project` });
        let path = ctx.fixtureFiles.get(step.fixture);
        if (!path) { const buf = await ctx.download(fx!.url); mkdirSync(join(ctx.workDir, 'fixtures'), { recursive: true }); path = join(ctx.workDir, 'fixtures', step.fixture.replace(/[^A-Za-z0-9._-]/g, '_')); writeFileSync(path, buf); ctx.fixtureFiles.set(step.fixture, path); }
        await loc(ctx, step.target).setInputFiles({ name: step.fixture, mimeType: fx!.contentType, buffer: (await import('node:fs')).readFileSync(path) }, { timeout });
        return;
      }
      case 'download': {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: Math.max(timeout, 30_000) }), loc(ctx, step.target).click({ timeout })]);
        const filename = dl.suggestedFilename();
        const resp = [...ctx.evidence.network].reverse().find((n) => n.url.split('?')[0] === ctx.red.url(dl.url()).split('?')[0]);
        let mime = resp?.mime ?? '';
        if (!mime) { try { const head = await ctx.context.request.fetch(dl.url(), { method: 'HEAD', timeout: 15_000, failOnStatusCode: false, maxRedirects: 0 }); mime = (head.headers()['content-type'] ?? '').split(';')[0]!.trim(); if (!mime) { const get = await ctx.context.request.fetch(dl.url(), { method: 'GET', timeout: 15_000, failOnStatusCode: false, maxRedirects: 0 }); mime = (get.headers()['content-type'] ?? '').split(';')[0]!.trim(); } } catch { /* keep empty */ } }
        const path = await dl.path().catch(() => null);
        const rec: Record<string, unknown> = { stepIndex: index, filename, mime, url: ctx.red.url(dl.url()), sizeBytes: path ? (await import('node:fs')).statSync(path).size : undefined };
        push('downloads', rec);
        if (path) { const buf = (await import('node:fs')).readFileSync(path); if (buf.length <= 5 * 1024 * 1024) ctx.pendingArtifacts.push({ kind: 'download', label: filename, stepIndex: index, contentType: mime || 'application/octet-stream', buffer: buf }); }
        if (step.expectFilename && filename !== step.expectFilename) fail({ type: 'download', message: `download filename mismatch`, expected: step.expectFilename, actual: filename, url: page.url() });
        if (step.expectMime && !mime.startsWith(step.expectMime)) fail({ type: 'download', message: `download MIME mismatch`, expected: step.expectMime, actual: mime || '(none)', url: page.url() });
        return;
      }
      case 'api_request': {
        const url = resolveUrl(txt(step.url), job, true);
        const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(step.headers ?? {})) headers[k] = txt(v);
        const bodyRaw = step.body === undefined ? undefined : typeof step.body === 'string' ? txt(step.body) : JSON.parse(txt(JSON.stringify(step.body)));
        const t0 = Date.now();
        const res = await ctx.context.request.fetch(url, { method: step.method, headers, data: bodyRaw, timeout: Math.max(timeout, 30_000), failOnStatusCode: false });
        const latency = Date.now() - t0;
        const status = res.status(); const ct = res.headers()['content-type'] ?? '';
        let json: unknown = undefined; let text = '';
        try { text = await res.text(); if (ct.includes('json')) json = JSON.parse(text); } catch { /* keep text */ }
        const rec: Record<string, unknown> = { stepIndex: index, method: step.method, url: ctx.red.url(url), status, latencyMs: latency, contentType: ct.split(';')[0] };
        if (step.saveAs && json !== undefined) ctx.vars[step.saveAs] = json;
        if (step.expectStatus !== undefined && status !== step.expectStatus) { rec.failed = 'status'; push('api', rec); fail({ type: 'api_status', message: `expected HTTP ${step.expectStatus}, got ${status}`, expected: String(step.expectStatus), actual: `${status} ${ctx.red.textPii(text.slice(0, 300))}`, url, status }); }
        if (step.expectSchema) { const v = validateJsonSchema(step.expectSchema, json); rec.schema = v; if (!v.ok) { push('api', rec); fail({ type: 'api_contract', message: `response does not match JSON schema: ${v.errors.slice(0, 3).join('; ')}`, actual: ctx.red.textPii(text.slice(0, 300)), url, status }); } }
        for (const jp of step.expectJsonPath ?? []) { const got = jsonPath(json, jp.path); if (jp.exists !== undefined && got.exists !== jp.exists) { push('api', rec); fail({ type: 'api_contract', message: `JSON path ${jp.path} ${jp.exists ? 'missing' : 'should not exist'}`, url, status }); } if (jp.equals !== undefined && JSON.stringify(got.value) !== JSON.stringify(jp.equals)) { push('api', rec); fail({ type: 'api_contract', message: `JSON path ${jp.path} mismatch`, expected: JSON.stringify(jp.equals), actual: JSON.stringify(got.value)?.slice(0, 200), url, status }); } }
        if (step.maxLatencyMs && latency > step.maxLatencyMs) { push('api', rec); fail({ type: 'performance', message: `API latency ${latency}ms > ${step.maxLatencyMs}ms`, url, status }); }
        push('api', rec);
        return;
      }
      case 'login_profile': { await loginWithProfile(ctx); return; }
      case 'crawl_inventory': {
        // BFS within the environment origin only. Third-party hosts are never requested.
        const origin = new URL(job.environment.baseUrl).origin;
        const start = page.url() && page.url() !== 'about:blank' ? page.url() : resolveUrl('/', job);
        const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
        const seen = new Set<string>(); const pages: Array<Record<string, unknown>> = [];
        while (queue.length && pages.length < step.maxPages) {
          const { url, depth } = queue.shift()!;
          const norm = url.split('#')[0]!; if (seen.has(norm)) continue; seen.add(norm);
          if (new URL(norm).origin !== origin) continue;
          let status = 0;
          try { const res = await page.goto(norm, { waitUntil: 'domcontentloaded', timeout: 20_000 }); status = res?.status() ?? 0; } catch (e) { pages.push({ url: norm, status: 0, error: String(e instanceof Error ? e.message : e).slice(0, 200), depth }); continue; }
          const info = await page.evaluate(() => ({ title: document.title, links: Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href), forms: Array.from(document.querySelectorAll('form')).map((f) => ({ id: f.id || null, action: f.getAttribute('action'), method: (f.getAttribute('method') || 'get').toLowerCase(), fields: Array.from(f.querySelectorAll('input,select,textarea')).map((i) => ({ name: (i as HTMLInputElement).name || null, type: (i as HTMLInputElement).type || i.tagName.toLowerCase(), required: (i as HTMLInputElement).required })) })) }));
          pages.push({ url: norm, status, title: info.title, depth, formCount: info.forms.length, forms: info.forms, linksCount: info.links.length });
          if (depth < step.maxDepth) for (const l of info.links) { try { const u = new URL(l); if (u.origin === origin && !seen.has(u.toString().split('#')[0]!)) queue.push({ url: u.toString(), depth: depth + 1 }); } catch { /* ignore */ } }
        }
        push('crawl', { stepIndex: index, pages: pages.length, truncated: queue.length > 0 });
        ctx.pendingArtifacts.push({ kind: 'report', label: 'crawl-inventory', stepIndex: index, contentType: 'application/json', buffer: Buffer.from(JSON.stringify({ origin, pages }, null, 2)) });
        (ctx.checks.crawlPages ??= []).push(...pages);
        return;
      }
      default: fail({ type: 'unknown', message: `unsupported step type ${(step as { type: string }).type}` });
    }
  } catch (e) {
    if (e instanceof StepFailure) { e.info.stepIndex = index; e.info.stepType = step.type; e.info.url ??= safeUrl(page); throw e; }
    const msg = ctx.red.text(e instanceof Error ? e.message : String(e));
    const type = /Timeout .*waiting for|locator.*resolved to|strict mode violation|not found|Target closed|detached/i.test(msg) ? (/strict mode|resolved to/i.test(msg) ? 'locator_not_found' : /Timeout/i.test(msg) ? 'timeout' : 'locator_not_found') : /net::|ERR_|navigation|goto/i.test(msg) ? 'navigation' : 'script_error';
    const tgt = (step as { target?: StepTarget }).target;
    throw new StepFailure({ type, message: msg.split('\n').slice(0, 3).join(' ').slice(0, 1000), stepIndex: index, stepType: step.type, locator: describeTarget(tgt), url: safeUrl(page), stack: e instanceof Error ? ctx.red.text(e.stack ?? '').slice(0, 2000) : undefined });
  }
}
function safeUrl(page: Page): string | undefined { try { return page.url(); } catch { return undefined; } }
function matchUrl(actual: string, expected: string, mode: 'contains' | 'exact' | 'regex' | 'startsWith'): boolean {
  const a = new URL(actual); const rel = a.pathname + a.search;
  if (mode === 'regex') return new RegExp(expected).test(actual) || new RegExp(expected).test(rel);
  const cands = expected.startsWith('/') ? [rel, a.pathname] : [actual];
  return cands.some((c) => mode === 'exact' ? c === expected : mode === 'startsWith' ? c.startsWith(expected) : c.includes(expected));
}

/** Environment authentication profiles. MFA bypass is intentionally not implemented. */
export async function loginWithProfile(ctx: StepContext): Promise<void> {
  const ap = ctx.job.environment.authProfile as { kind?: string; loginUrl?: string; usernameTarget?: StepTarget; passwordTarget?: StepTarget; submitTarget?: StepTarget; usernameSecretRef?: string; passwordSecretRef?: string; successUrlContains?: string };
  const { page, job } = ctx;
  const sec = (name?: string) => { if (!name) fail({ type: 'policy', message: 'auth profile is missing a secret reference' }); const v = job.secrets[name!]; if (v === undefined) fail({ type: 'policy', message: `secret "${name}" is not defined for this environment` }); return v as string; };
  switch (ap.kind) {
    case 'password_form': {
      await page.goto(resolveUrl(ap.loginUrl ?? '/login', job), { waitUntil: 'load' });
      await resolveLocator(page, ap.usernameTarget ?? { label: 'Email' }).fill(sec(ap.usernameSecretRef));
      await resolveLocator(page, ap.passwordTarget ?? { label: 'Password' }).fill(sec(ap.passwordSecretRef));
      await resolveLocator(page, ap.submitTarget ?? { role: 'button', name: /log ?in|sign ?in|ログイン/i.source }).first().click();
      if (ap.successUrlContains) await page.waitForURL((u) => u.toString().includes(ap.successUrlContains!), { timeout: 30_000 }).catch(() => fail({ type: 'navigation', message: `login did not reach "${ap.successUrlContains}"`, url: page.url() }));
      return;
    }
    case 'magic_link_test_mode': { await page.goto(resolveUrl(interpolate(ap.loginUrl ?? '/', job, ctx.vars), job), { waitUntil: 'load' }); return; }
    case 'storage_state': case 'basic': case 'bearer': case 'none': default: return; // applied at context creation
  }
}
