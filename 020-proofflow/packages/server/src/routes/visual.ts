import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, parse, requireProject } from '../http.js';

export async function visualRoutes(app: FastifyInstance) {
  app.get('/api/v1/projects/:projectId/visual/comparisons', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'baseline:read');
    const q = req.query as Record<string, string | undefined>;
    return ok(reply, await app.svc.visual.list(project.id, { status: q.status, runId: q.runId, scenarioId: q.scenarioId, limit: q.limit ? Number(q.limit) : undefined }));
  });
  app.get('/api/v1/projects/:projectId/visual/baselines', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'baseline:read');
    const q = req.query as { scenarioId?: string };
    return ok(reply, await app.svc.visual.baselines(project.id, q.scenarioId));
  });
  app.get('/api/v1/projects/:projectId/baselines/history', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'baseline:read');
    const q = req.query as { kind?: string };
    return ok(reply, await app.svc.visual.history(project.id, q.kind));
  });
  app.post('/api/v1/projects/:projectId/visual/approve', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'baseline:update');
    if (req.ctx.actor.kind !== 'user' && req.ctx.actor.kind !== 'token') return reply.code(403).send({ error: { code: 'forbidden', message: 'baseline updates require a human actor' } });
    const body = parse(z.object({ comparisonIds: z.array(z.string()).min(1).max(200), reason: z.string().min(3).max(500), confirmBulk: z.boolean().optional(), releaseCandidateId: z.string().optional() }), req.body);
    return ok(reply, await app.svc.visual.approve(req.ctx, project, body.comparisonIds, body.reason, { confirmBulk: body.confirmBulk, releaseCandidateId: body.releaseCandidateId }));
  });
  app.post('/api/v1/projects/:projectId/visual/comparisons/:id/reject', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'baseline:update');
    const body = parse(z.object({ note: z.string().min(1).max(500) }), req.body);
    await app.svc.visual.reject(req.ctx, project, id, body.note);
    return ok(reply, { rejected: true });
  });
  // Crawl inventory (pages/forms/links discovered by crawl runs within the allowed base URL)
  app.get('/api/v1/projects/:projectId/environments/:envId/inventory', async (req, reply) => {
    const { projectId, envId } = req.params as { projectId: string; envId: string };
    const { project } = await requireProject(req, projectId, 'scenario:read');
    await app.svc.projects.getEnvironmentRow(envId, project.id);
    return ok(reply, await app.svc.db.all(`SELECT id, run_id, url, title, status_code, kind, forms_json, links_count, discovered_at FROM crawl_inventory WHERE environment_id = ? ORDER BY url LIMIT 2000`, [envId]));
  });
}
