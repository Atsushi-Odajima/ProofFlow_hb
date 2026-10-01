import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ProofFlowApi } from '@proofflow/cli/api';
import { buildMcpServer } from './server.js';

export interface McpHttpOptions { controlUrl: string; allowedOrigins?: string[]; allowUrlToken?: boolean; path?: string; }

/**
 * Streamable HTTP endpoint (stateless: one McpServer per request). Auth: `Authorization: Bearer <ProofFlow token>`;
 * optionally `?token=` (for hosts that cannot send headers — lower security, off by default).
 * Origin is validated (DNS-rebinding protection); non-browser clients send no Origin and are accepted.
 */
export function createMcpHttpServer(opts: McpHttpOptions) {
  const path = opts.path ?? '/mcp';
  const allowed = new Set((opts.allowedOrigins ?? []).map((o) => o.toLowerCase()));
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, transport: 'streamable-http' })); }
    if (url.pathname !== path) { res.writeHead(404); return res.end('not found'); }
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin.toLowerCase())) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'origin not allowed' })); }
    const authz = req.headers.authorization;
    let token = authz?.startsWith('Bearer ') ? authz.slice(7).trim() : undefined;
    if (!token && opts.allowUrlToken) token = url.searchParams.get('token') ?? undefined;
    if (!token) { res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="proofflow"' }); return res.end(JSON.stringify({ error: 'ProofFlow API token required (Authorization: Bearer pfm_...)' })); }
    const server = buildMcpServer(new ProofFlowApi(opts.controlUrl, token));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => undefined); server.close().catch(() => undefined); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch (e) { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); } }
  });
}
