import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RequirementCreate, RequirementUpdate, ScenarioCreate, ScenarioUpdate, SuiteCreate, SuiteUpdate } from '@proofflow/shared';
import { ok, parse, requireProject } from '../http.js';

export async function testDesignRoutes(app: FastifyInstance) {
  // ----- Requirements -----
  app.get('/api/v1/projects/:projectId/requirements', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'requirement:read');
    const q = req.query as Record<string, string | undefined>;
    return ok(reply, await app.svc.requirements.list(project.id, { status: q.status, limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor }));
  });
  app.post('/api/v1/projects/:projectId/requirements', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'requirement:write');
    return ok(reply, await app.svc.requirements.create(req.ctx, project, parse(RequirementCreate, req.body)), 201);
  });
  app.get('/api/v1/projects/:projectId/requirements/:reqId', async (req, reply) => {
    const { projectId, reqId } = req.params as { projectId: string; reqId: string };
    const { project } = await requireProject(req, projectId, 'requirement:read');
    return ok(reply, await app.svc.requirements.get(reqId, project.id));
  });
  app.get('/api/v1/projects/:projectId/requirements/:reqId/traceability', async (req, reply) => {
    const { projectId, reqId } = req.params as { projectId: string; reqId: string };
    const { project } = await requireProject(req, projectId, 'requirement:read');
    return ok(reply, await app.svc.requirements.traceability(project.id, reqId));
  });
  app.patch('/api/v1/projects/:projectId/requirements/:reqId', async (req, reply) => {
    const { projectId, reqId } = req.params as { projectId: string; reqId: string };
    const { project } = await requireProject(req, projectId, 'requirement:write');
    const row = await app.svc.requirements.getRow(reqId, project.id);
    return ok(reply, await app.svc.requirements.update(req.ctx, project, row, parse(RequirementUpdate, req.body)));
  });
  app.delete('/api/v1/projects/:projectId/requirements/:reqId', async (req, reply) => {
    const { projectId, reqId } = req.params as { projectId: string; reqId: string };
    const { project } = await requireProject(req, projectId, 'requirement:write');
    await app.svc.requirements.remove(req.ctx, project, await app.svc.requirements.getRow(reqId, project.id));
    return ok(reply, { deleted: true });
  });

  // ----- Scenarios -----
  app.get('/api/v1/projects/:projectId/scenarios', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:read');
    const q = req.query as Record<string, string | undefined>;
    return ok(reply, await app.svc.scenarios.list(project.id, { status: q.status, tag: q.tag, priority: q.priority, q: q.q, requirementId: q.requirementId, limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor }));
  });
  app.post('/api/v1/projects/:projectId/scenarios', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:write');
    return ok(reply, await app.svc.scenarios.create(req.ctx, project, parse(ScenarioCreate, req.body)), 201);
  });
  app.get('/api/v1/projects/:projectId/scenarios/:scenarioId', async (req, reply) => {
    const { projectId, scenarioId } = req.params as { projectId: string; scenarioId: string };
    const { project } = await requireProject(req, projectId, 'scenario:read');
    return ok(reply, await app.svc.scenarios.get(scenarioId, project.id));
  });
  app.get('/api/v1/projects/:projectId/scenarios/:scenarioId/versions', async (req, reply) => {
    const { projectId, scenarioId } = req.params as { projectId: string; scenarioId: string };
    const { project } = await requireProject(req, projectId, 'scenario:read');
    await app.svc.scenarios.getRow(scenarioId, project.id);
    return ok(reply, await app.svc.scenarios.versions(scenarioId));
  });
  app.patch('/api/v1/projects/:projectId/scenarios/:scenarioId', async (req, reply) => {
    const { projectId, scenarioId } = req.params as { projectId: string; scenarioId: string };
    const { project } = await requireProject(req, projectId, 'scenario:write');
    const row = await app.svc.scenarios.getRow(scenarioId, project.id);
    return ok(reply, await app.svc.scenarios.update(req.ctx, project, row, parse(ScenarioUpdate, req.body)));
  });
  app.delete('/api/v1/projects/:projectId/scenarios/:scenarioId', async (req, reply) => {
    const { projectId, scenarioId } = req.params as { projectId: string; scenarioId: string };
    const { project } = await requireProject(req, projectId, 'scenario:delete');
    await app.svc.scenarios.remove(req.ctx, project, await app.svc.scenarios.getRow(scenarioId, project.id));
    return ok(reply, { deleted: true });
  });

  // ----- Suites -----
  app.get('/api/v1/projects/:projectId/suites', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'suite:read');
    return ok(reply, await app.svc.scenarios.suites(project.id));
  });
  app.post('/api/v1/projects/:projectId/suites', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'suite:write');
    return ok(reply, await app.svc.scenarios.createSuite(req.ctx, project, parse(SuiteCreate, req.body)), 201);
  });
  app.get('/api/v1/projects/:projectId/suites/:suiteId', async (req, reply) => {
    const { projectId, suiteId } = req.params as { projectId: string; suiteId: string };
    const { project } = await requireProject(req, projectId, 'suite:read');
    return ok(reply, await app.svc.scenarios.getSuite(suiteId, project.id));
  });
  app.patch('/api/v1/projects/:projectId/suites/:suiteId', async (req, reply) => {
    const { projectId, suiteId } = req.params as { projectId: string; suiteId: string };
    const { project } = await requireProject(req, projectId, 'suite:write');
    return ok(reply, await app.svc.scenarios.updateSuite(req.ctx, project, suiteId, parse(SuiteUpdate, req.body)));
  });
  app.delete('/api/v1/projects/:projectId/suites/:suiteId', async (req, reply) => {
    const { projectId, suiteId } = req.params as { projectId: string; suiteId: string };
    const { project } = await requireProject(req, projectId, 'suite:write');
    await app.svc.scenarios.deleteSuite(req.ctx, project, suiteId);
    return ok(reply, { deleted: true });
  });

  // ----- Test data profiles -----
  app.get('/api/v1/projects/:projectId/data-profiles', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:read');
    return ok(reply, await app.svc.scenarios.dataProfiles(project.id));
  });
  app.put('/api/v1/projects/:projectId/data-profiles', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:write');
    const body = parse(z.object({ id: z.string().optional(), name: z.string().min(1).max(100), kind: z.enum(['fixture', 'generated', 'seeded', 'disposable']), data: z.record(z.string(), z.unknown()), cleanup: z.array(z.unknown()).optional() }), req.body);
    return ok(reply, await app.svc.scenarios.putDataProfile(req.ctx, project, body), 201);
  });
}
