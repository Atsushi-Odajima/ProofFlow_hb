import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { createServices, type Services } from './services/index.js';
import { HttpError, ANON, type Ctx } from './context.js';
import { authRoutes, SESSION_COOKIE } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { projectRoutes } from './routes/projects.js';
import { testDesignRoutes } from './routes/testdesign.js';
import { aiRoutes } from './routes/ai.js';
import { runRoutes } from './routes/runs.js';
import { runnerRoutes } from './routes/runner.js';
import { fixtureRoutes } from './routes/fixtures.js';
import { visualRoutes } from './routes/visual.js';
import { defectRoutes } from './routes/defects.js';
import { releaseRoutes } from './routes/release.js';
import { manualRoutes } from './routes/manual.js';
import { integrationRoutes } from './routes/integration.js';
import { opsRoutes } from './routes/ops.js';
import { APP_VERSION } from '@proofflow/shared';

export interface AppOptions { cfg: Config; db: Db; logger?: boolean; services?: Services; aiProvider?: import('./ai/provider.js').AiProvider; }

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.cfg.trustProxy, bodyLimit: 2 * 1024 * 1024, genReqId: () => randomUUID() });
  const svc = opts.services ?? (await createServices(opts.db, opts.cfg, { aiProvider: opts.aiProvider }));
  app.decorate('svc', svc);
  app.decorateRequest('ctx', null as unknown as Ctx);
  await app.register(cookie, { secret: opts.cfg.signingSecret });
  if (!opts.cfg.disableRateLimit) await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  // Raw bodies for artifact uploads (runner) — streamed, not buffered in memory.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  app.addContentTypeParser(/^(image|video|application\/zip|application\/x-ndjson|text)\/?.*/, (_req, payload, done) => done(null, payload));

  app.addHook('onRequest', async (req) => {
    const ip = req.ip;
    req.ctx = { actor: ANON, ip, requestId: req.id };
    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer ')) {
      const actor = await svc.auth.resolveApiToken(authz.slice(7).trim());
      if (!actor) throw new HttpError(401, 'unauthorized', 'invalid or expired token');
      req.ctx.actor = actor;
      return;
    }
    const sess = req.cookies[SESSION_COOKIE];
    if (sess) {
      const actor = await svc.auth.resolveSession(sess);
      if (actor) {
        // CSRF hardening for cookie sessions: state-changing requests must come from our own origin when Origin/Sec-Fetch-Site is present.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const origin = req.headers.origin; const site = req.headers['sec-fetch-site'];
          if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'csrf', 'cross-site request blocked');
          if (origin && !opts.cfg.publicUrl.startsWith(origin) && !(origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))) throw new HttpError(403, 'csrf', 'origin mismatch');
        }
        req.ctx.actor = actor;
      }
    }
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    const e = err as { statusCode?: number; validation?: unknown; message?: string; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'internal error', requestId: req.id } });
  });

  if (opts.cfg.scheduler.enabled) {
    const t = setInterval(() => { svc.runs.sweepExpiredLeases().catch((e) => app.log.error(e)); svc.schedules.tick().catch((e) => app.log.error(e)); }, opts.cfg.scheduler.intervalMs); t.unref();
    const r = setInterval(() => { svc.artifacts.runRetention().catch((e) => app.log.error(e)); }, 6 * 3600_000); r.unref();
    app.addHook('onClose', async () => { clearInterval(t); clearInterval(r); });
  }
  app.get('/api/v1/health', async () => ({ ok: true, version: APP_VERSION, db: svc.db.dialect, time: new Date().toISOString() }));
  await app.register(authRoutes);
  await app.register(orgRoutes);
  await app.register(projectRoutes);
  await app.register(testDesignRoutes);
  await app.register(aiRoutes);
  await app.register(runRoutes);
  await app.register(runnerRoutes);
  await app.register(fixtureRoutes);
  await app.register(visualRoutes);
  await app.register(defectRoutes);
  await app.register(releaseRoutes);
  await app.register(manualRoutes);
  await app.register(integrationRoutes);
  await app.register(opsRoutes);
  // Web UI (built SPA) with history-API fallback; API/runner/artifact paths are never shadowed.
  const webDir = opts.cfg.webDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (existsSync(join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false, index: ['index.html'], cacheControl: true, maxAge: '1h', immutable: false });
    const indexHtml = readFileSync(join(webDir, 'index.html'));
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/runner/') && !req.url.startsWith('/artifacts/') && !req.url.startsWith('/fixtures/') && !req.url.includes('.')) return reply.type('text/html').send(indexHtml);
      return reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } });
    });
  }
  return app;
}
