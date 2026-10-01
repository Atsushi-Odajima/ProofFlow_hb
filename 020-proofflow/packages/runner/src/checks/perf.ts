import type { Page } from 'playwright';

export interface PerfMetrics { ttfbMs?: number; domContentLoadedMs?: number; loadMs?: number; lcpMs?: number; transferBytes?: number; resourceCount?: number; }

/** Coarse page metrics from the Navigation Timing / LCP APIs. This is a regression smoke, not a load test. */
export async function perfMetrics(page: Page): Promise<PerfMetrics> {
  try {
    return await page.evaluate(async () => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      let lcp: number | undefined;
      try {
        lcp = await new Promise<number | undefined>((resolve) => {
          const entries = performance.getEntriesByType('largest-contentful-paint');
          if (entries.length) return resolve(entries[entries.length - 1]!.startTime);
          const po = new PerformanceObserver((l) => { const e = l.getEntries(); if (e.length) { resolve(e[e.length - 1]!.startTime); po.disconnect(); } });
          try { po.observe({ type: 'largest-contentful-paint', buffered: true }); } catch { resolve(undefined); }
          setTimeout(() => resolve(undefined), 1500);
        });
      } catch { lcp = undefined; }
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return { ttfbMs: nav ? Math.round(nav.responseStart - nav.requestStart) : undefined, domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : undefined, loadMs: nav ? Math.round(nav.loadEventEnd - nav.startTime) : undefined, lcpMs: lcp !== undefined ? Math.round(lcp) : undefined, transferBytes: res.reduce((a, r) => a + (r.transferSize || 0), 0) + (nav?.transferSize || 0), resourceCount: res.length };
    });
  } catch { return {}; }
}
