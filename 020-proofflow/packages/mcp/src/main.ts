import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ProofFlowApi } from '@proofflow/cli/api';
import { buildMcpServer } from './server.js';
import { createMcpHttpServer } from './http.js';

const mode = process.argv.includes('--http') ? 'http' : 'stdio';
const controlUrl = process.env.PROOFFLOW_URL ?? 'http://localhost:8080';
if (mode === 'stdio') {
  const token = process.env.PROOFFLOW_TOKEN;
  if (!token) { console.error('PROOFFLOW_TOKEN is required'); process.exit(2); }
  const server = buildMcpServer(new ProofFlowApi(controlUrl, token));
  server.connect(new StdioServerTransport()).catch((e) => { console.error(e); process.exit(1); });
  // stdout is reserved for MCP messages; log to stderr only.
  console.error(`[proofflow-mcp] stdio server ready (control plane ${controlUrl})`);
} else {
  const port = Number(process.env.PROOFFLOW_MCP_PORT ?? 8787); const host = process.env.PROOFFLOW_MCP_HOST ?? '127.0.0.1';
  const srv = createMcpHttpServer({ controlUrl, allowedOrigins: (process.env.PROOFFLOW_MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean), allowUrlToken: process.env.PROOFFLOW_MCP_ALLOW_URL_TOKEN === '1' });
  srv.listen(port, host, () => console.error(`[proofflow-mcp] streamable HTTP on http://${host}:${port}/mcp (control plane ${controlUrl})`));
}
