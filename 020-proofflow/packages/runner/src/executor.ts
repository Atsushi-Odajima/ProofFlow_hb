import type { Browser, BrowserContext, Page } from 'playwright';
import { devices } from 'playwright';
import { mkdirSync, rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ControlClient } from './client.js';
import type { BrowserPool } from './browsers.js';
import { EvidenceCollector, Redactor } from './evidence.js';
import { executeStep, type StepContext } from './steps.js';
import { redactTraceZip } from './trace-redact.js';
import { perfMetrics } from './checks/perf.js';
import { StepFailure, InfraError, CancelledError, type JobPayload, type AttemptResult, type StepRecord, type FailureInfo } from './types.js';

export interface ExecutorOptions { workDir: string; log?: (msg: string) => void; }

/** Executes one leased job: attempts (retries) → evidence → artifacts → completion. */
export class JobExecutor {
  constructor(private client: ControlClient, private pool: BrowserPool, private opts: ExecutorOptions) {}
  private log(m: string) { this.opts.log?.(m); }

  async run(job: JobPayload): Promise<void> {
    const jobDir = join(this.opts.workDir, job.jobId); mkdirSync(jobDir, { recursive: true });
    const startedAt = new Date().toISOString(); const t0 = Date.now();
    let cancelled = false;
    const hb = setInterval(() => { this.client.heartbeat(job.jobId, { message: 'running' }).then((r) => { if (r.cancelled) cancelled = true; }).catch(() => undefined); }, 30_000);
    const attempts: AttemptResult[] = [];
    try {
      const browser = await this.pool.get(job.browser);
      const maxAttempts = job.options.retries + 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (cancelled) throw new CancelledError();
        await this.client.heartbeat(job.jobId, { attempt, message: attempt > 1 ? `retry ${attempt - 1}` : 'start' }).then((r) => { if (r.cancelled) cancelled = true; }).catch(() => undefined);
        if (cancelled) throw new CancelledError();
        const r = await this.runAttempt(job, browser, attempt, jobDir, maxAttempts);
        attempts.push(r);
        if (r.status === 'passed' || r.failure?.type === 'policy') break;
      }
      const last = attempts[attempts.length - 1]!;
      const passed = last.status === 'passed';
      const status = passed ? (attempts.length > 1 ? 'flaky' : 'passed') : 'failed';
      const outcomeDetail = passed ? (attempts.length > 1 ? 'passed_after_retry' : 'passed_first_try') : attempts.length > 1 ? 'failed_after_retries' : 'failed_first_try';
      const artifactIds = attempts.flatMap((a) => a.artifactIds);
      await this.client.complete(job.jobId, { status, outcomeDetail, attempts: attempts.length, durationMs: Date.now() - t0, startedAt, completedAt: new Date().toISOString(), browserVersion: last.browserVersion, failure: passed ? null : last.failure, steps: last.steps, consoleSummary: last.consoleSummary, networkSummary: last.networkSummary, metrics: last.metrics, checks: last.checks, attemptsDetail: attempts.map((a) => ({ attempt: a.attempt, status: a.status, durationMs: a.durationMs, failure: a.failure, steps: a.steps, startedAt: a.startedAt, completedAt: a.completedAt })) }, artifactIds);
      this.log(`job ${job.jobId} ${job.scenario.key} ${job.browser} → ${status} (${attempts.length} attempt(s))`);
    } catch (e) {
      if (e instanceof CancelledError) { this.log(`job ${job.jobId} cancelled`); await this.client.complete(job.jobId, { status: 'cancelled', outcomeDetail: 'not_run', attempts: attempts.length, durationMs: Date.now() - t0, startedAt, completedAt: new Date().toISOString(), failure: { type: 'infra', message: 'cancelled' } }, attempts.flatMap((a) => a.artifactIds)).catch(() => undefined); return; }
      const msg = e instanceof Error ? e.message : String(e);
      const kind = e instanceof InfraError ? e.kind : 'infra';
      this.log(`job ${job.jobId} infrastructure error: ${msg}`);
      await this.client.fail(job.jobId, { message: msg.slice(0, 2000), kind }).catch(() => undefined);
    } finally {
      clearInterval(hb);
      try { rmSync(jobDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  private contextOptions(job: JobPayload) {
    const v = job.viewport;
    const dev = v.device && devices[v.device] ? devices[v.device] : undefined;
    const base: Record<string, unknown> = { ...(dev ?? {}), viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.deviceScaleFactor ?? dev?.deviceScaleFactor ?? 1, hasTouch: v.hasTouch ?? dev?.hasTouch ?? false, baseURL: job.environment.baseUrl, acceptDownloads: true, locale: 'ja-JP', serviceWorkers: 'block' };
    if (job.browser !== 'firefox') base.isMobile = v.isMobile ?? dev?.isMobile ?? false; // isMobile is not supported in Firefox
    else delete base.isMobile;
    const ap = job.environment.authProfile as { kind?: string; storageStateSecretRef?: string; tokenSecretRef?: string; usernameSecretRef?: string; passwordSecretRef?: string };
    if (ap.kind === 'storage_state' && ap.storageStateSecretRef && job.secrets[ap.storageStateSecretRef]) { try { base.storageState = JSON.parse(job.secrets[ap.storageStateSecretRef]!); } catch { throw new InfraError('storage state secret is not valid JSON', 'policy'); } }
    if (ap.kind === 'bearer' && ap.tokenSecretRef && job.secrets[ap.tokenSecretRef]) base.extraHTTPHeaders = { authorization: `Bearer ${job.secrets[ap.tokenSecretRef]}` };
    if (ap.kind === 'basic' && ap.usernameSecretRef && ap.passwordSecretRef) base.httpCredentials = { username: job.secrets[ap.usernameSecretRef] ?? '', password: job.secrets[ap.passwordSecretRef] ?? '' };
    return base;
  }

  private async runAttempt(job: JobPayload, browser: Browser, attempt: number, jobDir: string, maxAttempts: number): Promise<AttemptResult> {
    const startedAt = new Date().toISOString(); const t0 = Date.now();
    const attemptDir = join(jobDir, `attempt-${attempt}`); mkdirSync(attemptDir, { recursive: true });
    const red = new Redactor(job.secrets, job.environment.privacy.redactHeaders);
    const maskSel = job.environment.privacy.maskSelectors ?? [];
    /** Register the texts currently shown by masked elements (PII) so failure messages, step records, console/network and DOM never carry them. */
    const refreshMasked = async () => {
      if (!page || !maskSel.length) return;
      try {
        const texts = await page.evaluate((sels: string[]) => { const out: string[] = []; for (const s of sels) { try { document.querySelectorAll(s).forEach((el) => { const t = ((el as HTMLElement).innerText || el.textContent || '').trim(); if (t) out.push(t); const v = (el as HTMLInputElement).value; if (typeof v === 'string' && v.trim()) out.push(v.trim()); }); } catch { /* invalid selector */ } } return out.slice(0, 200); }, maskSel);
        red.addMaskedTexts(texts);
      } catch { /* page may be gone */ }
    };
    const evidence = new EvidenceCollector(red, job.environment.noise, job.environment.privacy.captureBodies);
    const videoWanted = job.options.video === 'always' || job.options.video === 'on_failure' || (job.options.video === 'on_retry' && (attempt > 1 || maxAttempts > 1));
    const traceWanted = job.options.trace !== 'off';
    let context: BrowserContext | undefined; let page: Page | undefined;
    const steps: StepRecord[] = []; let failure: FailureInfo | null = null; const artifactIds: string[] = [];
    const sctx: StepContext = { job, page: undefined as unknown as Page, context: undefined as unknown as BrowserContext, evidence, red, workDir: attemptDir, attempt, vars: {}, checks: {}, pendingArtifacts: [], fixtureFiles: new Map(), baselineCache: new Map(), download: (u) => this.client.download(u) };
    let metrics: unknown = null; let browserVersion: string | undefined;
    try {
      context = await browser.newContext({ ...(this.contextOptions(job) as Parameters<Browser['newContext']>[0]), recordVideo: videoWanted ? { dir: join(attemptDir, 'video') } : undefined });
      context.setDefaultTimeout(job.options.stepTimeoutMs);
      if (traceWanted) await context.tracing.start({ screenshots: true, snapshots: true, sources: false, title: `${job.scenario.key} ${job.browser} attempt ${attempt}` });
      page = await context.newPage();
      browserVersion = browser.version();
      evidence.attach(page);
      sctx.page = page; sctx.context = context;
      const deadline = Date.now() + job.options.jobTimeoutMs;
      for (let i = 0; i < job.scenario.steps.length; i++) {
        const step = job.scenario.steps[i]!;
        if (Date.now() > deadline) throw new StepFailure({ type: 'timeout', message: `job timeout (${job.options.jobTimeoutMs}ms) exceeded before step ${i}`, stepIndex: i, stepType: step.type });
        const st = Date.now();
        try { await executeStep(sctx, step, i); steps.push({ index: i, type: step.type, status: 'passed', durationMs: Date.now() - st, url: safeUrl(page) }); }
        catch (e) {
          await refreshMasked();
          const info: FailureInfo = red.failure(e instanceof StepFailure ? e.info : { type: 'script_error', message: red.text(String(e)), stepIndex: i, stepType: step.type });
          steps.push({ index: i, type: step.type, status: 'failed', durationMs: Date.now() - st, message: info.message, url: safeUrl(page) });
          for (let k = i + 1; k < job.scenario.steps.length; k++) steps.push({ index: k, type: job.scenario.steps[k]!.type, status: 'skipped', durationMs: 0 });
          failure = info; break;
        }
      }
      metrics = await perfMetrics(page);
    } catch (e) {
      if (e instanceof InfraError) throw e;
      if (e instanceof StepFailure) { await refreshMasked(); failure = red.failure(e.info); } else { const msg = String(e instanceof Error ? e.message : e); if (/Target page, context or browser has been closed|browserContext\.newPage|has been closed/.test(msg)) throw new InfraError(red.text(msg).split('\n')[0]!); failure = { type: 'script_error', message: red.text(msg).slice(0, 1000) }; }
    }
    const failed = failure !== null;
    // ---- evidence on failure: screenshot, DOM snapshot ----
    const upload = async (opts: { kind: string; label?: string; stepIndex?: number; contentType: string; path?: string; buffer?: Buffer; restricted?: boolean }) => { try { artifactIds.push(await this.client.uploadArtifact(job.jobId, { ...opts, attempt })); } catch (e) { this.log(`artifact upload failed (${opts.kind}): ${e instanceof Error ? e.message : e}`); } };
    if (page && failed) {
      try { const mask = job.environment.privacy.maskSelectors.map((s) => page!.locator(s)); const shot = await page.screenshot({ fullPage: true, mask, timeout: 15_000, animations: 'disabled' }); await upload({ kind: 'screenshot', label: 'failure', stepIndex: failure!.stepIndex, contentType: 'image/png', buffer: shot }); } catch (e) { this.log(`failure screenshot failed: ${e instanceof Error ? e.message : e}`); }
      try {
        // DOM snapshot: elements matched by the environment's maskSelectors are blanked (text + input values) before capture, like the screenshot mask.
        const maskSel = job.environment.privacy.maskSelectors ?? [];
        if (maskSel.length) { try { await page.evaluate((sels: string[]) => { for (const s of sels) { let els: Element[] = []; try { els = Array.from(document.querySelectorAll(s)); } catch { /* bad selector */ } for (const el of els) { el.textContent = '[masked]'; if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = ''; for (const a of ['value', 'src', 'alt', 'title']) if (el.hasAttribute(a)) el.setAttribute(a, '[masked]'); } } }, maskSel); } catch { /* page may be gone */ } }
        const html = red.textPii(await page.content()); await upload({ kind: 'dom', label: 'failure', stepIndex: failure!.stepIndex, contentType: 'text/html', buffer: Buffer.from(html.slice(0, 2_000_000)) });
      } catch { /* ignore */ }
    }
    for (const a of sctx.pendingArtifacts) await upload({ kind: a.kind, label: a.label, stepIndex: a.stepIndex, contentType: a.contentType, buffer: a.buffer, path: a.path });
    // ---- trace / video (only kept when policy says so) ----
    if (context) {
      if (traceWanted) {
        const keep = job.options.trace === 'always' || failed;
        const tracePath = join(attemptDir, 'trace.zip');
        try { await context.tracing.stop(keep ? { path: tracePath } : undefined); } catch (e) { this.log(`trace stop failed: ${e instanceof Error ? e.message : e}`); }
        if (keep && existsSync(tracePath)) { try { await redactTraceZip(tracePath, red, job.environment.privacy.redactHeaders); await upload({ kind: 'trace', label: 'trace', contentType: 'application/zip', path: tracePath }); } catch (e) { this.log(`trace upload failed: ${e instanceof Error ? e.message : e}`); } }
      }
      const video = page?.video();
      try { await context.close(); } catch { /* ignore */ }
      if (video) {
        const keep = job.options.video === 'always' || ((job.options.video === 'on_failure' || job.options.video === 'on_retry') && failed) || (job.options.video === 'on_retry' && attempt > 1);
        try { const vp = await video.path(); if (keep && existsSync(vp)) await upload({ kind: 'video', label: 'video', contentType: 'video/webm', buffer: readFileSync(vp) }); if (existsSync(vp)) unlinkSync(vp); } catch { /* ignore */ }
      }
    }
    await upload({ kind: 'console', label: 'console', contentType: 'application/x-ndjson', buffer: evidence.ndjson(evidence.console.slice(0, 2000)) });
    await upload({ kind: 'network', label: 'network', contentType: 'application/x-ndjson', buffer: evidence.ndjson(evidence.network.slice(0, 2000)) });
    return { attempt, status: failed ? 'failed' : 'passed', durationMs: Date.now() - t0, failure, steps, startedAt, completedAt: new Date().toISOString(), artifactIds, consoleSummary: evidence.consoleSummary(), networkSummary: evidence.networkSummary(), metrics, checks: sctx.checks, browserVersion };
  }
}
function safeUrl(page: Page | undefined): string | undefined { try { return page?.url(); } catch { return undefined; } }
