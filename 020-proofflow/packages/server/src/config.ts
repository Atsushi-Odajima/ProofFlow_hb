import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  port: number; host: string; publicUrl: string; dataDir: string;
  dbDriver: 'sqlite' | 'postgres'; databaseUrl?: string; sqlitePath: string;
  masterKey: Buffer; signingSecret: string;
  aiProvider: 'none' | 'openai' | 'anthropic' | 'mock'; openaiApiKey?: string; anthropicApiKey?: string; aiModel?: string;
  runnerToken?: string; sessionTtlHours: number; artifactUrlTtlSec: number; maxArtifactBytes: number;
  cookieSecure: boolean; trustProxy: boolean; disableRateLimit: boolean; allowPrivateTargetsGlobally: boolean;
  retention: { passedDays: number; failedDays: number; releaseDays: number; manualDays: number };
  scheduler: { enabled: boolean; intervalMs: number };
  webDir?: string;
}

function readOrCreateKeyFile(dataDir: string, name: string, bytes: number): string {
  mkdirSync(dataDir, { recursive: true });
  const p = join(dataDir, name);
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  const v = randomBytes(bytes).toString('base64');
  writeFileSync(p, v, { mode: 0o600 });
  console.warn(`[proofflow] generated ${name} in ${dataDir} (set the env var in production)`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = env.PROOFFLOW_DATA_DIR ?? './data';
  const isTest = env.NODE_ENV === 'test' || env.VITEST === 'true';
  const masterKeyB64 = env.PROOFFLOW_MASTER_KEY || (isTest ? randomBytes(32).toString('base64') : readOrCreateKeyFile(dataDir, 'master.key', 32));
  const masterKey = Buffer.from(masterKeyB64, 'base64');
  if (masterKey.length !== 32) throw new Error('PROOFFLOW_MASTER_KEY must be 32 bytes base64');
  const signingSecret = env.PROOFFLOW_SIGNING_SECRET || (isTest ? randomBytes(32).toString('base64') : readOrCreateKeyFile(dataDir, 'signing.key', 32));
  const cfg: Config = {
    port: Number(env.PROOFFLOW_PORT ?? 8080), host: env.PROOFFLOW_HOST ?? '127.0.0.1', publicUrl: env.PROOFFLOW_PUBLIC_URL ?? `http://localhost:${env.PROOFFLOW_PORT ?? 8080}`,
    dataDir, dbDriver: (env.PROOFFLOW_DB_DRIVER as Config['dbDriver']) ?? 'sqlite', databaseUrl: env.PROOFFLOW_DATABASE_URL, sqlitePath: env.PROOFFLOW_SQLITE_PATH ?? join(dataDir, 'proofflow.sqlite'),
    masterKey, signingSecret,
    aiProvider: (env.PROOFFLOW_AI_PROVIDER as Config['aiProvider']) ?? 'none', openaiApiKey: env.OPENAI_API_KEY, anthropicApiKey: env.ANTHROPIC_API_KEY, aiModel: env.PROOFFLOW_AI_MODEL,
    runnerToken: env.PROOFFLOW_RUNNER_TOKEN, sessionTtlHours: Number(env.PROOFFLOW_SESSION_TTL_HOURS ?? 24 * 14), artifactUrlTtlSec: Number(env.PROOFFLOW_ARTIFACT_URL_TTL_SEC ?? 900),
    maxArtifactBytes: Number(env.PROOFFLOW_MAX_ARTIFACT_BYTES ?? 200 * 1024 * 1024),
    cookieSecure: (env.PROOFFLOW_PUBLIC_URL ?? '').startsWith('https://'), trustProxy: env.PROOFFLOW_TRUST_PROXY === '1', disableRateLimit: env.PROOFFLOW_DISABLE_RATE_LIMIT === '1' || isTest,
    allowPrivateTargetsGlobally: env.PROOFFLOW_ALLOW_PRIVATE_TARGETS === '1',
    retention: { passedDays: Number(env.PROOFFLOW_RETENTION_PASSED_DAYS ?? 7), failedDays: Number(env.PROOFFLOW_RETENTION_FAILED_DAYS ?? 60), releaseDays: Number(env.PROOFFLOW_RETENTION_RELEASE_DAYS ?? 365), manualDays: Number(env.PROOFFLOW_RETENTION_MANUAL_DAYS ?? 365) },
    scheduler: { enabled: env.PROOFFLOW_SCHEDULER !== '0' && !isTest, intervalMs: Number(env.PROOFFLOW_SCHEDULER_INTERVAL_MS ?? 30_000) },
    webDir: env.PROOFFLOW_WEB_DIR,
  };
  return { ...cfg, ...overrides };
}
