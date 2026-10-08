// ProofFlow 不具合報告 — report schema. Derived from ErrorRelay's ReportSchema (schema/report.ts), narrowed to what a
// ProofFlow Defect needs: OpenAI-product specific fields (product, conversationId, CLI/model, submissions/adapters) were dropped.
// Browser-safe: this module (and everything under bugreport/) must not import node:* modules — the web app bundles it.
import { z } from 'zod';

export const BUG_REPORT_SCHEMA_VERSION = '1.0.0';

export const TimestampSourceSchema = z.enum(['user_now', 'user_manual', 'screenshot_metadata', 'screenshot_visible', 'log', 'system', 'unknown']);
export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const TimestampSchema = z.object({
  /** UTC instant, ISO 8601. */
  iso: z.string().datetime({ offset: true }),
  /** IANA timezone, e.g. Asia/Tokyo. */
  timezone: z.string().min(1).max(64),
  /** e.g. "2026-09-30 13:44 GMT+9 / Asia/Tokyo" */
  display: z.string().max(120),
  source: TimestampSourceSchema,
  confidence: ConfidenceSchema,
});
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Tri-state provenance for environment values: auto captured, manual, inferred, or unknown (never guessed). */
export const EnvSourceSchema = z.enum(['auto', 'manual', 'inferred', 'unknown']);
export const EnvFieldSchema = z.object({ value: z.string().max(2000).nullable(), source: EnvSourceSchema });
export type EnvField = z.infer<typeof EnvFieldSchema>;

export const ENV_KEYS = ['pageUrl', 'appVersion', 'browser', 'os', 'osVersion', 'device', 'platform', 'userAgent', 'viewport', 'displayMode', 'networkState', 'locale'] as const;
export type EnvKey = (typeof ENV_KEYS)[number];
export type ReportEnvironment = Record<EnvKey, EnvField>;
export const ReportEnvironmentSchema = z.object(Object.fromEntries(ENV_KEYS.map((k) => [k, EnvFieldSchema.optional()])) as Record<EnvKey, z.ZodOptional<typeof EnvFieldSchema>>);

export const FrequencySchema = z.enum(['first_time', 'sometimes', 'always', 'unknown']);
export type Frequency = z.infer<typeof FrequencySchema>;
export const LanguageSchema = z.enum(['ja', 'en']);
export type Lang = z.infer<typeof LanguageSchema>;
export const RedactionDecisionSchema = z.enum(['redact', 'keep']);

/** What a reporter submits (before ProofFlow 個人情報マスク is applied on the server). */
export const BugReportContentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10_000).default(''),
  expected: z.string().max(5_000).default(''),
  actual: z.string().max(5_000).default(''),
  steps: z.array(z.string().max(1_000)).max(50).default([]),
  errorText: z.string().max(20_000).default(''),
  frequency: FrequencySchema.default('unknown'),
  occurredAt: TimestampSchema.nullable().default(null),
  environment: ReportEnvironmentSchema.default({}),
  reporterName: z.string().max(100).default(''),
  additionalNotes: z.string().max(5_000).default(''),
  language: LanguageSchema.default('ja'),
});
export type BugReportContentInput = z.input<typeof BugReportContentSchema>;
export type BugReportContent = Omit<z.output<typeof BugReportContentSchema>, 'environment'> & { environment: ReportEnvironment };

export interface RedactionSummary {
  /** Category → count of redacted findings. Never contains the original strings. */
  counts: Record<string, number>;
  /** Categories the reporter chose to keep as-is (category only). */
  keptCategories: string[];
  scannerVersion: string;
  note: string;
}

export function unknownEnv(): EnvField { return { value: null, source: 'unknown' }; }
export function emptyEnvironment(): ReportEnvironment {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, unknownEnv()])) as ReportEnvironment;
}
/** Normalize a parsed content object: fills missing environment keys with "unknown". */
export function normalizeContent(c: z.output<typeof BugReportContentSchema>): BugReportContent {
  const env = emptyEnvironment();
  for (const k of ENV_KEYS) { const f = c.environment[k]; if (f) env[k] = f.value == null || f.value === '' ? unknownEnv() : f; }
  return { ...c, steps: c.steps.map((s) => s.trim()).filter(Boolean), environment: env };
}
