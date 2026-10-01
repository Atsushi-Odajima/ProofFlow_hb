import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ARTIFACT_KINDS } from '@proofflow/shared';
import { ok, parse } from '../http.js';
import { forbidden, unauthorized } from '../context.js';
import type { Readable } from 'node:stream';

/** Runner plane protocol. Auth: runner token (kind=runner). The runner never touches the DB or secret vault directly. */
export async function runnerRoutes(app: FastifyInstance) {
  const runnerOrg = (req: import('fastify').FastifyRequest) => {
    const a = req.ctx.actor;
    if (a.kind === 'anonymous') throw unauthorized();
    if (a.kind !== 'runner' || !a.tokenOrgId) throw forbidden('runner token required');
    return a.tokenOrgId;
  };
  app.post('/runner/v1/register', async (req, reply) => {
    const orgId = runnerOrg(req);
    const body = parse(z.object({ name: z.string().min(1).max(100), version: z.string().max(50).optional(), capabilities: z.record(z.string(), z.unknown()).optional(), allowPrivateNetwork: z.boolean().optional() }), req.body);
    return ok(reply, await app.svc.runs.registerRunner(req.ctx.actor, orgId, body));
  });
  app.post('/runner/v1/lease', async (req, reply) => {
    const orgId = runnerOrg(req);
    const body = parse(z.object({ runnerId: z.string(), browsers: z.array(z.string()).min(1), max: z.number().int().min(1).max(20).default(1) }), req.body);
    return ok(reply, { jobs: await app.svc.runs.lease(orgId, body.runnerId, body.browsers, body.max) });
  });
  app.post('/runner/v1/jobs/:jobId/heartbeat', async (req, reply) => {
    const orgId = runnerOrg(req); const { jobId } = req.params as { jobId: string };
    const body = parse(z.object({ runnerId: z.string(), progress: z.object({ stepIndex: z.number().int().optional(), message: z.string().max(300).optional(), attempt: z.number().int().optional() }).optional() }), req.body);
    return ok(reply, await app.svc.runs.heartbeat(orgId, body.runnerId, jobId, body.progress));
  });
  app.put('/runner/v1/jobs/:jobId/artifacts', async (req, reply) => {
    const orgId = runnerOrg(req); const { jobId } = req.params as { jobId: string };
    const q = parse(z.object({ runnerId: z.string(), kind: z.enum(ARTIFACT_KINDS), label: z.string().max(100).optional(), stepIndex: z.coerce.number().int().optional(), attempt: z.coerce.number().int().optional(), restricted: z.coerce.boolean().optional() }), req.query);
    const job = await app.svc.db.get<{ run_id: string; leased_by: string; org_id: string }>(`SELECT run_id, leased_by, org_id FROM run_jobs WHERE id = ?`, [jobId]);
    if (!job || job.org_id !== orgId || job.leased_by !== q.runnerId) throw forbidden('job not leased by this runner');
    const run = await app.svc.runs.getRow(job.run_id);
    const contentType = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim();
    const body = req.body as Readable | Buffer | string | undefined;
    const stream = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : (body as Readable);
    const a = await app.svc.artifacts.create({ orgId, projectId: run.project_id, runId: run.id, attempt: q.attempt ?? null, kind: q.kind, label: q.label ?? null, stepIndex: q.stepIndex ?? null, contentType, body: stream, retentionClass: 'failed', restricted: q.restricted ?? false, createdBy: q.runnerId });
    return ok(reply, { artifactId: a.id }, 201);
  });
  app.post('/runner/v1/jobs/:jobId/complete', async (req, reply) => {
    const orgId = runnerOrg(req); const { jobId } = req.params as { jobId: string };
    const Failure = z.object({ type: z.string(), message: z.string().max(5000), stepIndex: z.number().int().optional(), stepType: z.string().optional(), url: z.string().max(2000).optional(), locator: z.string().max(500).optional(), status: z.number().int().optional(), ruleId: z.string().max(100).optional(), stack: z.string().max(5000).optional(), expected: z.string().max(2000).optional(), actual: z.string().max(2000).optional() }).nullable().optional();
    const body = parse(z.object({ runnerId: z.string(), result: z.object({ status: z.enum(['passed', 'failed', 'flaky', 'skipped', 'cancelled', 'infra_error']), outcomeDetail: z.enum(['passed_first_try', 'passed_after_retry', 'failed_after_retries', 'failed_first_try', 'infra_error', 'not_run']), attempts: z.number().int().min(1), durationMs: z.number().int().min(0), startedAt: z.string(), completedAt: z.string(), browserVersion: z.string().max(60).optional(), failure: Failure, steps: z.array(z.unknown()).max(1000).optional(), consoleSummary: z.unknown().optional(), networkSummary: z.unknown().optional(), metrics: z.unknown().optional(), checks: z.unknown().optional(), attemptsDetail: z.array(z.object({ attempt: z.number().int(), status: z.string(), durationMs: z.number().int(), failure: Failure, steps: z.array(z.unknown()).max(1000).optional(), startedAt: z.string(), completedAt: z.string() })).max(10).optional() }), artifactIds: z.array(z.string()).max(500).optional() }), req.body);
    return ok(reply, await app.svc.runs.completeJob(orgId, body.runnerId, jobId, body.result, body.artifactIds ?? []));
  });
  app.post('/runner/v1/jobs/:jobId/fail', async (req, reply) => {
    const orgId = runnerOrg(req); const { jobId } = req.params as { jobId: string };
    const body = parse(z.object({ runnerId: z.string(), error: z.object({ message: z.string().max(2000), kind: z.enum(['infra', 'policy']).default('infra') }) }), req.body);
    return ok(reply, await app.svc.runs.failJob(orgId, body.runnerId, jobId, body.error));
  });
  // Fixture download for runners (signed)
  app.get('/fixtures/:id', async (req, reply) => {
    const { id } = req.params as { id: string }; const q = req.query as { exp?: string; sig?: string };
    if (!app.svc.artifacts.verifySignature(id, q.exp, q.sig)) return reply.code(403).send({ error: { code: 'invalid_or_expired_signature' } });
    const f = await app.svc.db.get<{ storage_key: string; content_type: string; name: string }>(`SELECT storage_key, content_type, name FROM fixtures WHERE id = ?`, [id]);
    if (!f) return reply.code(404).send({ error: { code: 'not_found' } });
    return reply.header('content-type', f.content_type).header('content-disposition', `attachment; filename="${f.name}"`).send(app.svc.fixtureStore.getStream(f.storage_key));
  });
}
