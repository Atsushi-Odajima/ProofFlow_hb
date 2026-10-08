import { z } from 'zod';
import { PROJECT_TYPES, ENVIRONMENT_KINDS, DESTRUCTIVE_POLICIES, TEST_DATA_POLICIES, SEVERITIES, PRIORITIES, SUITE_KINDS, BROWSERS, DEFECT_STATUSES, MANUAL_CATEGORIES, MANUAL_RESULTS } from './enums.js';
import { ROLES } from './rbac.js';
import { StepsSchema } from './steps.js';
import { BugReportContentSchema, RedactionDecisionSchema } from './bugreport/types.js';

export const Slug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);
export const Email = z.string().email().max(254);
export const Password = z.string().min(10).max(200);

export const ViewportSchema = z.object({ width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000), deviceScaleFactor: z.number().min(1).max(4).optional(), isMobile: z.boolean().optional(), hasTouch: z.boolean().optional(), name: z.string().max(60).optional(), device: z.string().max(60).optional() });
export type Viewport = z.infer<typeof ViewportSchema>;
export const MatrixSchema = z.object({ browsers: z.array(z.enum(BROWSERS)).min(1), viewports: z.array(ViewportSchema).min(1), retries: z.number().int().min(0).max(3).default(1), video: z.enum(['off', 'on_failure', 'on_retry', 'always']).default('on_failure'), trace: z.enum(['off', 'on_failure', 'always']).default('on_failure') });
export type Matrix = z.infer<typeof MatrixSchema>;
export const DEFAULT_MATRIX: Matrix = { browsers: ['chromium'], viewports: [{ width: 1280, height: 800, name: 'desktop' }], retries: 1, video: 'on_failure', trace: 'on_failure' };

export const SignupSchema = z.object({ email: Email, password: Password, name: z.string().min(1).max(100), organizationName: z.string().min(1).max(100) });
export const LoginSchema = z.object({ email: Email, password: z.string().min(1).max(200) });

export const WorkspaceCreate = z.object({ name: z.string().min(1).max(100), slug: Slug.optional(), description: z.string().max(2000).optional() });
export const ProjectCreate = z.object({
  workspaceId: z.string().optional(), name: z.string().min(1).max(120), slug: Slug.optional(), description: z.string().max(4000).optional(),
  type: z.enum(PROJECT_TYPES).default('web_app'), repositoryUrl: z.string().url().max(500).optional().or(z.literal('')), timezone: z.string().max(60).default('UTC'),
  ownerUserIds: z.array(z.string()).max(20).optional(), tags: z.array(z.string().max(40)).max(30).optional(),
});
export const ProjectUpdate = ProjectCreate.partial().extend({ defaultEnvironmentId: z.string().optional(), settings: z.record(z.string(), z.unknown()).optional() });

export const AuthProfileSchema = z.object({
  kind: z.enum(['none', 'password_form', 'storage_state', 'basic', 'bearer', 'magic_link_test_mode']).default('none'),
  loginUrl: z.string().max(2000).optional(),
  usernameTarget: z.record(z.string(), z.unknown()).optional(), passwordTarget: z.record(z.string(), z.unknown()).optional(), submitTarget: z.record(z.string(), z.unknown()).optional(),
  usernameSecretRef: z.string().max(100).optional(), passwordSecretRef: z.string().max(100).optional(), tokenSecretRef: z.string().max(100).optional(),
  successUrlContains: z.string().max(500).optional(),
  storageStateSecretRef: z.string().max(100).optional(),
});
export const EnvironmentCreate = z.object({
  name: z.string().min(1).max(100), kind: z.enum(ENVIRONMENT_KINDS), baseUrl: z.string().url().max(2000), apiBaseUrl: z.string().url().max(2000).optional().or(z.literal('')),
  destructivePolicy: z.enum(DESTRUCTIVE_POLICIES).optional(), testDataPolicy: z.enum(TEST_DATA_POLICIES).default('fixture'),
  authProfile: AuthProfileSchema.optional(), allowPrivateNetwork: z.boolean().optional(), allowedHosts: z.array(z.string().max(253)).max(50).optional(),
  maskSelectors: z.array(z.string().max(300)).max(50).optional(), redactHeaders: z.array(z.string().max(100)).max(50).optional(), captureBodies: z.boolean().optional(),
  consoleIgnorePatterns: z.array(z.string().max(300)).max(100).optional(), networkIgnorePatterns: z.array(z.string().max(300)).max(100).optional(),
});
export const EnvironmentUpdate = EnvironmentCreate.partial();

export const SecretCreate = z.object({ name: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/), value: z.string().min(1).max(20_000), environmentId: z.string().optional(), description: z.string().max(500).optional() });

