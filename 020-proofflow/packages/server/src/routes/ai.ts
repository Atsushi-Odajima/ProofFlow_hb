import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AiDraftRequest } from '@proofflow/shared';
import { ok, parse, requireProject, requireOrg } from '../http.js';

export async function aiRoutes(app: FastifyInstance) {
  app.get('/api/v1/ai/status', async (_req, reply) => ok(reply, { provider: app.svc.ai.provider.name, enabled: app.svc.ai.enabled }));

  // Scenario drafts from a requirement or a free-text prompt. Output is a suggestion; nothing is created until applied.
  app.post('/api/v1/projects/:projectId/ai/scenario-draft', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'ai:use');
    const body = parse(AiDraftRequest, req.body);
    const input: Record<string, unknown> = { request: body.prompt, count: body.count, projectType: project.type };
    if (body.requirementId) { const r = await app.svc.requirements.get(body.requirementId, project.id); input.requirement = { key: r.key, title: r.title, description: r.description, acceptanceCriteria: r.acceptanceCriteria }; }
    if (body.targetUrl) input.targetUrl = body.targetUrl;
    return ok(reply, await app.svc.ai.run(req.ctx, project, 'scenario_draft', input, { targetType: body.requirementId ? 'requirement' : 'prompt', targetId: body.requirementId }), 201);
  });
  app.get('/api/v1/projects/:projectId/ai/suggestions', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'scenario:read');
    const q = req.query as Record<string, string | undefined>;
    return ok(reply, await app.svc.ai.list(project.id, { feature: q.feature, status: q.status, targetId: q.targetId, limit: q.limit ? Number(q.limit) : undefined }));
  });
  app.post('/api/v1/projects/:projectId/ai/suggestions/:id/apply', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'ai:apply');
    const body = parse(z.object({ indexes: z.array(z.number().int().min(0)).max(50).optional(), requirementIds: z.array(z.string()).max(50).optional() }).default({}), req.body ?? {});
    const s = await app.svc.ai.getRow(id, project.id);
    if (s.feature === 'scenario_draft') return ok(reply, await app.svc.ai.applyScenarioDraft(req.ctx, project, id, body));
    if (s.feature === 'defect_draft') return ok(reply, await app.svc.aiAssist.applyDefectDraft(req.ctx, project, id), 201);
    if (s.feature === 'selector_repair') { const c = parse(z.object({ candidateIndex: z.number().int().min(0).default(0) }), req.body ?? {}); return ok(reply, await app.svc.aiAssist.applySelectorRepair(req.ctx, project, id, c.candidateIndex)); }
    return reply.code(400).send({ error: { code: 'not_applicable', message: `apply is not supported for feature ${s.feature} via this endpoint` } });
  });
  app.post('/api/v1/projects/:projectId/ai/suggestions/:id/reject', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'ai:use');
    const body = parse(z.object({ reason: z.string().max(500).optional() }).default({}), req.body ?? {});
    await app.svc.ai.reject(req.ctx, project, id, body.reason);
    return ok(reply, { rejected: true });
  });
  // Failure assistance (read-only suggestions; results are never modified)
  for (const [path, feature] of [['failure-summary', 'failureSummary'], ['defect-draft', 'defectDraft'], ['selector-repair', 'selectorRepair']] as const) {
    app.post(`/api/v1/results/:resultId/ai/${path}`, async (req, reply) => {
      const { resultId } = req.params as { resultId: string };
      const r = await app.svc.runs.getResult(resultId);
      const { project } = await requireProject(req, r.project_id, 'ai:use');
      return ok(reply, await app.svc.aiAssist[feature](req.ctx, project, resultId), 201);
    });
  }
  app.get('/api/v1/orgs/:orgId/ai/usage', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'org:read');
    const q = req.query as { period?: string };
    return ok(reply, await app.svc.ai.usage(orgId, q.period));
  });
}
