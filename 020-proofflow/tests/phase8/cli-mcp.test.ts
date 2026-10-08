import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPipeline, type Pipeline } from '../helpers/pipeline.js';
import { createToken, createProject } from '../helpers/app.js';
import { runCli, EXIT } from '@proofflow/cli/cli';
import { ProofFlowApi } from '@proofflow/cli/api';
import { buildMcpServer, TOOL_NAMES, createMcpHttpServer } from '@proofflow/mcp/index';

let p: Pipeline; let token: string; let suiteId: string; let dir: string;
beforeAll(async () => {
  p = await createPipeline();
  token = await createToken(p.t.app, p.s, { kind: 'service', role: 'qa_lead', name: 'ci' });
  const ok = await p.createScenario({ title: 'Landing loads', steps: [{ type: 'navigate', url: '/' }, { type: 'assert_title', title: 'Sample SaaS' }] });
  const bad = await p.createScenario({ title: 'Login error shown', steps: [{ type: 'navigate', url: '/login' }, { type: 'fill', target: { label: 'Email' }, value: 'x@example.com' }, { type: 'fill', target: { label: 'Password' }, value: 'bad-pass-123' }, { type: 'click', target: { role: 'button', name: 'Log in' } }, { type: 'assert_text', text: 'Invalid email or password' }] });
  suiteId = (await p.createSuite({ name: 'Smoke', kind: 'smoke', scenarioIds: [ok.id, bad.id], requiredForRelease: true })).id;
  dir = mkdtempSync(join(tmpdir(), 'pf-cli-'));
}, 120_000);
afterAll(async () => { await p.close(); });

const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s), env: { PROOFFLOW_URL: p.controlUrl, PROOFFLOW_TOKEN: token, GITHUB_SHA: 'deadbeef', GITHUB_REF: 'refs/pull/12/merge', GITHUB_RUN_ID: '999' } } }; };