export const MemberInvite = z.object({ email: Email, role: z.enum(ROLES), name: z.string().max(100).optional(), temporaryPassword: Password.optional() });
export const MemberRoleUpdate = z.object({ role: z.enum(ROLES) });
export const TokenCreate = z.object({ name: z.string().min(1).max(100), kind: z.enum(['personal', 'service', 'runner', 'mcp']).default('personal'), role: z.enum(ROLES).optional(), expiresInDays: z.number().int().min(1).max(3650).optional(), projectIds: z.array(z.string()).max(100).optional() });

export const RequirementCreate = z.object({ title: z.string().min(1).max(300), description: z.string().max(10_000).optional(), priority: z.enum(PRIORITIES).default('p2'), source: z.string().max(300).optional(), ownerUserId: z.string().optional(), status: z.enum(['draft', 'approved', 'implemented', 'verified', 'deprecated']).default('draft'), acceptanceCriteria: z.array(z.object({ format: z.enum(['gwt', 'text']).default('gwt'), given: z.string().max(2000).optional(), when: z.string().max(2000).optional(), then: z.string().max(2000).optional(), text: z.string().max(4000).optional() })).max(50).optional() });
export const RequirementUpdate = RequirementCreate.partial();

export const ScenarioCreate = z.object({
  title: z.string().min(1).max(300), description: z.string().max(5000).optional(), preconditions: z.string().max(5000).optional(), steps: StepsSchema, expected: z.string().max(5000).optional(),
  priority: z.enum(PRIORITIES).default('p2'), tags: z.array(z.string().max(40)).max(30).optional(), browsers: z.array(z.enum(BROWSERS)).optional(), dataProfileId: z.string().optional(),
  requirementIds: z.array(z.string()).max(50).optional(), destructive: z.boolean().optional(), status: z.enum(['draft', 'active', 'archived']).default('active'), origin: z.enum(['manual', 'ai_draft', 'import', 'crawl']).optional(), changeReason: z.string().max(500).optional(),
});
export const ScenarioUpdate = ScenarioCreate.partial();

export const SuiteCreate = z.object({ name: z.string().min(1).max(120), kind: z.enum(SUITE_KINDS).default('custom'), description: z.string().max(2000).optional(), matrix: MatrixSchema.optional(), scenarioIds: z.array(z.string()).max(2000).optional(), requiredForRelease: z.boolean().optional() });
export const SuiteUpdate = SuiteCreate.partial();

export const RunCreate = z.object({
  environmentId: z.string(), suiteId: z.string().optional(), scenarioIds: z.array(z.string()).max(2000).optional(), matrix: MatrixSchema.partial().optional(),
  commitSha: z.string().max(64).optional(), branch: z.string().max(200).optional(), prNumber: z.number().int().optional(), buildId: z.string().max(100).optional(),
  trigger: z.enum(['manual', 'schedule', 'ci', 'mcp', 'api', 'retest', 'agent']).default('manual'), priority: z.number().int().min(0).max(9).optional(), releaseCandidateId: z.string().optional(),
  allowDestructive: z.boolean().optional(), idempotencyKey: z.string().max(120).optional(), retestDefectId: z.string().optional(), parentRunId: z.string().optional(), label: z.string().max(200).optional(),
  changedFiles: z.array(z.string().max(500)).max(500).optional(),
});

export const DefectCreate = z.object({ title: z.string().min(1).max(300), severity: z.enum(SEVERITIES).default('medium'), priority: z.enum(PRIORITIES).default('p2'), environmentId: z.string().optional(), browser: z.string().max(40).optional(), viewport: ViewportSchema.optional(), reproduction: z.string().max(10_000).optional(), expected: z.string().max(5000).optional(), actual: z.string().max(5000).optional(), resultIds: z.array(z.string()).max(50).optional(), scenarioIds: z.array(z.string()).max(50).optional(), requirementIds: z.array(z.string()).max(50).optional(), artifactIds: z.array(z.string()).max(100).optional(), failureGroupId: z.string().optional(), assigneeUserId: z.string().optional(), fixVersion: z.string().max(60).optional(), fromAiSuggestionId: z.string().optional() });
export const DefectUpdate = DefectCreate.partial().extend({ status: z.enum(DEFECT_STATUSES).optional(), note: z.string().max(2000).optional(), resolution: z.string().max(2000).optional() });

