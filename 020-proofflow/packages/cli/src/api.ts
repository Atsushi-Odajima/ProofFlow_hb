/** Minimal REST client shared by the CLI and the MCP plugin. The token is never logged. */
export class ProofFlowApi {
  constructor(private baseUrl: string, private token: string, private fetchImpl: typeof fetch = fetch) { this.baseUrl = baseUrl.replace(/\/$/, ''); }
  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: { data?: T; error?: { code: string; message: string; details?: unknown } } = {};
    try { json = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok) throw new ApiError(res.status, json.error?.code ?? 'http_error', json.error?.message ?? text.slice(0, 200), json.error?.details);
    return json.data as T;
  }
  get<T = unknown>(path: string) { return this.call<T>('GET', path); }
  post<T = unknown>(path: string, body?: unknown) { return this.call<T>('POST', path, body ?? {}); }
  async raw(path: string): Promise<{ status: number; contentType: string; body: Buffer }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { authorization: `Bearer ${this.token}` } });
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: Buffer.from(await res.arrayBuffer()) };
  }
  async me() { return this.get<{ actor: { kind: string; id: string; name: string }; organizations: Array<{ id: string; name?: string; slug?: string; role: string }> }>('/api/v1/auth/me'); }
  /** Resolve a project by id or slug across the token's organizations. */
  async resolveProject(ref: string) {
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ref)) return this.get<{ id: string; name: string; slug: string; environments: Array<{ id: string; name: string; kind: string }> }>(`/api/v1/projects/${ref}`);
    const me = await this.me();
    for (const org of me.organizations) { try { const p = await this.get<{ id: string }>(`/api/v1/orgs/${org.id}/projects/by-slug/${encodeURIComponent(ref)}`); return this.get<{ id: string; name: string; slug: string; environments: Array<{ id: string; name: string; kind: string }> }>(`/api/v1/projects/${p.id}`); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; } }
    throw new ApiError(404, 'not_found', `project "${ref}" not found (use id or slug)`);
  }
  async resolveEnvironment(projectId: string, ref: string | undefined, envs: Array<{ id: string; name: string; kind: string }>, defaultEnvironmentId?: string | null) {
    if (!ref) { const d = envs.find((e) => e.id === defaultEnvironmentId) ?? envs[0]; if (!d) throw new ApiError(400, 'no_environment', 'project has no environment'); return d; }
    const e = envs.find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase() || x.kind === ref.toLowerCase());
    if (!e) throw new ApiError(404, 'not_found', `environment "${ref}" not found in project ${projectId}`);
    return e;
  }
  async resolveSuite(projectId: string, ref: string) {
    const suites = await this.get<Array<{ id: string; name: string; kind: string; scenarioIds: string[] }>>(`/api/v1/projects/${projectId}/suites`);
    const s = suites.find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase() || x.kind === ref.toLowerCase());
    if (!s) throw new ApiError(404, 'not_found', `suite "${ref}" not found (available: ${suites.map((x) => x.name).join(', ') || 'none'})`);
    return s;
  }
  async waitForRun(runId: string, opts: { timeoutMs?: number; intervalMs?: number; onTick?: (run: RunSummary) => void } = {}): Promise<RunSummary> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
    for (;;) {
      const run = await this.get<RunSummary>(`/api/v1/runs/${runId}`);
      opts.onTick?.(run);
      if (!['queued', 'running'].includes(run.status)) return run;
      if (Date.now() > deadline) throw new ApiError(408, 'timeout', `run ${runId} did not finish within the timeout`);
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 3000));
    }
  }
}
export interface RunSummary { id: string; status: string; counts: Record<string, number>; results: Array<{ id: string; scenarioId: string; browser: string; status: string; outcomeDetail: string; failure: { type: string; message: string } | null; scenario: { key: string; title: string } | null; viewport: { width: number; height: number; name?: string }; artifacts: Array<{ id: string; kind: string; label: string | null }> }>; }
export class ApiError extends Error { constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); } }
