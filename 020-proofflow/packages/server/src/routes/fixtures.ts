import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, parse, requireProject, rawBody } from '../http.js';

export async function fixtureRoutes(app: FastifyInstance) {
  app.get('/api/v1/projects/:projectId/fixtures', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:read');
    return ok(reply, await app.svc.fixtures.list(project.id));
  });
  // PUT raw bytes with ?name=...; content-type header is the fixture type.
  app.put('/api/v1/projects/:projectId/fixtures', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:write');
    const q = parse(z.object({ name: z.string().min(1).max(120), allowUnsafeForTesting: z.coerce.boolean().optional() }), req.query);
    const ct = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim();
    return ok(reply, await app.svc.fixtures.put(req.ctx, project, q.name, ct, rawBody(req), { allowUnsafeForTesting: q.allowUnsafeForTesting }), 201);
  });
  app.delete('/api/v1/projects/:projectId/fixtures/:id', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'scenario:write');
    await app.svc.fixtures.remove(req.ctx, project, id);
    return ok(reply, { deleted: true });
  });
  // OpenAPI inventory / contract baseline
  app.post('/api/v1/projects/:projectId/openapi', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:write');
    const body = parse(z.object({ spec: z.record(z.string(), z.unknown()), source: z.string().max(500).optional() }), req.body);
    return ok(reply, await app.svc.openapi.import(req.ctx, project, body.spec, body.source), 201);
  });
  app.get('/api/v1/projects/:projectId/openapi', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:read');
    return ok(reply, { specs: await app.svc.openapi.list(project.id), baseline: await app.svc.openapi.baseline(project.id) });
  });
  app.post('/api/v1/projects/:projectId/openapi/:specId/baseline', async (req, reply) => {
    const { projectId, specId } = req.params as { projectId: string; specId: string };
    const { project } = await requireProject(req, projectId, 'baseline:update');
    const body = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    await app.svc.openapi.setBaseline(req.ctx, project, specId, body.reason);
    return ok(reply, { baseline: specId });
  });
}
