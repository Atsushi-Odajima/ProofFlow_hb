// ProofFlow 不具合報告 via MCP: submit_bug_report is a thin REST client call (masking + idempotency are enforced by the server).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestApp, signup, createProject, createToken, type TestApp } from '../helpers/app.js';
import { ProofFlowApi } from '@proofflow/cli/api';
import { buildMcpServer } from '@proofflow/mcp/index';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

describe('MCP submit_bug_report', () => {
  it('files a masked report as a Defect, idempotently, only in projects the token may reach', async () => {
    const s = await signup(t.app, 'mcp@br.example');
    const project = await createProject(t.app, s, 'MCP Shop');
    const other = await createProject(t.app, s, 'Hidden');
    const token = await createToken(t.app, s, { role: 'tester', projectIds: [project.id] });
    // fetch backed by fastify.inject (no listening port needed)
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const r = await t.app.inject({ method: (init?.method ?? 'GET') as 'GET', url: u.pathname + u.search, headers: init?.headers as Record<string, string>, payload: init?.body as string | undefined });
      return new Response(r.body, { status: r.statusCode, headers: { 'content-type': String(r.headers['content-type'] ?? 'application/json') } });
    }) as unknown as typeof fetch;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(new ProofFlowApi('http://proofflow.test', token, fetchImpl));
    await server.connect(st);
    const client = new Client({ name: 'test', version: '0.0.1' });
    await client.connect(ct);
    const args = { project: project.id, idempotencyKey: 'mcp-key-0001', title: 'Crash on save for dev@example.com', actual: 'App crashes; Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', steps: ['Open editor', 'Press save'], language: 'en' };
    const r1 = (await client.callTool({ name: 'submit_bug_report', arguments: args })) as unknown as { structuredContent: { reportKey: string; defectId: string; replayed: boolean } };
    expect(r1.structuredContent.reportKey).toBe('BR-1'); expect(r1.structuredContent.replayed).toBe(false);
    const r2 = (await client.callTool({ name: 'submit_bug_report', arguments: args })) as unknown as { structuredContent: { defectId: string; replayed: boolean } };
    expect(r2.structuredContent.replayed).toBe(true); expect(r2.structuredContent.defectId).toBe(r1.structuredContent.defectId);
    const d = await t.db.get<{ title: string; actual: string }>(`SELECT title, actual FROM defects WHERE id = ?`, [r1.structuredContent.defectId]);
    expect(d!.title).not.toContain('dev@example.com'); expect(d!.actual).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    const denied = (await client.callTool({ name: 'submit_bug_report', arguments: { ...args, project: other.id, idempotencyKey: 'mcp-key-0002' } })) as unknown as { isError: boolean; content: Array<{ text: string }> };
    expect(denied.isError).toBe(true); expect(denied.content[0]!.text).toContain('404');
    await client.close(); await server.close();
  });
});