describe('Phase 8: CLI', () => {
  it('run --wait returns exit 1 on failure, writes a CI comment file without secrets; status/gate exit codes', async () => {
    const a = io();
    const runP = runCli(['run', '--project', p.project.id, '--suite', 'Smoke', '--wait', '--comment-file', join(dir, 'comment.md'), '--json'], a.io);
    await new Promise((r) => setTimeout(r, 300)); await p.runner.drain();
    const code = await runP;
    expect(code).toBe(EXIT.FAILED);
    const run = JSON.parse(a.out.join(''));
    expect(run.status).toBe('failed');
    expect(run.commitSha).toBe('deadbeef'); expect(run.prNumber).toBe(12); expect(run.buildId).toBe('999');
    const md = readFileSync(join(dir, 'comment.md'), 'utf8');
    expect(md).toContain('ProofFlow run'); expect(md).toContain('FAILED'); expect(md).toContain('Login error shown');
    expect(md).not.toContain(token); expect(a.out.join('') + a.err.join('')).not.toContain(token);
    const b = io(); expect(await runCli(['status', run.id], b.io)).toBe(EXIT.FAILED);
    // gate
    await p.A.post(`/api/v1/projects/${p.project.id}/releases`, { version: '2.0.0', environmentId: p.env.id, requiredManualChecks: [] });
    const c = io(); expect(await runCli(['gate', '--project', p.project.id, '--release', '2.0.0'], c.io)).toBe(EXIT.BLOCKED);
    expect(c.out.join('')).toContain('BLOCKED');
    // fix + run attached to release → passes → gate READY
    await p.setBugs({ loginInvalidErrorMissing: false });
    const d = io();
    const runP2 = runCli(['run', '--project', p.project.id, '--suite', 'smoke', '--release', '2.0.0', '--wait'], d.io);
    await new Promise((r) => setTimeout(r, 300)); await p.runner.drain();
    expect(await runP2).toBe(EXIT.OK);
    const e = io(); expect(await runCli(['gate', '--project', p.project.id, '--release', '2.0.0'], e.io)).toBe(EXIT.OK);
    await p.setBugs({ loginInvalidErrorMissing: true });
    // usage errors
    const f = io(); expect(await runCli(['run'], f.io)).toBe(EXIT.USAGE);
    const g = io(); expect(await runCli(['run', '--project', 'nope-nope', '--suite', 'Smoke'], g.io)).toBe(EXIT.USAGE);
  });
  it('export → import round trip is idempotent and versioned; impact candidates; report download', async () => {
    const a = io(); expect(await runCli(['export', '--project', p.project.id, '--out', join(dir, 'defs.json')], a.io)).toBe(EXIT.OK);
    const doc = JSON.parse(readFileSync(join(dir, 'defs.json'), 'utf8'));
    expect(doc.format).toBe('proofflow-definitions'); expect(doc.scenarios.length).toBe(2); expect(doc.suites[0].scenarioKeys.length).toBe(2);
    expect(JSON.stringify(doc)).not.toContain('demo-pass-123');
    const b = io(); expect(await runCli(['import', '--project', p.project.id, '--file', join(dir, 'defs.json'), '--json'], b.io)).toBe(EXIT.OK);
    expect(JSON.parse(b.out.join('')).scenarios.unchanged).toBe(2);
    doc.scenarios[0].expected = 'changed by agent'; doc.scenarios.push({ key: 'NEW-1', title: 'New from repo', steps: [{ type: 'navigate', url: '/pricing' }], priority: 'p3' });
    const c = io(); expect(await runCli(['import', '--project', p.project.id, '--file', (() => { const f = join(dir, 'defs2.json'); require('node:fs').writeFileSync(f, JSON.stringify(doc)); return f; })(), '--reason', 'agent PR #7', '--json'], c.io)).toBe(EXIT.OK);
    const r = JSON.parse(c.out.join('')); expect(r.scenarios.updated).toBe(1); expect(r.scenarios.created).toBe(1);
    const changed = (await p.A.get(`/api/v1/projects/${p.project.id}/scenarios?q=${encodeURIComponent(doc.scenarios[0].title)}`)).json().data[0];
    expect(changed.version).toBe(2);
    const versions = (await p.A.get(`/api/v1/projects/${p.project.id}/scenarios/${changed.id}/versions`)).json().data;
    expect(versions[0].changeReason).toBe('agent PR #7');
    const d = io(); expect(await runCli(['impact', '--project', p.project.id, '--changed', 'src/pages/login.tsx', 'src/api/auth.ts', '--json'], d.io)).toBe(EXIT.OK);
    const imp = JSON.parse(d.out.join('')); expect(imp.candidates.some((c: { title: string }) => c.title === 'Login error shown')).toBe(true); expect(imp.note).toContain('required');
    const e = io(); expect(await runCli(['report', '--project', p.project.id, '--release', '2.0.0', '--out', join(dir, 'report.html')], e.io)).toBe(EXIT.OK);
    expect(readFileSync(join(dir, 'report.html'), 'utf8')).toContain('Evidence Report');
  });
});

