import type { JobPayload, FailureInfo, AttemptResult } from './types.js';
import { readFileSync } from 'node:fs';

/** HTTP client for the control plane's runner protocol. */
export class ControlClient {
  constructor(private baseUrl: string, private token: string, public runnerId = '') {}
  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...headers } };
    if (body !== undefined) init.body = body instanceof Uint8Array ? (body as unknown as BodyInit) : JSON.stringify(body);
    const res = await fetch(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    let json: { data?: T; error?: { code: string; message: string } } = {};
    try { json = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok) throw new Error(`control plane ${method} ${path} → ${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? text.slice(0, 200)}`);
    return json.data as T;
  }
  async register(name: string, version: string, capabilities: unknown, allowPrivateNetwork: boolean): Promise<string> {
    const r = await this.call<{ runnerId: string }>('POST', '/runner/v1/register', { name, version, capabilities, allowPrivateNetwork });
    this.runnerId = r.runnerId; return r.runnerId;
  }
  lease(browsers: string[], max: number) { return this.call<{ jobs: JobPayload[] }>('POST', '/runner/v1/lease', { runnerId: this.runnerId, browsers, max }).then((r) => r.jobs); }
  heartbeat(jobId: string, progress?: { stepIndex?: number; message?: string; attempt?: number }) { return this.call<{ cancelled: boolean; leaseUntil: string }>('POST', `/runner/v1/jobs/${jobId}/heartbeat`, { runnerId: this.runnerId, progress }); }
  async uploadArtifact(jobId: string, opts: { kind: string; label?: string; stepIndex?: number; attempt?: number; contentType: string; path?: string; buffer?: Buffer; restricted?: boolean }): Promise<string> {
    const q = new URLSearchParams({ runnerId: this.runnerId, kind: opts.kind });
    if (opts.label) q.set('label', opts.label);
    if (opts.stepIndex !== undefined) q.set('stepIndex', String(opts.stepIndex));
    if (opts.attempt !== undefined) q.set('attempt', String(opts.attempt));
    if (opts.restricted) q.set('restricted', 'true');
    const buf = opts.buffer ?? readFileSync(opts.path!);
    const r = await this.call<{ artifactId: string }>('PUT', `/runner/v1/jobs/${jobId}/artifacts?${q.toString()}`, new Uint8Array(buf), { 'content-type': opts.contentType });
    return r.artifactId;
  }
  complete(jobId: string, result: { status: string; outcomeDetail: string; attempts: number; durationMs: number; startedAt: string; completedAt: string; browserVersion?: string; failure?: FailureInfo | null; steps?: unknown[]; consoleSummary?: unknown; networkSummary?: unknown; metrics?: unknown; checks?: unknown; attemptsDetail?: Pick<AttemptResult, 'attempt' | 'status' | 'durationMs' | 'failure' | 'steps' | 'startedAt' | 'completedAt'>[] }, artifactIds: string[]) {
    return this.call<{ resultId: string }>('POST', `/runner/v1/jobs/${jobId}/complete`, { runnerId: this.runnerId, result, artifactIds });
  }
  fail(jobId: string, error: { message: string; kind: 'infra' | 'policy' }) { return this.call<{ requeued: boolean }>('POST', `/runner/v1/jobs/${jobId}/fail`, { runnerId: this.runnerId, error }); }
  async download(url: string): Promise<Buffer> { const res = await fetch(url); if (!res.ok) throw new Error(`download ${res.status}`); return Buffer.from(await res.arrayBuffer()); }
}
