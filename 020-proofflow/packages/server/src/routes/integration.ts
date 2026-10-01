import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, parse, requireProject } from '../http.js';

export async function integrationRoutes(app: FastifyInstance) {
  app.post('/api/v1/projects/:projectId/test-impact', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:read');
    const body = parse(z.object({ changedFiles: z.array(z.string().max(500)).max(1000) }), req.body);
    return ok(reply, await app.svc.integration.testImpact(project, body.changedFiles));
  });
  app.post('/api/v1/projects/:projectId/test-impact/rules', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:write');
    const body = parse(z.object({ pattern: z.string().min(1).max(300), scenarioIds: z.array(z.string()).min(1).max(200) }), req.body);
    return ok(reply, await app.svc.integration.setImpactRule(req.ctx, project, body.pattern, body.scenarioIds), 201);
  });
  app.get('/api/v1/projects/:projectId/export/definitions', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:read');
    return ok(reply, await app.svc.integration.exportDefinitions(project));
  });
  app.post('/api/v1/projects/:projectId/import/definitions', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:write');
    const body = parse(z.object({ requirements: z.array(z.record(z.string(), z.unknown())).max(500).optional(), scenarios: z.array(z.record(z.string(), z.unknown())).max(2000).optional(), suites: z.array(z.record(z.string(), z.unknown())).max(100).optional(), changeReason: z.string().max(300).optional() }), req.body);
    return ok(reply, await app.svc.integration.importDefinitions(req.ctx, project, body, { changeReason: body.changeReason }));
  });
  app.get('/api/v1/runs/:runId/ci-summary', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = await app.svc.runs.getRow(runId);
    await requireProject(req, run.project_id, 'run:read');
    return ok(reply, await app.svc.integration.ciSummary(run));
  });
  app.get('/api/v1/orgs/:orgId/projects/by-slug/:slug', async (req, reply) => {
    const { orgId, slug } = req.params as { orgId: string; slug: string };
    const { requireOrg } = await import('../http.js');
    await requireOrg(req, orgId, 'project:read');
    const list = await app.svc.projects.list(orgId);
    const p = list.find((x) => x.slug === slug);
    if (!p || (req.ctx.actor.projectIds && !req.ctx.actor.projectIds.includes(p.id))) return reply.code(404).send({ error: { code: 'not_found', message: 'project not found' } });
    return ok(reply, p);
  });
}
