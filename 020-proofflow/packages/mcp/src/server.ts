import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProofFlowApi, ApiError } from '@proofflow/cli/api';
import { StepsSchema } from '@proofflow/shared';

export const TOOL_NAMES = ['create_project', 'analyze_test_target', 'draft_acceptance_tests', 'create_test_scenario', 'run_test_suite', 'get_test_run', 'summarize_failures', 'create_defect_from_failure', 'retest_defect', 'get_release_gate', 'prepare_release_evidence', 'submit_bug_report'] as const;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const okResult = (data: Record<string, unknown>, text?: string): ToolResult => ({ content: [{ type: 'text', text: text ?? JSON.stringify(data, null, 2) }], structuredContent: data });
const errResult = (e: unknown): ToolResult => { const msg = e instanceof ApiError ? `ProofFlow API ${e.status} ${e.code}: ${e.message}${e.details ? ' ' + JSON.stringify(e.details) : ''}` : e instanceof Error ? e.message : String(e); return { content: [{ type: 'text', text: msg }], isError: true }; };

/**
 * ProofFlow MCP tool surface (ChatGPT / Codex / Claude Code). The server is a thin client of the REST API:
 * every call is authorized by the control plane with the caller's ProofFlow token, so a plugin can only reach
 * projects that token is allowed to see. It never tests third-party URLs: only registered environments are runnable.
 */