describe('Phase 8: MCP plugin (E2E-6 / 必須テスト35)', () => {
  async function connect(tok: string) {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(new ProofFlowApi(p.controlUrl, tok));
    await server.connect(st);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(ct);
    return { client, server };
  }
  const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');
  it('lists the 12 tools and runs the release-check flow: analyze → run → summarize → gate', async () => {
    const { client, server } = await connect(token);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const an = await client.callTool({ name: 'analyze_test_target', arguments: { project: p.project.id } });
    const anData = (an as unknown as { structuredContent: { suites: Array<{ name: string }>; environment: { kind: string } } }).structuredContent;
    expect(anData.suites.some((s) => s.name === 'Smoke')).toBe(true); expect(anData.environment.kind).toBe('local');
    const runP = client.callTool({ name: 'run_test_suite', arguments: { project: p.project.id, suite: 'Smoke', wait: true } });
    await new Promise((r) => setTimeout(r, 400)); await p.runner.drain();
    const run = (await runP) as unknown as { structuredContent: { runId: string; status: string; failures: Array<{ resultId: string }> } };
    expect(run.structuredContent.status).toBe('failed'); expect(run.structuredContent.failures.length).toBe(1);
    const sum = await client.callTool({ name: 'summarize_failures', arguments: { runId: run.structuredContent.runId } });
    expect((sum as unknown as { structuredContent: { groups: Array<{ type: string }> } }).structuredContent.groups[0]!.type).toBe('assertion');
    const gate = await client.callTool({ name: 'get_release_gate', arguments: { project: p.project.id, version: '2.0.0' } });
    expect((gate as unknown as { structuredContent: { result: string; note: string } }).structuredContent.note).toContain('does not approve');
    const def = await client.callTool({ name: 'create_defect_from_failure', arguments: { resultId: run.structuredContent.failures[0]!.resultId, severity: 'high' } });
    expect((def as unknown as { structuredContent: { key: string } }).structuredContent.key).toMatch(/^DEF-\d+$/);
    const ev = await client.callTool({ name: 'prepare_release_evidence', arguments: { project: p.project.id, version: '2.0.0' } });
    expect((ev as unknown as { structuredContent: { artifactId: string } }).structuredContent.artifactId).toBeTruthy();
    await client.close(); await server.close();
  });
  it('必須テスト35: a plugin token restricted to project A cannot run or read project B; destructive on production needs confirmation', async () => {
    const other = await createProject(p.t.app, p.s, 'Other Project');
    const restricted = await createToken(p.t.app, p.s, { kind: 'mcp', role: 'tester', projectIds: [p.project.id] });
    const { client, server } = await connect(restricted);
    const okRun = await client.callTool({ name: 'analyze_test_target', arguments: { project: p.project.id } });
    expect((okRun as { isError?: boolean }).isError).toBeFalsy();
    const denied = await client.callTool({ name: 'run_test_suite', arguments: { project: other.id, suite: 'Smoke', wait: false } });
    expect((denied as { isError?: boolean }).isError).toBe(true); expect(text(denied)).toMatch(/404|not found/i);
    const denied2 = await client.callTool({ name: 'analyze_test_target', arguments: { project: other.id } });
    expect((denied2 as { isError?: boolean }).isError).toBe(true);
    // production + destructive scenario → refusal without confirmation
    const prod = (await p.A.post(`/api/v1/projects/${p.project.id}/environments`, { name: 'Prod', kind: 'production', baseUrl: 'https://www.example.com' })).json().data;
    const destructive = await p.createScenario({ title: 'Delete via API', steps: [{ type: 'api_request', method: 'DELETE', url: '/api/thing', expectStatus: 204 }] });
    const refused = await client.callTool({ name: 'run_test_suite', arguments: { project: p.project.id, scenarioIds: [destructive.id], environment: prod.id, wait: false } });
    expect((refused as { isError?: boolean }).isError).toBe(true); expect(text(refused)).toContain('confirmDestructive');
    const stillDenied = await client.callTool({ name: 'run_test_suite', arguments: { project: p.project.id, scenarioIds: [destructive.id], environment: prod.id, wait: false, confirmDestructive: true } });
    expect((stillDenied as { isError?: boolean }).isError).toBe(true); expect(text(stillDenied)).toContain('destructive'); // environment policy still denies
    await client.close(); await server.close();
  });
  it('Streamable HTTP transport: bearer auth, origin check', async () => {
    const srv = createMcpHttpServer({ controlUrl: p.controlUrl, allowedOrigins: ['https://chatgpt.com'] });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    const client = new Client({ name: 'http-client', version: '0.0.1' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools(); expect(tools.tools.length).toBe(TOOL_NAMES.length);
    const runs = (await p.A.get(`/api/v1/projects/${p.project.id}/runs?limit=1`)).json().data;
    const r = await client.callTool({ name: 'get_test_run', arguments: { runId: runs[0].id } });
    expect((r as unknown as { structuredContent: { runId: string } }).structuredContent.runId).toBe(runs[0].id);
    await client.close(); await new Promise<void>((r) => srv.close(() => r()));
  });
});
