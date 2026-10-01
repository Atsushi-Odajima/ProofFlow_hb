import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlClient } from './client.js';
import { BrowserPool } from './browsers.js';
import { JobExecutor } from './executor.js';
import type { JobPayload } from './types.js';

export interface RunnerConfig { controlUrl: string; token: string; name?: string; concurrency?: number; browsers?: string[]; workDir?: string; allowPrivateNetwork?: boolean; pollIntervalMs?: number; log?: (m: string) => void; version?: string; }

export function createRunner(cfg: RunnerConfig) {
  const log = cfg.log ?? ((m: string) => console.log(`[runner] ${m}`));
  const client = new ControlClient(cfg.controlUrl.replace(/\/$/, ''), cfg.token);
  const pool = new BrowserPool();
  const workDir = cfg.workDir ?? join(tmpdir(), 'proofflow-runner'); mkdirSync(workDir, { recursive: true });
  const executor = new JobExecutor(client, pool, { workDir, log });
  const concurrency = cfg.concurrency ?? 2;
  let browsers = cfg.browsers ?? [];
  let active = 0; let stopping = false; let loop: Promise<void> | null = null;

  async function register() {
    if (browsers.length === 0) browsers = pool.available();
    if (browsers.length === 0) throw new Error('no browsers available: run `npx playwright install chromium` (and firefox/webkit if needed)');
    let pwVersion = 'unknown'; try { pwVersion = (createRequire(import.meta.url)('playwright/package.json') as { version: string }).version; } catch { /* ignore */ }
    const caps = { browsers, concurrency, playwright: pwVersion };
    const id = await client.register(cfg.name ?? `runner-${process.pid}`, cfg.version ?? '0.1.0', caps, cfg.allowPrivateNetwork ?? false);
    log(`registered as ${id} browsers=${browsers.join(',')} concurrency=${concurrency}`);
    return id;
  }
  async function runJob(job: JobPayload) { active++; try { await executor.run(job); } finally { active--; } }
  /** Lease and run until the queue is empty. Returns number of jobs processed. */
  async function drain(): Promise<number> {
    if (!client.runnerId) await register();
    let processed = 0;
    for (;;) {
      const jobs = await client.lease(browsers, Math.max(1, concurrency - active));
      if (jobs.length === 0) { if (active === 0) break; await new Promise((r) => setTimeout(r, 200)); continue; }
      processed += jobs.length;
      await Promise.all(jobs.map(runJob));
    }
    return processed;
  }
  async function start() {
    await register();
    stopping = false;
    loop = (async () => {
      while (!stopping) {
        try {
          const free = concurrency - active;
          const jobs = free > 0 ? await client.lease(browsers, free) : [];
          if (jobs.length) { for (const j of jobs) void runJob(j); continue; }
        } catch (e) { log(`lease error: ${e instanceof Error ? e.message : e}`); }
        await new Promise((r) => setTimeout(r, cfg.pollIntervalMs ?? 2000));
      }
    })();
  }
  async function stop() { stopping = true; await loop; while (active > 0) await new Promise((r) => setTimeout(r, 100)); await pool.closeAll(); }
  return { start, stop, drain, register, client, pool, get active() { return active; } };
}
