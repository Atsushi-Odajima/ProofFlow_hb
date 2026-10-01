import { z } from 'zod';

// Typed, no-code steps. No arbitrary JavaScript is accepted from users.
const Target = z.object({
  // Stable locator strategies, resolved by the runner in order of preference.
  role: z.string().optional(),      // ARIA role e.g. 'button'
  name: z.string().optional(),      // accessible name (used with role)
  label: z.string().optional(),     // form label text
  placeholder: z.string().optional(),
  text: z.string().optional(),      // visible text
  testId: z.string().optional(),    // data-testid
  css: z.string().max(500).optional(), // last resort
  nth: z.number().int().min(0).optional(),
}).refine((t) => Object.keys(t).some((k) => k !== 'nth' && (t as Record<string, unknown>)[k] !== undefined), { message: 'target needs at least one locator strategy' });
export type StepTarget = z.infer<typeof Target>;

const Base = { note: z.string().max(500).optional(), timeoutMs: z.number().int().min(100).max(120_000).optional() };

export const StepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string().max(2000), waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(), ...Base }),
  z.object({ type: z.literal('click'), target: Target, button: z.enum(['left', 'right', 'middle']).optional(), force: z.boolean().optional(), ...Base }),
  z.object({ type: z.literal('fill'), target: Target, value: z.string().max(10_000), ...Base }),       // value may contain {{secret:NAME}} / {{data:KEY}}
  z.object({ type: z.literal('select'), target: Target, value: z.string().max(500), ...Base }),
  z.object({ type: z.literal('check'), target: Target, checked: z.boolean().default(true), ...Base }),
  z.object({ type: z.literal('press'), key: z.string().max(50), target: Target.optional(), ...Base }),
  z.object({ type: z.literal('hover'), target: Target, ...Base }),
  z.object({ type: z.literal('upload'), target: Target, fixture: z.string().max(200), ...Base }),   // named fixture file (server-managed), never a host path
  z.object({ type: z.literal('download'), target: Target, expectFilename: z.string().max(300).optional(), expectMime: z.string().max(100).optional(), ...Base }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(60_000).optional(), target: Target.optional(), state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(), url: z.string().max(2000).optional(), ...Base }),
  z.object({ type: z.literal('assert_text'), target: Target.optional(), text: z.string().max(2000), match: z.enum(['contains', 'exact', 'regex']).default('contains'), negate: z.boolean().optional(), ...Base }),
  z.object({ type: z.literal('assert_url'), url: z.string().max(2000), match: z.enum(['contains', 'exact', 'regex', 'startsWith']).default('contains'), ...Base }),
  z.object({ type: z.literal('assert_element'), target: Target, state: z.enum(['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked', 'attached']).default('visible'), count: z.number().int().min(0).optional(), ...Base }),
  z.object({ type: z.literal('assert_value'), target: Target, value: z.string().max(2000), ...Base }),
  z.object({ type: z.literal('assert_title'), title: z.string().max(500), match: z.enum(['contains', 'exact']).default('contains'), ...Base }),
  z.object({ type: z.literal('assert_no_horizontal_scroll'), ...Base }),
  z.object({ type: z.literal('assert_console'), maxErrors: z.number().int().min(0).default(0), ignorePatterns: z.array(z.string().max(300)).max(50).optional(), ...Base }),
  z.object({ type: z.literal('assert_network'), noStatusAtLeast: z.number().int().min(100).max(599).default(500), urlPattern: z.string().max(500).optional(), maxDurationMs: z.number().int().min(1).optional(), ...Base }),
  z.object({ type: z.literal('api_request'), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']), url: z.string().max(2000), headers: z.record(z.string(), z.string().max(2000)).optional(), body: z.unknown().optional(), expectStatus: z.number().int().min(100).max(599).optional(), expectSchema: z.record(z.string(), z.unknown()).optional(), expectJsonPath: z.array(z.object({ path: z.string().max(300), equals: z.unknown().optional(), exists: z.boolean().optional() })).max(50).optional(), maxLatencyMs: z.number().int().min(1).optional(), saveAs: z.string().max(50).optional(), ...Base }),
  z.object({ type: z.literal('screenshot'), label: z.string().max(100).optional(), fullPage: z.boolean().optional(), visualCheck: z.boolean().optional(), maskSelectors: z.array(z.string().max(300)).max(50).optional(), maxDiffRatio: z.number().min(0).max(1).optional(), ...Base }),
  z.object({ type: z.literal('responsive_check'), ...Base }),
  z.object({ type: z.literal('accessibility_check'), tags: z.array(z.string().max(30)).max(20).optional(), failOn: z.array(z.enum(['critical', 'serious', 'moderate', 'minor'])).optional(), disableRules: z.array(z.string().max(80)).max(50).optional(), ...Base }),
  z.object({ type: z.literal('link_check'), sameOriginOnly: z.boolean().default(true), maxLinks: z.number().int().min(1).max(500).default(100), ...Base }),
  z.object({ type: z.literal('form_check'), target: Target, submitTarget: Target.optional(), expectDoubleSubmitGuard: z.boolean().optional(), expectErrorOnEmpty: z.boolean().optional(), ...Base }),
  z.object({ type: z.literal('perf_check'), maxTtfbMs: z.number().int().min(1).optional(), maxLoadMs: z.number().int().min(1).optional(), maxLcpMs: z.number().int().min(1).optional(), ...Base }),
  z.object({ type: z.literal('set_viewport'), width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000), ...Base }),
  z.object({ type: z.literal('login_profile'), ...Base }), // use environment auth profile (password / storage state / magic-link test mode)
]);
export type Step = z.infer<typeof StepSchema>;
export const StepsSchema = z.array(StepSchema).min(1).max(300);

export const DESTRUCTIVE_HINT_TYPES = new Set(['api_request', 'upload', 'form_check']);

/** Steps that can mutate the system under test (used with Environment destructive policy). */
export function isStepPotentiallyDestructive(step: Step): boolean {
  if (step.type === 'api_request') return step.method !== 'GET' && step.method !== 'HEAD' && step.method !== 'OPTIONS';
  return false;
}

export const SECRET_REF_RE = /\{\{\s*secret:([A-Za-z0-9_.-]+)\s*\}\}/g;
export const DATA_REF_RE = /\{\{\s*data:([A-Za-z0-9_.-]+)\s*\}\}/g;

export function extractSecretRefs(steps: Step[]): string[] {
  const out = new Set<string>();
  const json = JSON.stringify(steps);
  for (const m of json.matchAll(SECRET_REF_RE)) out.add(m[1] as string);
  return [...out];
}
