import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DefectCreate, DefectUpdate, MatrixSchema, roleHas } from '@proofflow/shared';
import { ok, parse, requireProject } from '../http.js';

export async function defectRoutes(app: FastifyInstance) {
  app.get('/api/v1/projects/:projectId/failure-groups', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'defect:read');
    const q = req.query as { withoutDefect?: string; limit?: string };
    return ok(reply, await app.svc.defects.groups(project.id, { withoutDefect: q.withoutDefect === 'true', limit: q.limit ? Number(q.limit) : undefined }));
  });
  app.get('/api/v1/projects/:projectId/failure-groups/:id', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'defect:read');
    return ok(reply, await app.svc.defects.group(project.id, id));
  });
  app.get('/api/v1/projects/:projectId/failure-groups/:id/similar', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'defect:read');
    return ok(reply, await app.svc.defects.similar(project.id, id));
  });
  app.get('/api/v1/projects/:projectId/flaky', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'run:read');
    return ok(reply, await app.svc.defects.flakyCandidates(project.id));
  });
  app.get('/api/v1/projects/:projectId/defects', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'defect:read');
    const q = req.query as Record<string, string | undefined>;
    return ok(reply, await app.svc.defects.list(project.id, { status: q.status, severity: q.severity, assignee: q.assignee, q: q.q, limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor }));
  });
  app.post('/api/v1/projects/:projectId/defects', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'defect:write');
    return ok(reply, await app.svc.defects.create(req.ctx, project, parse(DefectCreate, req.body)), 201);
  });
  app.post('/api/v1/projects/:projectId/defects/from-result', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'defect:write');
    const body = parse(z.object({ resultId: z.string(), title: z.string().max(300).optional(), severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(), assigneeUserId: z.string().optional() }), req.body);
    return ok(reply, await app.svc.defects.createFromResult(req.ctx, project, body.resultId, body), 201);
  });
  app.get('/api/v1/projects/:projectId/defects/:id', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'defect:read');
    return ok(reply, await app.svc.defects.get(id, project.id));
  });
  app.patch('/api/v1/projects/:projectId/defects/:id', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const body = parse(DefectUpdate, req.body);
    const perm = body.status === 'closed' || body.status === 'wont_fix' ? 'defect:close' : 'defect:write';
    const { project } = await requireProject(req, projectId, perm);
    const d = await app.svc.defects.getRow(id, project.id);
    return ok(reply, await app.svc.defects.update(req.ctx, project, d, body));
  });
  app.post('/api/v1/projects/:projectId/defects/:id/retest', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project, role } = await requireProject(req, projectId, 'run:trigger');
    const body = parse(z.object({ environmentId: z.string().optional(), matrix: MatrixSchema.partial().optional() }).default({}), req.body ?? {});
    const d = await app.svc.defects.getRow(id, project.id);
    return ok(reply, await app.svc.defects.retest(req.ctx, project, d, body, roleHas(role, 'run:trigger_destructive')), 202);
  });
  /** Re-run only the failed scenarios of a run (for AI coding agents after a fix). The full required suites still gate releases. */
  app.post('/api/v1/runs/:runId/retest-failed', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = await app.svc.runs.getRow(runId);
    const { project, role } = await requireProject(req, run.project_id, 'run:trigger');
    const body = parse(z.object({ commitSha: z.string().max(64).optional(), branch: z.string().max(200).optional(), label: z.string().max(200).optional() }).default({}), req.body ?? {});
    const failed = await app.svc.db.all<{ scenario_id: string }>(`SELECT DISTINCT scenario_id FROM test_results WHERE run_id = ? AND status IN ('failed','flaky','infra_error')`, [run.id]);
    if (failed.length === 0) return reply.code(400).send({ error: { code: 'nothing_to_retest', message: 'run has no failed results' } });
    const { asJson } = await import('../db/db.js');
    const r = await app.svc.runs.create(req.ctx, project, { environmentId: run.environment_id, scenarioIds: failed.map((f) => f.scenario_id), matrix: asJson(run.matrix_json, undefined), trigger: 'agent', parentRunId: run.id, kind: 'retest', label: body.label ?? `Retest failed of ${run.id}`, commitSha: body.commitSha, branch: body.branch }, { canRunDestructive: roleHas(role, 'run:trigger_destructive') });
    return ok(reply, r.run, 202);
  });
}
