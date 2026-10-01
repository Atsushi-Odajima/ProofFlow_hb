export const PROJECT_TYPES = ['website', 'web_app', 'pwa', 'api', 'mixed'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const ENVIRONMENT_KINDS = ['local', 'preview', 'staging', 'production'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export const DESTRUCTIVE_POLICIES = ['deny', 'allow'] as const;
export const TEST_DATA_POLICIES = ['fixture', 'generated', 'seeded', 'disposable'] as const;

export const RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'flaky', 'cancelled', 'infra_error'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RESULT_STATUSES = ['queued', 'running', 'passed', 'failed', 'flaky', 'skipped', 'cancelled', 'infra_error'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const OUTCOME_DETAILS = ['passed_first_try', 'passed_after_retry', 'failed_after_retries', 'failed_first_try', 'infra_error', 'not_run'] as const;
export type OutcomeDetail = (typeof OUTCOME_DETAILS)[number];

export const JOB_STATUSES = ['queued', 'leased', 'running', 'done', 'failed', 'cancelled', 'infra_error'] as const;

export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserName = (typeof BROWSERS)[number];

export const ARTIFACT_KINDS = ['screenshot', 'video', 'trace', 'console', 'network', 'dom', 'diff', 'baseline', 'report', 'har', 'download', 'manual_evidence', 'exploratory', 'backup', 'other'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const RETENTION_CLASSES = ['passed', 'failed', 'release_evidence', 'baseline', 'manual'] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const DEFECT_STATUSES = ['new', 'triaged', 'in_progress', 'ready_for_retest', 'verified', 'reopened', 'closed', 'wont_fix'] as const;
export type DefectStatus = (typeof DEFECT_STATUSES)[number];
export const DEFECT_TRANSITIONS: Record<DefectStatus, DefectStatus[]> = {
  new: ['triaged', 'in_progress', 'ready_for_retest', 'closed', 'wont_fix'],
  triaged: ['in_progress', 'ready_for_retest', 'closed', 'wont_fix'],
  in_progress: ['ready_for_retest', 'triaged', 'wont_fix'],
  ready_for_retest: ['verified', 'reopened', 'in_progress'],
  verified: ['closed', 'reopened'],
  reopened: ['triaged', 'in_progress', 'ready_for_retest', 'wont_fix'],
  closed: ['reopened'],
  wont_fix: ['reopened'],
};
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;

export const SUITE_KINDS = ['smoke', 'critical', 'full_regression', 'visual', 'accessibility', 'api', 'mobile', 'custom'] as const;
export const RC_STATUSES = ['draft', 'evaluating', 'ready', 'blocked', 'ready_with_accepted_risk', 'released', 'abandoned'] as const;
export const GATE_RESULTS = ['READY', 'BLOCKED', 'READY_WITH_ACCEPTED_RISK'] as const;
export type GateResult = (typeof GATE_RESULTS)[number];

export const FAILURE_TYPES = ['assertion', 'navigation', 'timeout', 'locator_not_found', 'network', 'console', 'visual', 'responsive', 'accessibility', 'api_contract', 'api_status', 'link', 'form', 'upload', 'download', 'performance', 'script_error', 'infra', 'policy', 'unknown'] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];

export const MANUAL_CATEGORIES = ['device', 'bluetooth', 'camera', 'push_notification', 'native_share', 'payment_sandbox', 'email_delivery', 'visual_judgment', 'accessibility_manual', 'other'] as const;
export const MANUAL_RESULTS = ['pass', 'fail', 'blocked', 'not_run'] as const;

export const AI_FEATURES = ['scenario_draft', 'failure_summary', 'defect_draft', 'selector_repair', 'test_gap', 'exploratory_notes'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
export const AI_SUGGESTION_STATUSES = ['proposed', 'applied', 'rejected'] as const;
export const ROOT_CAUSE_CONFIDENCE = ['confirmed', 'evidence_suggests', 'possible', 'unknown'] as const;

export const TOKEN_KINDS = ['personal', 'service', 'runner', 'mcp'] as const;
export const DOMAIN_VERIFY_METHODS = ['dns_txt', 'html_token', 'well_known', 'manual'] as const;
