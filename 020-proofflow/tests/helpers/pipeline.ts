/**
 * Full-pipeline harness: control plane (listening on a real port) + Sample SaaS target + in-process runner (real Chromium).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, signup, api, createProject, type TestApp, type Session } from './app.js';
import { createSampleApp, type BugName } from '@proofflow/sample-saas/server';
import { createRunner } from '@proofflow/runner/index';
import type { Config } from '@proofflow/server/config';

export interface Pipeline {
  t: TestApp; s: Session; project: { id: string }; env: { id: string }; sample: ReturnType<typeof createSampleApp>; sampleUrl: string; controlUrl: string;
  runner: ReturnType<typeof createRunner>; runnerToken: string;
  A: ReturnType<typeof api>;
  createScenario(input: Record<string, unknown>): Promise<{ id: string; key: string }>;
  createSuite(input: Record<string, unknown>): Promise<{ id: string }>;
  runAndWait(input: Record<string, unknown>, opts?: { drains?: number; waitMs?: number }): Promise<RunDetail>;
  getRun(runId: string): Promise<RunDetail>;
  setBugs(bugs: Partial<Record<BugName, boolean>>): Promise<void>;
  close(): Promise<void>;
}
export interface RunDetail { id: string; status: string; counts: Record<string, number>; results: Array<{ id: string; scenarioId: string; browser: string; status: string; outcomeDetail: string; attempts: number; failure: { type: string; message: string; stepIndex?: number; stepType?: string; url?: string } | null; fingerprint: string | null; steps: unknown[]; checks: Record<string, unknown[]> | null; consoleSummary: { errors: number; uncaught: number } | null; networkSummary: { status5xx: number; failed: number } | null; metrics: Record<string, number> | null; artifacts: Array<{ id: string; kind: string; label: string | null; contentType: string; sizeBytes: number; restricted: boolean }>; attemptsDetail: Array<{ attempt: number; status: string; failure: unknown }>; scenario: { key: string; title: string } | null; viewport: { width: number; height: number } }>; jobs: Array<{ id: string; status: string; attempt: number; lastError: string | null }>; }

export async function createPipeline(opts: { overrides?: Partial<Config>; env?: Record<string, string>; bugs?: Partial<Record<BugName, boolean>>; browsers?: string[]; matrix?: Record<string, unknown> } = {}): Promise<Pipeline> {
  const t = await createTestApp(opts.overrides ?? {}, opts.env ?? {});
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (t.app.server.address() as { port: number }).port;
  const controlUrl = `http://127.0.0.1:${port}`;
  t.cfg.publicUrl = controlUrl; // signed URLs must point at the live port
  const sample = createSampleApp({ bugs: opts.bugs });
  const samplePort = await sample.listen(0);
  const sampleUrl = `http://127.0.0.1:${samplePort}`;
  const s = await signup(t.app, 'pipeline@a.example', 'Pipeline Org');
  const A = api(t.app, { cookie: s.cookie });
  const project = await createProject(t.app, s, 'Sample SaaS');
  const envRes = await A.post(`/api/v1/projects/${project.id}/environments`, { name: 'Local', kind: 'local', baseUrl: sampleUrl, allowPrivateNetwork: true, authProfile: { kind: 'password_form', loginUrl: '/login', usernameTarget: { label: 'Email' }, passwordTarget: { label: 'Password' }, submitTarget: { role: 'button', name: 'Log in' }, usernameSecretRef: 'LOGIN_EMAIL', passwordSecretRef: 'LOGIN_PASSWORD', successUrlContains: '/dashboard' } });
  if (envRes.statusCode !== 201) throw new Error('env create failed ' + envRes.body);
  const env = envRes.json().data as { id: string };
  await A.put(`/api/v1/projects/${project.id}/secrets`, { name: 'LOGIN_EMAIL', value: 'demo@example.com' });
  await A.put(`/api/v1/projects/${project.id}/secrets`, { name: 'LOGIN_PASSWORD', value: 'demo-pass-123' });
  const tok = await A.post(`/api/v1/orgs/${s.orgId}/tokens`, { name: 'test-runner', kind: 'runner' });
  if (tok.statusCode !== 201) throw new Error('runner token failed ' + tok.body);
  const runnerToken = tok.json().data.token as string;
  const workDir = mkdtempSync(join(tmpdir(), 'pf-runner-'));
  const runner = createRunner({ controlUrl, token: runnerToken, name: 'vitest-runner', concurrency: 2, browsers: opts.browsers ?? ['chromium'], allowPrivateNetwork: true, workDir, log: () => undefined });
  await runner.register();
  const getRun = async (runId: string) => { const r = await A.get(`/api/v1/runs/${runId}`); if (r.statusCode !== 200) throw new Error('run get failed ' + r.body); return r.json().data as RunDetail; };
  return {
    t, s, project, env, sample, sampleUrl, controlUrl, runner, runnerToken, A,
    async createScenario(input) { const r = await A.post(`/api/v1/projects/${project.id}/scenarios`, { priority: 'p1', ...input }); if (r.statusCode !== 201) throw new Error('scenario create failed ' + r.body); return r.json().data; },
    async createSuite(input) { const r = await A.post(`/api/v1/projects/${project.id}/suites`, { kind: 'custom', ...input }); if (r.statusCode !== 201) throw new Error('suite create failed ' + r.body); return r.json().data; },
    async runAndWait(input, o = {}) {
      const r = await A.post(`/api/v1/projects/${project.id}/runs`, { environmentId: env.id, matrix: opts.matrix ?? { browsers: ['chromium'], viewports: [{ width: 1280, height: 800, name: 'desktop' }], retries: 0, video: 'on_failure', trace: 'on_failure' }, ...input });
      if (r.statusCode !== 202 && r.statusCode !== 200) throw new Error('run create failed ' + r.body);
      const runId = r.json().data.id as string;
      for (let i = 0; i < (o.drains ?? 1); i++) { if (i > 0) await new Promise((res) => setTimeout(res, o.waitMs ?? 5500)); await runner.drain(); }
      return getRun(runId);
    },
    getRun,
    async setBugs(bugs) { await fetch(`${sampleUrl}/__sample/bugs`, { method: 'POST', body: JSON.stringify(bugs) }); },
    async close() { await runner.stop(); await sample.close(); await t.close(); },
  };
}
