import type { Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

export interface A11yViolation { id: string; impact: string; help: string; helpUrl: string; tags: string[]; nodes: { target: string; html: string; failureSummary?: string }[]; }

/** Automated accessibility scan (axe-core). Automated checks find only a subset of WCAG issues — see manual checklist. */
export async function accessibilityCheck(page: Page, opts: { tags?: string[]; disableRules?: string[] } = {}): Promise<{ engine: string; violations: A11yViolation[]; passes: number; incomplete: number; counts: Record<string, number> }> {
  let builder = new AxeBuilder({ page }).withTags(opts.tags ?? ['wcag2a', 'wcag2aa', 'wcag21aa']);
  if (opts.disableRules?.length) builder = builder.disableRules(opts.disableRules);
  const res = await builder.analyze();
  const violations: A11yViolation[] = res.violations.map((v) => ({ id: v.id, impact: v.impact ?? 'minor', help: v.help, helpUrl: v.helpUrl, tags: v.tags, nodes: v.nodes.slice(0, 20).map((n) => ({ target: Array.isArray(n.target) ? n.target.map(String).join(' ') : String(n.target), html: n.html.slice(0, 300), failureSummary: n.failureSummary })) }));
  const counts: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) counts[v.impact] = (counts[v.impact] ?? 0) + 1;
  return { engine: `axe-core ${res.testEngine?.version ?? ''}`.trim(), violations, passes: res.passes.length, incomplete: res.incomplete.length, counts };
}
