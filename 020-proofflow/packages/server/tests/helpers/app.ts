import { buildApp } from '@proofflow/server/app';
import { loadConfig, type Config } from '@proofflow/server/config';
import { openDb, type Db } from '@proofflow/server/db/db';
import { migrate } from '@proofflow/server/db/migrate';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestApp { app: FastifyInstance; db: Db; cfg: Config; dataDir: string; close(): Promise<void>; }

export async function createTestApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'proofflow-test-'));
  const cfg = loadConfig({ NODE_ENV: 'test', PROOFFLOW_DATA_DIR: dataDir, PROOFFLOW_PUBLIC_URL: 'http://localhost:8080' }, overrides);
  const db = await openDb({ driver: 'sqlite', sqlitePath: ':memory:' });
  await migrate(db);
  const app = await buildApp({ cfg, db });
  await app.ready();
  return { app, db, cfg, dataDir, close: async () => { await app.close(); await db.close(); } };
}

export interface Session { cookie: string; userId: string; orgId: string; workspaceId: string; email: string; }

export async function signup(app: FastifyInstance, email: string, orgName = 'Org ' + email): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email, password: 'Password-123456', name: email.split('@')[0], organizationName: orgName } });
  if (res.statusCode !== 201) throw new Error('signup failed: ' + res.body);
  const setCookie = res.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
  const d = res.json().data;
  return { cookie, userId: d.userId, orgId: d.organizationId, workspaceId: d.workspaceId, email };
}
export async function login(app: FastifyInstance, email: string, password = 'Password-123456'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error('login failed: ' + res.body);
  const setCookie = res.headers['set-cookie'];
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
}
export function api(app: FastifyInstance, auth: { cookie?: string; token?: string }) {
  const headers: Record<string, string> = {};
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  return {
    get: (url: string) => app.inject({ method: 'GET', url, headers }),
    post: (url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as never }),
    put: (url: string, payload?: unknown) => app.inject({ method: 'PUT', url, headers, payload: payload as never }),
    patch: (url: string, payload?: unknown) => app.inject({ method: 'PATCH', url, headers, payload: payload as never }),
    del: (url: string) => app.inject({ method: 'DELETE', url, headers }),
  };
}
export async function createProject(app: FastifyInstance, s: Session, name = 'Proj', extra: Record<string, unknown> = {}) {
  const res = await api(app, { cookie: s.cookie }).post(`/api/v1/orgs/${s.orgId}/projects`, { name, type: 'web_app', ...extra });
  if (res.statusCode !== 201) throw new Error('project create failed: ' + res.body);
  return res.json().data as { id: string; name: string };
}
export async function createEnvironment(app: FastifyInstance, s: Session, projectId: string, extra: Record<string, unknown> = {}) {
  const res = await api(app, { cookie: s.cookie }).post(`/api/v1/projects/${projectId}/environments`, { name: 'Staging', kind: 'staging', baseUrl: 'https://staging.example.com', ...extra });
  if (res.statusCode !== 201) throw new Error('env create failed: ' + res.body);
  return res.json().data as { id: string; kind: string; destructivePolicy: string };
}
