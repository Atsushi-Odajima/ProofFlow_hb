import type { Page, BrowserContext } from 'playwright';
import { checkTargetUrl } from '@proofflow/shared';

export interface LinkResult { url: string; status?: number; finalUrl?: string; error?: string; redirected?: boolean; durationMs: number; }

/** Checks links found on the current page (same-origin by default). Never crawls third-party sites unless allowed. */
export async function linkCheck(page: Page, context: BrowserContext, opts: { sameOriginOnly: boolean; maxLinks: number; allowPrivate: boolean; allowedHosts?: string[] }): Promise<{ checked: number; broken: LinkResult[]; results: LinkResult[] }> {
  const base = new URL(page.url());
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href));
  const seen = new Set<string>(); const targets: string[] = [];
  for (const h of hrefs) {
    let u: URL; try { u = new URL(h); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = '';
    if (opts.sameOriginOnly && u.origin !== base.origin) continue;
    const pol = checkTargetUrl(u.toString(), { allowPrivateNetwork: opts.allowPrivate, allowedHosts: opts.allowedHosts });
    if (!pol.allowed) continue;
    if (seen.has(u.toString())) continue; seen.add(u.toString()); targets.push(u.toString());
    if (targets.length >= opts.maxLinks) break;
  }
  const results: LinkResult[] = [];
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift()!; const t0 = Date.now();
      try {
        let res = await context.request.fetch(url, { method: 'HEAD', maxRedirects: 5, timeout: 15_000 });
        if (res.status() === 405 || res.status() === 501) res = await context.request.fetch(url, { method: 'GET', maxRedirects: 5, timeout: 15_000 });
        results.push({ url, status: res.status(), finalUrl: res.url(), redirected: res.url() !== url, durationMs: Date.now() - t0 });
      } catch (e) { results.push({ url, error: String(e instanceof Error ? e.message : e).slice(0, 200), durationMs: Date.now() - t0 }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, targets.length) }, worker));
  const broken = results.filter((r) => r.error || (r.status ?? 0) >= 400);
  return { checked: results.length, broken, results };
}
