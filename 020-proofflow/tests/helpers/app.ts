import { buildApp } from '@proofflow/server/app';
import { loadConfig, type Config } from '@proofflow/server/config';
import { openDb, type Db } from '@proofflow/server/db/db';
import { migrate } from '@proofflow/server/db/migrate';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestApp { app: FastifyInstance; db: Db; cfg: Config; dataDir: string; close(): Promise<void>; }

/**
 * Test database: in-memory SQLite by default. Set PROOFFLOW_TEST_DATABASE_URL (e.g. postgresql://proofflow:proofflow@127.0.0.1:5432/proofflow_test)
 * to run the same suite against PostgreSQL — every test app then gets its own schema, dropped on close.
 */
const PG_URL = process.env.PROOFFLOW_TEST_DATABASE_URL;
export const TEST_DB_DIALECT = PG_URL ? 'postgres' : 'sqlite';
async function openTestDb(): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  if (!PG_URL) { const db = await openDb({ driver: 'sqlite', sqlitePath: ':memory:' }); return { db, cleanup: () => db.close() }; }
  const schema = 't_' + randomBytes(6).toString('hex');
  const admin = await openDb({ driver: 'postgres', url: PG_URL });
  await admin.run(`CREATE SCHEMA ${schema}`);
  const u = new URL(PG_URL); u.searchParams.set('options', `-c search_path=${schema}`);
  const db = await openDb({ driver: 'postgres', url: u.toString() });
  return { db, cleanup: async () => { await db.close(); await admin.run(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } };
}

export async function createTestApp(overrides: Partial<Config> = {}, env: Record<string, string> = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'proofflow-test-'));
  const cfg = loadConfig({ NODE_ENV: 'test', PROOFFLOW_DATA_DIR: dataDir, PROOFFLOW_PUBLIC_URL: 'http://localhost:8080', ...env }, { dbDriver: TEST_DB_DIALECT, ...overrides });
  const { db, cleanup } = await openTestDb();
  await migrate(db);
  const app = await buildApp({ cfg, db });
  await app.ready();
  return { app, db, cfg, dataDir, close: async () => { await app.close(); await cleanup(); } };
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
export async function createToken(app: FastifyInstance, s: Session, input: Record<string, unknown>): Promise<string> {
  const res = await api(app, { cookie: s.cookie }).post(`/api/v1/orgs/${s.orgId}/tokens`, { name: 'tok', kind: 'service', role: 'qa_lead', ...input });
  if (res.statusCode !== 201) throw new Error('token create failed: ' + res.body);
  return res.json().data.token as string;
}
