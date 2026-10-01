import { z } from 'zod';
import { StepSchema } from '@proofflow/shared';

/** Output contracts for each AI feature. Every provider response is validated against these before being stored. */
export const ScenarioDraftOutput = z.object({
  drafts: z.array(z.object({
    title: z.string().min(1).max(300),
    steps: z.array(StepSchema).min(1).max(60),
    // Expected must come from the requirement/prompt. When the source does not state it, the model must leave it null and mark 'unspecified'.
    expected: z.string().max(2000).nullable(),
    expectedSource: z.enum(['requirement', 'prompt', 'unspecified']),
    priority: z.enum(['p0', 'p1', 'p2', 'p3']).default('p2'),
    tags: z.array(z.string().max(40)).max(10).default([]),
    rationale: z.string().max(1000).optional(),
  })).min(1).max(12),
  gaps: z.array(z.string().max(500)).max(20).default([]),
});
export const FailureSummaryOutput = z.object({
  whatFailed: z.string().max(2000),
  step: z.string().max(500).nullable(),
  browser: z.string().max(200).nullable(),
  request: z.string().max(500).nullable(),
  reproductionHints: z.array(z.string().max(500)).max(10),
  rootCause: z.object({ confidence: z.enum(['confirmed', 'evidence_suggests', 'possible', 'unknown']), statement: z.string().max(2000) }),
  suggestedSeverity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});
export const DefectDraftOutput = z.object({ title: z.string().max(300), severity: z.enum(['critical', 'high', 'medium', 'low']), priority: z.enum(['p0', 'p1', 'p2', 'p3']), reproduction: z.string().max(10_000), expected: z.string().max(5000), actual: z.string().max(5000), evidenceNotes: z.array(z.string().max(500)).max(20).default([]) });
export const SelectorRepairOutput = z.object({ candidates: z.array(z.object({ target: z.record(z.string(), z.unknown()), confidence: z.number().min(0).max(1), reason: z.string().max(500) })).max(5) });
export const TestGapOutput = z.object({ gaps: z.array(z.object({ title: z.string().max(300), reason: z.string().max(1000), priority: z.enum(['p0', 'p1', 'p2', 'p3']).default('p3'), draftSteps: z.array(StepSchema).max(30).optional() })).max(20) });
export const ExploratoryNotesOutput = z.object({ summary: z.string().max(4000), findings: z.array(z.string().max(1000)).max(50), candidateDefects: z.array(z.object({ title: z.string().max(300), severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), note: z.string().max(2000) })).max(20) });

export const OUTPUT_SCHEMAS = { scenario_draft: ScenarioDraftOutput, failure_summary: FailureSummaryOutput, defect_draft: DefectDraftOutput, selector_repair: SelectorRepairOutput, test_gap: TestGapOutput, exploratory_notes: ExploratoryNotesOutput } as const;
export type AiFeatureName = keyof typeof OUTPUT_SCHEMAS;

const STEP_CATALOG = `Available step types (JSON objects with "type"): navigate{url}, click{target}, fill{target,value}, select{target,value}, check{target,checked}, press{key,target?}, hover{target}, upload{target,fixture}, download{target,expectFilename?,expectMime?}, wait{ms?|target?+state?|url?}, assert_text{target?,text,match}, assert_url{url,match}, assert_element{target,state,count?}, assert_value{target,value}, assert_title{title,match}, assert_no_horizontal_scroll{}, assert_console{maxErrors,ignorePatterns?}, assert_network{noStatusAtLeast,urlPattern?}, api_request{method,url,headers?,body?,expectStatus?,expectSchema?,expectJsonPath?,maxLatencyMs?}, screenshot{label?,fullPage?,visualCheck?}, responsive_check{}, accessibility_check{tags?,failOn?}, link_check{sameOriginOnly,maxLinks}, form_check{target,submitTarget?,expectDoubleSubmitGuard?,expectErrorOnEmpty?}, perf_check{maxTtfbMs?,maxLoadMs?}, set_viewport{width,height}, login_profile{}.
"target" is a locator object with one or more of: role, name, label, placeholder, text, testId, css. Prefer role+name or label. Never emit JavaScript. Secrets are referenced as "{{secret:NAME}}", test data as "{{data:KEY}}". URLs are relative to the environment base URL.`;

export function buildPrompt(feature: AiFeatureName, input: Record<string, unknown>): { system: string; user: string } {
  switch (feature) {
    case 'scenario_draft':
      return {
        system: `You are a QA engineer drafting acceptance test scenarios for ProofFlow (a no-code browser test platform). ${STEP_CATALOG}
Rules: (1) Only state an "expected" value when it is explicitly given in the requirement/acceptance criteria or the user's prompt; otherwise set expected to null and expectedSource to "unspecified" so a human fills it in. Never invent business rules. (2) Cover normal flow, required-field validation, invalid input, duplicates, mobile viewport and error handling when relevant to the request. (3) Output JSON only, matching the schema.`,
        user: JSON.stringify(input),
      };
    case 'failure_summary':
      return { system: `You summarize automated browser-test failures for engineers. Use ONLY the evidence provided (assertion, step, console, network, trace excerpt). Distinguish root-cause confidence: "confirmed" only when evidence directly shows it, "evidence_suggests", "possible", or "unknown". Do not claim the test result is wrong; you cannot change results. Output JSON only.`, user: JSON.stringify(input) };
    case 'defect_draft':
      return { system: `You draft a defect report from test evidence. Reproduction steps must be derivable from the scenario steps. Expected comes from the scenario's expected/assertion; actual from the failure. Do not speculate beyond evidence. Output JSON only.`, user: JSON.stringify(input) };
    case 'selector_repair':
      return { system: `A locator failed. Propose up to 5 alternative locator objects (role/name/label/placeholder/text/testId/css) based on the provided DOM excerpt. These are proposals only; a human will review and the test must be rerun. Output JSON only.`, user: JSON.stringify(input) };
    case 'test_gap':
      return { system: `Given requirements, existing scenarios and (optionally) a page inventory, list test gaps as candidates. Candidates are suggestions; never claim the gate can skip required suites. Output JSON only.`, user: JSON.stringify(input) };
    case 'exploratory_notes':
      return { system: `Organize an exploratory testing session's raw notes into a summary, findings and candidate defects. Do not add findings that are not in the notes. Output JSON only.`, user: JSON.stringify(input) };
  }
}

export function jsonSchemaFor(feature: AiFeatureName): Record<string, unknown> {
  return z.toJSONSchema(OUTPUT_SCHEMAS[feature], { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;
}
