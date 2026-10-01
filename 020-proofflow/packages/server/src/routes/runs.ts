import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RunCreate, roleHas } from '@proofflow/shared';
import { ok, parse, requireProject, requireOrg } from '../http.js';
import { notFound } from '../context.js';

export async function runRoutes(app: FastifyInstance) {
  app.post('/api/v1/projects/:projectId/runs', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project, role } = await requireProject(req, projectId, 'run:trigger');
    const body = parse(RunCreate, req.body);
    const r = await app.svc.runs.create(req.ctx, project, body, { canRunDestructive: roleHas(role, 'run:trigger_destructive') });
    return ok(reply, r.run, r.deduplicated ? 200 : 202);
  });
  app.get('/api/v1/projects/:projectId/runs', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'run:read');
    const q = req.query as Record<string, string | undefined>;
    return ok(reply, await app.svc.runs.list(project.id, { status: q.status, environmentId: q.environmentId, suiteId: q.suiteId, releaseCandidateId: q.releaseCandidateId, branch: q.branch, limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor }));
  });
  app.get('/api/v1/runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = await app.svc.runs.getRow(runId);
    await requireProject(req, run.project_id, 'run:read');
    return ok(reply, await app.svc.runs.detail(run));
  });
  app.post('/api/v1/runs/:runId/cancel', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = await app.svc.runs.getRow(runId);
    await requireProject(req, run.project_id, 'run:cancel');
    await app.svc.runs.cancel(req.ctx, run);
    return ok(reply, { cancelled: true });
  });
  app.get('/api/v1/results/:resultId', async (req, reply) => {
    const { resultId } = req.params as { resultId: string };
    const r = await app.svc.runs.getResult(resultId);
    await requireProject(req, r.project_id, 'run:read');
    const { resultView } = await import('../services/runs.js');
    return ok(reply, { ...resultView(r), artifacts: await app.svc.artifacts.listForResult(r.id) });
  });
  // Realtime progress (Server-Sent Events)
  app.get('/api/v1/runs/:runId/events', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = await app.svc.runs.getRow(runId);
    await requireProject(req, run.project_id, 'run:read');
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('snapshot', await app.svc.runs.detail(run));
    const listener = (e: { event: string; data: unknown }) => send(e.event, e.data);
    app.svc.runs.events.on(`run:${runId}`, listener);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(ping); app.svc.runs.events.off(`run:${runId}`, listener); });
    await new Promise<void>((resolve) => req.raw.on('close', () => resolve()));
    return reply;
  });
  // Artifacts (authenticated) + signed public path
  app.get('/api/v1/artifacts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await app.svc.artifacts.getRow(id);
    if (!a || a.deleted_at) throw notFound('artifact');
    const { role } = await requireProject(req, a.project_id, 'artifact:read');
    if (a.restricted && !roleHas(role, 'artifact:read_restricted')) throw notFound('artifact');
    const { artifactView } = await import('../services/artifacts.js');
    return ok(reply, { ...artifactView(a), signedUrl: app.svc.artifacts.signedPath(a.id) });
  });
  app.get('/api/v1/artifacts/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await app.svc.artifacts.getRow(id);
    if (!a || a.deleted_at) throw notFound('artifact');
    const { role } = await requireProject(req, a.project_id, 'artifact:read');
    if (a.restricted && !roleHas(role, 'artifact:read_restricted')) throw notFound('artifact');
    const { stream } = await app.svc.artifacts.open(id);
    return reply.header('content-type', a.content_type).header('content-disposition', `inline; filename="${a.kind}-${a.id}${extFor(a.content_type)}"`).send(stream);
  });
  app.get('/artifacts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { exp?: string; sig?: string };
    if (!app.svc.artifacts.verifySignature(id, q.exp, q.sig)) return reply.code(403).send({ error: { code: 'invalid_or_expired_signature', message: 'signed URL invalid or expired' } });
    const { row, stream } = await app.svc.artifacts.open(id);
    return reply.header('content-type', row.content_type).header('cache-control', 'private, max-age=60').send(stream);
  });
  app.post('/api/v1/artifacts/:id/restrict', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await app.svc.artifacts.getRow(id);
    if (!a) throw notFound('artifact');
    await requireProject(req, a.project_id, 'artifact:read_restricted');
    const body = parse(z.object({ restricted: z.boolean() }), req.body);
    await app.svc.artifacts.setRestricted(req.ctx.actor, a.org_id, id, body.restricted, req.ctx.ip);
    return ok(reply, { restricted: body.restricted });
  });
  app.get('/api/v1/orgs/:orgId/storage', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'org:read');
    return ok(reply, await app.svc.artifacts.storageUsage(orgId));
  });
  app.post('/api/v1/orgs/:orgId/retention/run', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'retention:manage');
    return ok(reply, await app.svc.artifacts.runRetention(orgId));
  });
  app.get('/api/v1/orgs/:orgId/runners', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'org:read');
    return ok(reply, await app.svc.runs.runnersList(orgId));
  });
  app.patch('/api/v1/orgs/:orgId/runners/:runnerId', async (req, reply) => {
    const { orgId, runnerId } = req.params as { orgId: string; runnerId: string };
    await requireOrg(req, orgId, 'runner:manage');
    const body = parse(z.object({ allowPrivateNetwork: z.boolean() }), req.body);
    await app.svc.runs.setRunnerPrivate(req.ctx, orgId, runnerId, body.allowPrivateNetwork);
    return ok(reply, { updated: true });
  });
}
function extFor(ct: string): string { return ct.includes('png') ? '.png' : ct.includes('webm') ? '.webm' : ct.includes('zip') ? '.zip' : ct.includes('json') ? '.json' : ct.includes('html') ? '.html' : ct.includes('ndjson') ? '.ndjson' : ''; }