export function buildMcpServer(api: ProofFlowApi): McpServer {
  const server = new McpServer({ name: 'proofflow', version: '0.1.0' }, { instructions: 'ProofFlow runs real-browser acceptance tests against environments registered in a ProofFlow project and returns evidence-backed results. Use analyze_test_target before run_test_suite. Destructive scenarios on production require explicit confirmation. Release gates and approvals are decided by humans; this tool only reports.' });

  server.registerTool('create_project', { title: 'Create ProofFlow project', description: 'Create a project (and optionally its first environment) in the organization of the current token.', inputSchema: { name: z.string().min(1).max(120), type: z.enum(['website', 'web_app', 'pwa', 'api', 'mixed']).default('web_app'), baseUrl: z.string().url().optional(), environmentName: z.string().max(100).optional(), environmentKind: z.enum(['local', 'preview', 'staging', 'production']).default('staging') }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, async (args) => {
    try {
      const me = await api.me(); const org = me.organizations[0]; if (!org) throw new Error('token has no organization');
      const project = await api.post<{ id: string; slug: string }>(`/api/v1/orgs/${org.id}/projects`, { name: args.name, type: args.type });
      let environment: unknown = null;
      if (args.baseUrl) environment = await api.post(`/api/v1/projects/${project.id}/environments`, { name: args.environmentName ?? args.environmentKind, kind: args.environmentKind, baseUrl: args.baseUrl });
      return okResult({ projectId: project.id, slug: project.slug, environment });
    } catch (e) { return errResult(e); }
  });

  server.registerTool('analyze_test_target', { title: 'Analyze test target', description: 'Describe a registered environment: policy (kind, destructive policy, domain verification), available suites and scenarios, latest crawl inventory. Does not crawl arbitrary URLs.', inputSchema: { project: z.string().describe('project id or slug'), environment: z.string().optional().describe('environment id, name or kind') }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (args) => {
    try {
      const project = await api.resolveProject(args.project);
      const env = await api.resolveEnvironment(project.id, args.environment, project.environments, (project as { defaultEnvironmentId?: string }).defaultEnvironmentId);
      const envFull = (await api.get<Array<Record<string, unknown>>>(`/api/v1/projects/${project.id}/environments`)).find((e) => e.id === env.id) ?? {};
      const suites = await api.get<Array<{ id: string; name: string; kind: string; scenarioIds: string[]; requiredForRelease: boolean }>>(`/api/v1/projects/${project.id}/suites`);
      const scenarios = await api.get<Array<{ id: string; key: string; title: string; destructive: boolean; priority: string }>>(`/api/v1/projects/${project.id}/scenarios`);
      const inventory = await api.get<Array<{ url: string; kind: string; status_code: number }>>(`/api/v1/projects/${project.id}/environments/${env.id}/inventory`).catch(() => []);
      const destructive = scenarios.filter((s) => s.destructive).map((s) => s.key);
      return okResult({ project: { id: project.id, name: project.name, slug: project.slug }, environment: { id: env.id, name: env.name, kind: env.kind, baseUrl: envFull.baseUrl, destructivePolicy: envFull.destructivePolicy, domainVerified: envFull.domainVerified, allowPrivateNetwork: envFull.allowPrivateNetwork }, suites: suites.map((s) => ({ id: s.id, name: s.name, kind: s.kind, scenarios: s.scenarioIds.length, requiredForRelease: s.requiredForRelease })), scenarioCount: scenarios.length, destructiveScenarios: destructive, inventory: { pages: inventory.length, sample: inventory.slice(0, 20) }, warnings: [...(env.kind === 'production' ? ['production environment: destructive scenarios are refused unless the environment policy allows them and the caller confirms'] : []), ...(!envFull.domainVerified && env.kind !== 'local' ? ['domain not verified: runs are limited (low-load mode)'] : [])] });
    } catch (e) { return errResult(e); }
  });

  server.registerTool('draft_acceptance_tests', { title: 'Draft acceptance tests (AI)', description: 'Ask ProofFlow AI to draft scenarios from a requirement or a free-text request. Drafts are suggestions; apply them with create_test_scenario or in the UI. Requires AI to be enabled for the organization.', inputSchema: { project: z.string(), prompt: z.string().min(3).max(4000), requirementId: z.string().optional(), count: z.number().int().min(1).max(12).default(6) }, annotations: { readOnlyHint: false, openWorldHint: false } }, async (args) => {
    try { const project = await api.resolveProject(args.project); const s = await api.post<{ id: string; output: unknown }>(`/api/v1/projects/${project.id}/ai/scenario-draft`, { prompt: args.prompt, requirementId: args.requirementId, count: args.count }); return okResult({ suggestionId: s.id, drafts: s.output, note: 'Review the drafts; Expected values marked unspecified must be filled by a human. Apply via POST /ai/suggestions/:id/apply or create_test_scenario.' }); } catch (e) { return errResult(e); }
  });

  server.registerTool('create_test_scenario', { title: 'Create test scenario', description: 'Create a no-code scenario from typed steps (navigate/click/fill/assert_* ...). Arbitrary JavaScript is not accepted.', inputSchema: { project: z.string(), title: z.string().min(1).max(300), steps: z.array(z.record(z.string(), z.unknown())).min(1).max(300), expected: z.string().max(5000).optional(), priority: z.enum(['p0', 'p1', 'p2', 'p3']).default('p2'), tags: z.array(z.string()).max(30).optional(), requirementIds: z.array(z.string()).max(50).optional(), suiteName: z.string().optional().describe('add to this suite (created if missing)') }, annotations: { readOnlyHint: false, openWorldHint: false } }, async (args) => {
    try {
      const parsed = StepsSchema.safeParse(args.steps); if (!parsed.success) return { content: [{ type: 'text', text: 'invalid steps: ' + parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }], isError: true };
      const project = await api.resolveProject(args.project);
      const sc = await api.post<{ id: string; key: string }>(`/api/v1/projects/${project.id}/scenarios`, { title: args.title, steps: parsed.data, expected: args.expected, priority: args.priority, tags: args.tags, requirementIds: args.requirementIds, origin: 'ai_draft' });
      let suite: unknown = null;
      if (args.suiteName) { const suites = await api.get<Array<{ id: string; name: string; scenarioIds: string[] }>>(`/api/v1/projects/${project.id}/suites`); const ex = suites.find((s) => s.name.toLowerCase() === args.suiteName!.toLowerCase()); suite = ex ? await api.call('PATCH', `/api/v1/projects/${project.id}/suites/${ex.id}`, { scenarioIds: [...ex.scenarioIds, sc.id] }) : await api.post(`/api/v1/projects/${project.id}/suites`, { name: args.suiteName, kind: 'custom', scenarioIds: [sc.id] }); }
      return okResult({ scenarioId: sc.id, key: sc.key, suite });
    } catch (e) { return errResult(e); }
  });

  server.registerTool('run_test_suite', { title: 'Run test suite', description: 'Queue a run of a suite (or scenarios) against a registered environment. Refuses destructive scenarios on production unless confirmDestructive=true and the environment policy allows it. With wait=true, polls until the run finishes (max 20 min).', inputSchema: { project: z.string(), suite: z.string().optional().describe('suite id, name or kind (smoke/critical/...)'), scenarioIds: z.array(z.string()).max(500).optional(), environment: z.string().optional(), releaseVersion: z.string().optional().describe('attach the run to this release candidate'), commitSha: z.string().max(64).optional(), branch: z.string().max(200).optional(), confirmDestructive: z.boolean().default(false), wait: z.boolean().default(true) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, async (args) => {
    try {
      const project = await api.resolveProject(args.project);
      const env = await api.resolveEnvironment(project.id, args.environment, project.environments, (project as { defaultEnvironmentId?: string }).defaultEnvironmentId);
      const suite = args.suite ? await api.resolveSuite(project.id, args.suite) : undefined;
      if (!suite && !args.scenarioIds?.length) throw new Error('suite or scenarioIds required');
      const ids = suite ? suite.scenarioIds : args.scenarioIds!;
      const scenarios = await api.get<Array<{ id: string; key: string; destructive: boolean }>>(`/api/v1/projects/${project.id}/scenarios`);
      const destructive = scenarios.filter((s) => ids.includes(s.id) && s.destructive);
      if (destructive.length && env.kind === 'production' && !args.confirmDestructive) return { content: [{ type: 'text', text: `Refused: ${destructive.length} destructive scenario(s) (${destructive.map((s) => s.key).join(', ')}) on PRODUCTION environment "${env.name}". Ask the user for explicit confirmation and call again with confirmDestructive=true (the environment policy must also allow it).` }], isError: true };
      let releaseCandidateId: string | undefined;
      if (args.releaseVersion) { const rcs = await api.get<Array<{ id: string; version: string }>>(`/api/v1/projects/${project.id}/releases`); releaseCandidateId = rcs.find((r) => r.version === args.releaseVersion)?.id; if (!releaseCandidateId) throw new Error(`release candidate ${args.releaseVersion} not found`); }
      const run = await api.post<{ id: string; status: string }>(`/api/v1/projects/${project.id}/runs`, { environmentId: env.id, suiteId: suite?.id, scenarioIds: suite ? undefined : args.scenarioIds, trigger: 'mcp', releaseCandidateId, commitSha: args.commitSha, branch: args.branch, allowDestructive: args.confirmDestructive && destructive.length > 0 });
      if (!args.wait) return okResult({ runId: run.id, status: run.status, destructiveScenarios: destructive.map((s) => s.key) });
      const final = await api.waitForRun(run.id, { timeoutMs: 20 * 60_000, intervalMs: 2000 });
      return okResult(summarizeRun(final));
    } catch (e) { return errResult(e); }
  });

  server.registerTool('get_test_run', { title: 'Get test run', description: 'Status, counts and per-result failures with evidence artifact ids.', inputSchema: { runId: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (args) => { try { return okResult(summarizeRun(await api.get(`/api/v1/runs/${args.runId}`))); } catch (e) { return errResult(e); } });

  server.registerTool('summarize_failures', { title: 'Summarize failures', description: 'Evidence-based failure summary of a run (grouped by failure type/step). With useAi=true also requests ProofFlow AI summaries for up to 5 failed results (AI never changes results).', inputSchema: { runId: z.string(), useAi: z.boolean().default(false) }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (args) => {
    try {
      const run = await api.get<import('@proofflow/cli/api').RunSummary>(`/api/v1/runs/${args.runId}`);
      const failed = run.results.filter((r) => r.status !== 'passed');
      const groups = new Map<string, { type: string; step?: string; count: number; samples: string[]; resultIds: string[] }>();
      for (const r of failed) { const k = `${r.failure?.type ?? r.status}|${(r.failure as { stepType?: string } | null)?.stepType ?? ''}`; const g = groups.get(k) ?? { type: r.failure?.type ?? r.status, step: (r.failure as { stepType?: string } | null)?.stepType, count: 0, samples: [], resultIds: [] }; g.count++; g.resultIds.push(r.id); if (g.samples.length < 3) g.samples.push(`${r.scenario?.key ?? ''} [${r.browser}] ${r.failure?.message ?? ''}`); groups.set(k, g); }
      const ai: unknown[] = [];
      if (args.useAi) for (const r of failed.slice(0, 5)) { try { ai.push({ resultId: r.id, summary: (await api.post<{ output: unknown }>(`/api/v1/results/${r.id}/ai/failure-summary`)).output }); } catch (e) { ai.push({ resultId: r.id, error: e instanceof Error ? e.message : String(e) }); } }
      return okResult({ runId: run.id, status: run.status, counts: run.counts, groups: [...groups.values()], aiSummaries: ai, note: 'Root causes are hypotheses with explicit confidence; the test results themselves are unchanged.' });
    } catch (e) { return errResult(e); }
  });

  server.registerTool('submit_bug_report', { title: 'Submit bug report (ProofFlow 不具合報告)', description: 'File an error report (what happened / expected / actual / steps / environment) as a ProofFlow Defect. ProofFlow masks e-mails, phone numbers, keys, tokens, passwords and card numbers before storing. Idempotent per idempotencyKey. Attachments are not supported through this tool (use the web form or the REST API).', inputSchema: { project: z.string(), idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/), title: z.string().min(1).max(300), description: z.string().max(10000).optional(), expected: z.string().max(5000).optional(), actual: z.string().max(5000).optional(), steps: z.array(z.string().max(1000)).max(50).optional(), errorText: z.string().max(20000).optional(), language: z.enum(['ja', 'en']).default('ja'), severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), releaseVersion: z.string().optional() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (args) => {
    try {
      const project = await api.resolveProject(args.project);
      let releaseCandidateId: string | undefined;
      if (args.releaseVersion) { const rcs = await api.get<Array<{ id: string; version: string }>>(`/api/v1/projects/${project.id}/releases`); releaseCandidateId = rcs.find((r) => r.version === args.releaseVersion)?.id; if (!releaseCandidateId) throw new Error(`release ${args.releaseVersion} not found`); }
      const r = await api.post<{ id: string; key: string; defectId: string; replayed: boolean; redaction: unknown; similar: unknown[] }>(`/api/v1/projects/${project.id}/bug-reports`, { idempotencyKey: args.idempotencyKey, title: args.title, description: args.description, expected: args.expected, actual: args.actual, steps: args.steps, errorText: args.errorText, language: args.language, severity: args.severity, releaseCandidateId });
      return okResult({ reportId: r.id, reportKey: r.key, defectId: r.defectId, replayed: r.replayed, redaction: r.redaction, similarOpenDefects: r.similar });
    } catch (e) { return errResult(e); }
  });

  server.registerTool('create_defect_from_failure', { title: 'Create defect from failure', description: 'Create a defect record from a failed result with its evidence attached.', inputSchema: { resultId: z.string(), severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), title: z.string().max(300).optional() }, annotations: { readOnlyHint: false, openWorldHint: false } }, async (args) => {
    try { const r = await api.get<{ projectId?: string; runId: string }>(`/api/v1/results/${args.resultId}`); const run = await api.get<{ projectId: string }>(`/api/v1/runs/${r.runId}`); const d = await api.post<{ id: string; key: string; status: string }>(`/api/v1/projects/${run.projectId}/defects/from-result`, { resultId: args.resultId, severity: args.severity, title: args.title }); return okResult({ defectId: d.id, key: d.key, status: d.status }); } catch (e) { return errResult(e); }
  });

  server.registerTool('retest_defect', { title: 'Retest defect', description: 'Queue a retest run for a defect (its linked scenarios). A passing retest marks the defect Verified; a failing one Reopened.', inputSchema: { project: z.string(), defectId: z.string(), wait: z.boolean().default(true) }, annotations: { readOnlyHint: false, openWorldHint: false } }, async (args) => {
    try { const project = await api.resolveProject(args.project); const run = await api.post<{ id: string }>(`/api/v1/projects/${project.id}/defects/${args.defectId}/retest`, {}); if (!args.wait) return okResult({ runId: run.id }); const final = await api.waitForRun(run.id, { timeoutMs: 20 * 60_000 }); const d = await api.get<{ status: string; key: string }>(`/api/v1/projects/${project.id}/defects/${args.defectId}`); return okResult({ ...summarizeRun(final), defect: { key: d.key, status: d.status } }); } catch (e) { return errResult(e); }
  });

  server.registerTool('get_release_gate', { title: 'Get release gate', description: 'Evaluate the release gate for a version: READY / BLOCKED / READY_WITH_ACCEPTED_RISK with per-rule evidence. The decision to release stays with humans.', inputSchema: { project: z.string(), version: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false } }, async (args) => {
    try { const project = await api.resolveProject(args.project); const rcs = await api.get<Array<{ id: string; version: string; status: string }>>(`/api/v1/projects/${project.id}/releases`); const rc = rcs.find((r) => r.version === args.version); if (!rc) throw new Error(`release candidate ${args.version} not found`); const ev = await api.post<{ result: string; rules: Array<{ pass: boolean; message: string }> }>(`/api/v1/projects/${project.id}/releases/${rc.id}/evaluate`); return okResult({ version: args.version, result: ev.result, rules: ev.rules.map((r) => ({ pass: r.pass, message: r.message })), note: 'ProofFlow does not approve releases. A human with release:approve decides.' }); } catch (e) { return errResult(e); }
  });

  server.registerTool('prepare_release_evidence', { title: 'Prepare release evidence report', description: 'Generate the evidence report (HTML or PDF) for a release candidate and return its artifact id and summary.', inputSchema: { project: z.string(), version: z.string(), format: z.enum(['html', 'pdf']).default('html') }, annotations: { readOnlyHint: false, openWorldHint: false } }, async (args) => {
    try { const project = await api.resolveProject(args.project); const rcs = await api.get<Array<{ id: string; version: string }>>(`/api/v1/projects/${project.id}/releases`); const rc = rcs.find((r) => r.version === args.version); if (!rc) throw new Error(`release candidate ${args.version} not found`); const rep = await api.post<{ id: string; artifactId: string; checksum: string; summary: unknown }>(`/api/v1/projects/${project.id}/releases/${rc.id}/report`, { format: args.format }); return okResult({ reportId: rep.id, artifactId: rep.artifactId, checksum: rep.checksum, summary: rep.summary, downloadPath: `/api/v1/artifacts/${rep.artifactId}/download` }); } catch (e) { return errResult(e); }
  });
  return server;
}

function summarizeRun(run: import('@proofflow/cli/api').RunSummary): Record<string, unknown> {
  return { runId: run.id, status: run.status, counts: run.counts, failures: run.results.filter((r) => r.status !== 'passed').map((r) => ({ resultId: r.id, scenario: r.scenario ? `${r.scenario.key} ${r.scenario.title}` : r.scenarioId, browser: r.browser, viewport: r.viewport.name ?? `${r.viewport.width}x${r.viewport.height}`, status: r.status, outcome: r.outcomeDetail, failure: r.failure, evidence: r.artifacts.map((a) => ({ id: a.id, kind: a.kind, label: a.label })) })) };
}
