import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ManualCaseCreate, ManualCheckCreate, ExploratoryCreate, ExploratoryUpdate } from '@proofflow/shared';
import { ok, parse, requireProject, rawBody } from '../http.js';

export async function manualRoutes(app: FastifyInstance) {
  app.get('/api/v1/manual/checklist', async (_req, reply) => ok(reply, app.svc.manual.checklist()));
  app.get('/api/v1/projects/:projectId/manual-cases', async (req, reply) => { const { projectId } = req.params as { projectId: string }; const { project } = await requireProject(req, projectId, 'manual:read'); return ok(reply, await app.svc.manual.cases(project.id)); });
  app.post('/api/v1/projects/:projectId/manual-cases', async (req, reply) => { const { projectId } = req.params as { projectId: string }; const { project } = await requireProject(req, projectId, 'manual:write'); return ok(reply, await app.svc.manual.createCase(req.ctx, project, parse(ManualCaseCreate, req.body)), 201); });
  app.get('/api/v1/projects/:projectId/manual-checks', async (req, reply) => { const { projectId } = req.params as { projectId: string }; const { project } = await requireProject(req, projectId, 'manual:read'); const q = req.query as { releaseCandidateId?: string; limit?: string }; return ok(reply, await app.svc.manual.checks(project.id, { releaseCandidateId: q.releaseCandidateId, limit: q.limit ? Number(q.limit) : undefined })); });
  app.post('/api/v1/projects/:projectId/manual-checks', async (req, reply) => { const { projectId } = req.params as { projectId: string }; const { project } = await requireProject(req, projectId, 'manual:write'); return ok(reply, await app.svc.manual.recordCheck(req.ctx, project, parse(ManualCheckCreate, req.body)), 201); });
  app.put('/api/v1/projects/:projectId/manual-evidence', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'manual:write');
    const q = parse(z.object({ label: z.string().min(1).max(100) }), req.query);
    const ct = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim();
    return ok(reply, await app.svc.manual.uploadEvidence(req.ctx, project, q.label, ct, rawBody(req)), 201);
  });
  app.get('/api/v1/projects/:projectId/exploratory', async (req, reply) => { const { projectId } = req.params as { projectId: string }; const { project } = await requireProject(req, projectId, 'exploratory:read'); return ok(reply, await app.svc.manual.sessions(project.id)); });
  app.post('/api/v1/projects/:projectId/exploratory', async (req, reply) => { const { projectId } = req.params as { projectId: string }; const { project } = await requireProject(req, projectId, 'exploratory:write'); return ok(reply, await app.svc.manual.createSession(req.ctx, project, parse(ExploratoryCreate, req.body)), 201); });
  app.get('/api/v1/projects/:projectId/exploratory/:id', async (req, reply) => { const { projectId, id } = req.params as { projectId: string; id: string }; const { project } = await requireProject(req, projectId, 'exploratory:read'); return ok(reply, await app.svc.manual.getSession(id, project.id)); });
  app.patch('/api/v1/projects/:projectId/exploratory/:id', async (req, reply) => { const { projectId, id } = req.params as { projectId: string; id: string }; const { project } = await requireProject(req, projectId, 'exploratory:write'); return ok(reply, await app.svc.manual.updateSession(req.ctx, project, id, parse(ExploratoryUpdate, req.body))); });
  app.post('/api/v1/projects/:projectId/exploratory/:id/ai/organize', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'ai:use');
    const s = await app.svc.manual.getSession(id, project.id);
    const sug = await app.svc.ai.run(req.ctx, project, 'exploratory_notes', { charter: s.charter, notes: s.notes, durationMin: s.duration_min, defectIds: s.defectIds }, { targetType: 'exploratory_session', targetId: id });
    return ok(reply, sug, 201);
  });
}
