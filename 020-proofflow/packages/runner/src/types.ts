import type { Step, Viewport } from '@proofflow/shared';

export interface JobPayload {
  jobId: string; runId: string; projectId: string; attempt: number; maxAttempts: number; leaseUntil: string | null;
  scenario: { id: string; key: string; title: string; version: number; steps: Step[]; expected: string | null; destructive: boolean };
  browser: 'chromium' | 'firefox' | 'webkit'; viewport: Viewport;
  environment: { id: string; kind: string; baseUrl: string; apiBaseUrl: string | null; authProfile: Record<string, unknown>; allowPrivateNetwork: boolean; allowedHosts: string[]; privacy: { maskSelectors: string[]; redactHeaders: string[]; captureBodies: boolean }; noise: { consoleIgnorePatterns: string[]; networkIgnorePatterns: string[] } };
  secrets: Record<string, string>; data: Record<string, unknown>; fixtures: { name: string; contentType: string; url: string }[];
  baselines: { stepKey: string; artifactId: string; url: string }[];
  options: { retries: number; video: 'off' | 'on_failure' | 'on_retry' | 'always'; trace: 'off' | 'on_failure' | 'always'; stepTimeoutMs: number; jobTimeoutMs: number };
}
export interface FailureInfo { type: string; message: string; stepIndex?: number; stepType?: string; url?: string; locator?: string; status?: number; ruleId?: string; stack?: string; expected?: string; actual?: string; }
export class StepFailure extends Error { constructor(public info: FailureInfo) { super(info.message); } }
export class InfraError extends Error { constructor(message: string, public kind: 'infra' | 'policy' = 'infra') { super(message); } }
export class CancelledError extends Error { constructor() { super('job cancelled'); } }

export interface StepRecord { index: number; type: string; status: 'passed' | 'failed' | 'skipped'; durationMs: number; message?: string; url?: string; }
export interface ConsoleEntry { t: string; type: string; text: string; url?: string; line?: number; ignored?: boolean; }
export interface NetworkEntry { t: string; method: string; url: string; status?: number; ok?: boolean; failed?: string; durationMs?: number; resourceType?: string; mime?: string; requestHeaders?: Record<string, string>; responseHeaders?: Record<string, string>; sizeBytes?: number; ignored?: boolean; }
export interface AttemptResult { attempt: number; status: 'passed' | 'failed'; durationMs: number; failure: FailureInfo | null; steps: StepRecord[]; startedAt: string; completedAt: string; artifactIds: string[]; consoleSummary: unknown; networkSummary: unknown; metrics: unknown; checks: Record<string, unknown>; browserVersion?: string; }
