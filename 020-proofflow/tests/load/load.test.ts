/**
 * Load / concurrency measurement for a single-node control plane (負荷目標: 月 100 / 1,000 / 10,000 run の現実的な規模を実測).
 * Measures, at 100 → 1,000 → 10,000 runs of metadata in one project:
 *   - run creation latency/throughput through the HTTP API
 *   - runner lease → complete throughput with 4 concurrent simulated runners (no browser; the control-plane cost only)
 *   - artifact upload throughput (200 KB screenshot-sized bodies)
 *   - dashboard / run list / run detail / audit query latency
 * Results are written to docs/load-results.json and summarized in TEST_REPORT.md. These are measurements on the machine that
 * ran them, not guarantees.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@proofflow/server/app';
import { loadConfig } from '@proofflow/server/config';
import { openDb, type Db } from '@proofflow/server/db/db';
import { migrate } from '@proofflow/server/db/migrate';
import { signup, api, createProject, type Session } from '../helpers/app.js';

const PG_URL = process.env.PROOFFLOW_TEST_DATABASE_URL;
const SCALE = (process.env.PROOFFLOW_LOAD_SCALES ?? '100,1000,10000').split(',').map(Number);
const RUNNERS = Number(process.env.PROOFFLOW_LOAD_RUNNERS ?? 4);

let app: FastifyInstance; let db: Db; let dataDir: string; let s: Session; let A: ReturnType<typeof api>; let projectId: string; let envId: string; let scenarioIds: string[] = []; let runnerToken: string; let runnerIds: string[] = [];
const results: Record<string, unknown> = { dialect: PG_URL ? 'postgres' : 'sqlite(file,WAL)', node: process.version, cpus: cpus().length, cpuModel: cpus()[0]?.model, memGB: Math.round(totalmem() / 1e9), date: new Date().toISOString(), scales: {} as Record<string, unknown> };

const pct = (xs: number[], q: number) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))]! : 0; };
const stats = (xs: number[]) => ({ n: xs.length, p50: +pct(xs, 0.5).toFixed(2), p95: +pct(xs, 0.95).toFixed(2), max: +Math.max(0, ...xs).toFixed(2), mean: +(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)).toFixed(2) });
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> { const t = performance.now(); const r = await fn(); return [r, performance.now() - t]; }

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'proofflow-load-'));
  const cfg = loadConfig({ NODE_ENV: 'test', PROOFFLOW_DATA_DIR: dataDir, PROOFFLOW_PUBLIC_URL: 'http://localhost:8080' }, { dbDriver: PG_URL ? 'postgres' : 'sqlite' });
  if (PG_URL) { const u = new URL(PG_URL); u.searchParams.set('options', '-c search_path=load_test'); const admin = await openDb({ driver: 'postgres', url: PG_URL }); await admin.run('DROP SCHEMA IF EXISTS load_test CASCADE'); await admin.run('CREATE SCHEMA load_test'); await admin.close(); db = await openDb({ driver: 'postgres', url: u.toString() }); }
  else db = await openDb({ driver: 'sqlite', sqlitePath: join(dataDir, 'load.sqlite') });
  await migrate(db);
  app = await buildApp({ cfg, db }); await app.ready();
  s = await signup(app, 'load@a.example', 'Load Org'); A = api(app, { cookie: s.cookie });
  projectId = (await createProject(app, s, 'Load Project')).id;
  envId = (await A.post(`/api/v1/projects/${projectId}/environments`, { name: 'Local', kind: 'local', baseUrl: 'http://127.0.0.1:4100', allowPrivateNetwork: true })).json().data.id;
  for (let i = 0; i < 20; i++) scenarioIds.push((await A.post(`/api/v1/projects/${projectId}/scenarios`, { title: `Scenario ${i}`, steps: [{ type: 'navigate', url: `/page-${i}` }, { type: 'assert_title', title: 'x' }] })).json().data.id);
  runnerToken = (await A.post(`/api/v1/orgs/${s.orgId}/tokens`, { name: 'load-runner', kind: 'runner' })).json().data.token;
  for (let i = 0; i < RUNNERS; i++) runnerIds.push((await app.inject({ method: 'POST', url: '/runner/v1/register', headers: { authorization: `Bearer ${runnerToken}` }, payload: { name: `load-runner-${i}`, capabilities: { browsers: ['chromium'] }, allowPrivateNetwork: true } })).json().data.runnerId);
}, 600_000);
afterAll(async () => {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `load-results-${PG_URL ? 'postgres' : 'sqlite'}.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await app.close(); await db.close();
});

async function createRuns(n: number) {
  const lat: number[] = []; const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const [res, ms] = await timed(() => A.post(`/api/v1/projects/${projectId}/runs`, { environmentId: envId, scenarioIds: [scenarioIds[i % scenarioIds.length]!], matrix: { browsers: ['chromium'], viewports: [{ width: 1280, height: 800 }], retries: 0 }, trigger: 'api', label: `load ${i}` }));
    if (res.statusCode !== 202 && res.statusCode !== 200) throw new Error('run create failed ' + res.body);
    lat.push(ms);
  }
  const secs = (performance.now() - t0) / 1000;
  return { latencyMs: stats(lat), runsPerSec: +(n / secs).toFixed(1) };
}
async function drainJobs(limit: number) {
  const H = { authorization: `Bearer ${runnerToken}` };
  let done = 0; const leaseLat: number[] = []; const completeLat: number[] = []; const uploadLat: number[] = []; let uploadBytes = 0; const t0 = performance.now();
  const png = Buffer.alloc(200 * 1024, 7);
  const worker = async (runnerId: string) => {
    while (done < limit) {
      const [lease, lms] = await timed(() => app.inject({ method: 'POST', url: '/runner/v1/lease', headers: H, payload: { runnerId, browsers: ['chromium'], max: 5 } }));
      leaseLat.push(lms);
      const jobs = lease.json().data.jobs as Array<{ jobId: string }>;
      if (!jobs.length) return;
      for (const j of jobs) {
        if (done >= limit) return;
        done++;
        const artifactIds: string[] = [];
        if (uploadLat.length < 200) {
          const [up, ums] = await timed(() => app.inject({ method: 'PUT', url: `/runner/v1/jobs/${j.jobId}/artifacts?runnerId=${runnerId}&kind=screenshot&label=final`, headers: { ...H, 'content-type': 'image/png' }, payload: png }));
          if (up.statusCode === 201) { artifactIds.push(up.json().data.artifactId); uploadLat.push(ums); uploadBytes += png.length; }
        }
        const now = new Date().toISOString();
        const [c, cms] = await timed(() => app.inject({ method: 'POST', url: `/runner/v1/jobs/${j.jobId}/complete`, headers: H, payload: { runnerId, result: { status: 'passed', outcomeDetail: 'passed_first_try', attempts: 1, durationMs: 1200, startedAt: now, completedAt: now, browserVersion: '141.0', steps: [{ index: 0, type: 'navigate', status: 'passed', durationMs: 300 }], metrics: { ttfbMs: 20, domContentLoadedMs: 80, loadMs: 150 } }, artifactIds } }));
        if (c.statusCode !== 200) throw new Error('complete failed ' + c.body);
        completeLat.push(cms);
      }
    }
  };
  await Promise.all(runnerIds.map(worker));
  const secs = (performance.now() - t0) / 1000;
  return { jobs: done, jobsPerSec: +(done / secs).toFixed(1), leaseMs: stats(leaseLat), completeMs: stats(completeLat), uploads: uploadLat.length, uploadMs: stats(uploadLat), uploadMBps: +((uploadBytes / 1e6) / Math.max(0.001, uploadLat.reduce((a, b) => a + b, 0) / 1000)).toFixed(1) };
}
async function queries() {
  const q = async (label: string, url: string) => { const l: number[] = []; for (let i = 0; i < 20; i++) { const [r, ms] = await timed(() => A.get(url)); expect(r.statusCode, label).toBe(200); l.push(ms); } return stats(l); };
  const firstRun = (await A.get(`/api/v1/projects/${projectId}/runs?limit=1`)).json().data[0].id as string;
  return {
    dashboard: await q('dashboard', `/api/v1/projects/${projectId}/dashboard`),
    runList50: await q('runs', `/api/v1/projects/${projectId}/runs?limit=50`),
    runListFailed: await q('runs failed', `/api/v1/projects/${projectId}/runs?limit=50&status=failed`),
    runDetail: await q('run detail', `/api/v1/runs/${firstRun}`),
    audit50: await q('audit', `/api/v1/orgs/${s.orgId}/audit?limit=50`),
    flaky: await q('flaky', `/api/v1/projects/${projectId}/flaky`),
    storage: await q('storage', `/api/v1/orgs/${s.orgId}/storage`),
  };
}

describe('load / concurrency measurement', () => {
  it('measures run creation, runner lease/complete throughput, artifact upload and dashboard queries at 100 / 1,000 / 10,000 runs', async () => {
    let total = 0;
    for (const target of SCALE) {
      const n = target - total; if (n <= 0) continue;
      const create = await createRuns(n); total = target;
      const drain = await drainJobs(Math.min(n, 2000));
      // leave the rest of this scale's jobs queued? No — complete everything so the next scale measures a clean queue.
      let remaining = n - drain.jobs; while (remaining > 0) { const d = await drainJobs(remaining); if (d.jobs === 0) break; remaining -= d.jobs; }
      const q = await queries();
      const counts = await db.get<{ runs: number; results: number; artifacts: number }>(`SELECT (SELECT COUNT(*) FROM test_runs) AS runs, (SELECT COUNT(*) FROM test_results) AS results, (SELECT COUNT(*) FROM artifacts) AS artifacts`);
      (results.scales as Record<string, unknown>)[String(target)] = { runsInProject: Number(counts?.runs), results: Number(counts?.results), artifactsMeta: Number(counts?.artifacts), create, drain: { ...drain, concurrentRunners: RUNNERS }, queries: q };
      console.log(`scale ${target}: create ${create.runsPerSec} runs/s (p95 ${create.latencyMs.p95} ms) · lease+complete ${drain.jobsPerSec} jobs/s with ${RUNNERS} runners (complete p95 ${drain.completeMs.p95} ms) · upload ${drain.uploadMBps} MB/s · dashboard p95 ${q.dashboard.p95} ms · run list p95 ${q.runList50.p95} ms`);
      expect(q.dashboard.p95).toBeLessThan(5000);
      expect(q.runList50.p95).toBeLessThan(2000);
    }
  });
});
