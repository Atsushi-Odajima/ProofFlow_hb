import type { Page, Locator } from 'playwright';
import type { StepTarget } from '@proofflow/shared';

/** Resolve a no-code target to a Playwright locator, preferring stable, user-facing strategies. */
export function resolveLocator(page: Page, t: StepTarget): Locator {
  let loc: Locator;
  if (t.testId) loc = page.getByTestId(t.testId);
  else if (t.role) loc = page.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name ? { name: t.name } : undefined);
  else if (t.label) loc = page.getByLabel(t.label);
  else if (t.placeholder) loc = page.getByPlaceholder(t.placeholder);
  else if (t.text) loc = page.getByText(t.text);
  else if (t.css) loc = page.locator(t.css);
  else if (t.name) loc = page.getByText(t.name);
  else throw new Error('empty target');
  if (t.nth !== undefined) loc = loc.nth(t.nth);
  return loc;
}
export function describeTarget(t: StepTarget | undefined): string {
  if (!t) return '';
  return Object.entries(t).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
}