export const GateRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('suite_pass_rate'), suiteId: z.string(), minRate: z.number().min(0).max(1).default(1), treatFlakyAsFail: z.boolean().default(true) }),
  z.object({ type: z.literal('open_defects_max'), severity: z.enum(SEVERITIES), max: z.number().int().min(0).default(0), allowAcceptedRisk: z.boolean().default(false) }),
  z.object({ type: z.literal('visual_approved') }),
  z.object({ type: z.literal('manual_check_required'), category: z.enum(MANUAL_CATEGORIES).optional(), label: z.string().max(100), device: z.string().max(100).optional() }),
  z.object({ type: z.literal('accessibility_max'), impact: z.enum(['critical', 'serious', 'moderate', 'minor']), max: z.number().int().min(0).default(0) }),
  z.object({ type: z.literal('no_infra_errors') }),
]);
export const RCCreate = z.object({ version: z.string().min(1).max(60), commitSha: z.string().max(64).optional(), buildId: z.string().max(100).optional(), environmentId: z.string(), includedChanges: z.string().max(10_000).optional(), requiredSuiteIds: z.array(z.string()).max(50).optional(), gateRules: z.array(GateRuleSchema).max(50).optional(), requiredManualChecks: z.array(z.string().max(100)).max(50).optional() });
export const RCUpdate = RCCreate.partial();
export const AcceptedRiskCreate = z.object({ defectId: z.string(), reason: z.string().min(5).max(4000), reviewDate: z.string().max(40), impact: z.string().min(1).max(2000) });

export const ManualCaseCreate = z.object({ title: z.string().min(1).max(300), category: z.enum(MANUAL_CATEGORIES).default('other'), description: z.string().max(5000).optional(), steps: z.string().max(10_000).optional(), expected: z.string().max(5000).optional(), requirementIds: z.array(z.string()).max(50).optional(), label: z.string().max(100).optional() });
export const ManualCheckCreate = z.object({ manualCaseId: z.string().optional(), releaseCandidateId: z.string().optional(), runId: z.string().optional(), label: z.string().max(100).optional(), device: z.string().min(1).max(100), osVersion: z.string().max(60).optional(), browser: z.string().max(60).optional(), performedAt: z.string().max(40).optional(), result: z.enum(MANUAL_RESULTS), notes: z.string().max(10_000).optional(), artifactIds: z.array(z.string()).max(50).optional(), defectId: z.string().optional() });

export const ExploratoryCreate = z.object({ environmentId: z.string().optional(), charter: z.string().min(1).max(2000), startedAt: z.string().max(40).optional(), endedAt: z.string().max(40).optional(), durationMin: z.number().int().min(0).max(10_000).optional(), notes: z.string().max(50_000).optional(), artifactIds: z.array(z.string()).max(100).optional(), defectIds: z.array(z.string()).max(100).optional() });
export const ExploratoryUpdate = ExploratoryCreate.partial().extend({ status: z.enum(['open', 'closed']).optional() });

export const ScheduleCreate = z.object({ suiteId: z.string(), environmentId: z.string(), cron: z.string().min(9).max(100), timezone: z.string().max(60).default('UTC'), enabled: z.boolean().default(true), priority: z.number().int().min(0).max(9).default(3), overlapPolicy: z.enum(['skip', 'queue']).default('skip'), label: z.string().max(100).optional() });
export const ScheduleUpdate = ScheduleCreate.partial();

export const DomainVerifyCreate = z.object({ hostname: z.string().min(1).max(253), method: z.enum(['dns_txt', 'html_token', 'well_known', 'manual']) });

export const AiDraftRequest = z.object({ prompt: z.string().min(3).max(4000), requirementId: z.string().optional(), targetUrl: z.string().max(2000).optional(), count: z.number().int().min(1).max(12).default(6) });

// ---------------- ProofFlow 不具合報告 (merged from ErrorRelay) ----------------
export const RedactionDecisions = z.record(z.string().max(40), RedactionDecisionSchema);
/** Body of POST /bug-reports (internal) and POST /intake/:id/bug-reports (external). Severity / priority / target defect are ignored for external intake. */
export const BugReportSubmit = BugReportContentSchema.extend({
  idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  attachmentIds: z.array(z.string().max(40)).max(10).default([]),
  decisions: RedactionDecisions.default({}),
  releaseCandidateId: z.string().max(40).optional(),
  environmentId: z.string().max(40).optional(),
  severity: z.enum(SEVERITIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  existingDefectId: z.string().max(40).optional(),
});
export const BugReportPreview = BugReportContentSchema.extend({ decisions: RedactionDecisions.default({}) });
export const BugIntakeCreate = z.object({
  name: z.string().trim().min(1).max(100),
  defaultSeverity: z.enum(SEVERITIES).default('medium'),
  defaultPriority: z.enum(PRIORITIES).default('p2'),
  releaseCandidateId: z.string().max(40).optional(),
  environmentId: z.string().max(40).optional(),
  maxPerHour: z.number().int().min(1).max(1000).default(30),
});
