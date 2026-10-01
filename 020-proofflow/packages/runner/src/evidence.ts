import type { Page } from 'playwright';
import { redactString, redactHeaders } from '@proofflow/shared';
import type { ConsoleEntry, NetworkEntry } from './types.js';

export class Redactor {
  private secrets: string[];
  /** Texts shown by elements matched by the environment's maskSelectors (PII on the page); replaced with [masked] in every evidence string. */
  private masked: string[] = [];
  constructor(secrets: Record<string, string>, private extraHeaders: string[] = []) { this.secrets = Object.values(secrets).filter((v) => v && v.length >= 4); }
  addMaskedTexts(texts: string[]): void { for (const t of texts) { const v = t.trim(); if (v.length >= 3 && !this.masked.includes(v)) this.masked.push(v); } }
  private mask(s: string): string { let out = s; for (const m of this.masked) if (out.includes(m)) out = out.split(m).join('[masked]'); return out; }
  text(s: string): string { return redactString(this.mask(s), { secrets: this.secrets, piiPatterns: false }); }
  textPii(s: string): string { return redactString(this.mask(s), { secrets: this.secrets, piiPatterns: true }); }
  /** Redact the string fields of a failure record (message / expected / actual / stack / locator). */
  failure<T extends object>(f: T): T { const out = { ...f } as Record<string, unknown>; for (const k of ['message', 'expected', 'actual', 'stack', 'locator']) if (typeof out[k] === 'string') out[k] = this.text(out[k] as string); return out as T; }
  headers(h: Record<string, string>): Record<string, string> { const out = redactHeaders(h, this.extraHeaders); for (const k of Object.keys(out)) out[k] = this.text(out[k]!); return out; }
  url(u: string): string { try { const x = new URL(u); for (const [k, v] of x.searchParams) if (/token|key|secret|password|auth|session|sig/i.test(k) || this.secrets.includes(v)) x.searchParams.set(k, '[REDACTED]'); return this.text(x.toString()); } catch { return this.text(u); } }
}

const compile = (patterns: string[]) => patterns.map((p) => { try { return new RegExp(p, 'i'); } catch { return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } });

/** Attaches console/pageerror/network listeners to a page. Secrets are masked before anything is stored. */
export class EvidenceCollector {
  console: ConsoleEntry[] = []; network: NetworkEntry[] = [];
  private consoleIgnore: RegExp[]; private networkIgnore: RegExp[];
  private starts = new Map<string, number>();
  constructor(private red: Redactor, noise: { consoleIgnorePatterns: string[]; networkIgnorePatterns: string[] }, private captureBodies = false) { this.consoleIgnore = compile(noise.consoleIgnorePatterns); this.networkIgnore = compile(noise.networkIgnorePatterns); }
  attach(page: Page) {
    page.on('console', (m) => { if (this.console.length > 5000) return; const loc = m.location(); const text = this.red.text(m.text()).slice(0, 2000); this.console.push({ t: new Date().toISOString(), type: m.type(), text, url: loc.url ? this.red.url(loc.url) : undefined, line: loc.lineNumber, ignored: this.consoleIgnore.some((r) => r.test(text)) || undefined }); });
    page.on('pageerror', (e) => { if (this.console.length > 5000) return; const text = this.red.text(String(e.message ?? e)).slice(0, 2000); this.console.push({ t: new Date().toISOString(), type: 'pageerror', text, ignored: this.consoleIgnore.some((r) => r.test(text)) || undefined }); });
    page.on('request', (r) => { this.starts.set(r.url() + '#' + r.method(), Date.now()); });
    page.on('response', async (res) => {
      if (this.network.length > 5000) return;
      const req = res.request(); const key = req.url() + '#' + req.method(); const start = this.starts.get(key);
      const entry: NetworkEntry = { t: new Date().toISOString(), method: req.method(), url: this.red.url(req.url()), status: res.status(), ok: res.ok(), durationMs: start ? Date.now() - start : undefined, resourceType: req.resourceType(), mime: (res.headers()['content-type'] ?? '').split(';')[0] };
      entry.requestHeaders = this.red.headers(req.headers()); entry.responseHeaders = this.red.headers(res.headers());
      if (this.networkIgnore.some((r) => r.test(req.url()))) entry.ignored = true;
      if (this.captureBodies && (entry.mime?.includes('json') || entry.mime?.startsWith('text/'))) { try { const b = await res.text(); (entry as NetworkEntry & { body?: string }).body = this.red.textPii(b).slice(0, 10_000); } catch { /* body unavailable */ } }
      this.network.push(entry);
    });
    page.on('requestfailed', (req) => { if (this.network.length > 5000) return; const err = req.failure()?.errorText ?? 'failed'; this.network.push({ t: new Date().toISOString(), method: req.method(), url: this.red.url(req.url()), failed: err, resourceType: req.resourceType(), ignored: this.networkIgnore.some((r) => r.test(req.url())) || err === 'net::ERR_ABORTED' || undefined }); });
  }
  consoleSummary() {
    const errors = this.console.filter((c) => (c.type === 'error' || c.type === 'pageerror') && !c.ignored);
    const warnings = this.console.filter((c) => c.type === 'warning' && !c.ignored);
    return { total: this.console.length, errors: errors.length, warnings: warnings.length, ignored: this.console.filter((c) => c.ignored).length, uncaught: this.console.filter((c) => c.type === 'pageerror' && !c.ignored).length, errorSamples: errors.slice(0, 20).map((e) => ({ type: e.type, text: e.text.slice(0, 300), url: e.url })) };
  }
  networkSummary() {
    const failed = this.network.filter((n) => !n.ignored && (n.failed || (n.status ?? 0) >= 400));
    const slow = this.network.filter((n) => !n.ignored && (n.durationMs ?? 0) > 2000);
    return { total: this.network.length, failed: failed.length, status4xx: this.network.filter((n) => !n.ignored && (n.status ?? 0) >= 400 && (n.status ?? 0) < 500).length, status5xx: this.network.filter((n) => !n.ignored && (n.status ?? 0) >= 500).length, requestFailed: this.network.filter((n) => !n.ignored && n.failed).length, slow: slow.length, failedSamples: failed.slice(0, 20).map((n) => ({ method: n.method, url: n.url, status: n.status, failed: n.failed, durationMs: n.durationMs })), slowSamples: slow.slice(0, 10).map((n) => ({ url: n.url, durationMs: n.durationMs })) };
  }
  ndjson(entries: unknown[]): Buffer { return Buffer.from(entries.map((e) => this.red.text(JSON.stringify(e))).join('\n') + '\n'); }
}
