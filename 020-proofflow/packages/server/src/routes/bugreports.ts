import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BugReportSubmit, BugReportPreview, BugIntakeCreate } from '@proofflow/shared';
import { ok, parse, requireProject, rawBody } from '../http.js';
import { notFound, type Ctx } from '../context.js';

/** ProofFlow 不具合報告 routes (internal, authenticated) + external intake (per-project token, no login). */
export const INTAKE_TOKEN_HEADER = 'x-proofflow-intake-token';
const INTAKE_RATE = { rateLimit: { max: 30, timeWindow: '1 minute' } };

export async function bugReportRoutes(app: FastifyInstance) {
  const svc = () => app.svc.bugReports;
  const ct = (req: FastifyRequest) => (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();

  // ---------- internal ----------
  app.get('/api/v1/projects/:projectId/bug-reports', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'defect:read');
    const q = req.query as Record<string, string | undefined>;
    return ok(reply, await svc().list(project.id, { source: q.source, cursor: q.cursor, limit: q.limit ? Number(q.limit) : undefined }));
  });
  app.post('/api/v1/projects/:projectId/bug-reports/preview', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'defect:read');
    return ok(reply, await svc().preview(project, parse(BugReportPreview, req.body) as never, { withSimilar: true }));
  });
  app.put('/api/v1/projects/:projectId/bug-reports/attachments', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'defect:write');
    const q = parse(z.object({ fileName: z.string().min(1).max(300) }), req.query);
    return ok(reply, await svc().uploadAttachment(req.ctx, project, { fileName: q.fileName, contentType: ct(req), body: rawBody(req) }), 201);
  });
  app.post('/api/v1/projects/:projectId/bug-reports', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'defect:write');
    const r = await svc().submit(req.ctx, project, parse(BugReportSubmit, req.body) as never);
    return ok(reply, r, r.replayed ? 200 : 201);
  });
  app.get('/api/v1/projects/:projectId/bug-reports/:id', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'defect:read');
    return ok(reply, await svc().get(id, project.id));
  });
  app.get('/api/v1/projects/:projectId/bug-reports/:id/report', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'defect:read');
    const q = parse(z.object({ lang: z.enum(['ja', 'en']).default('ja') }), req.query);
    const r = await svc().getRow(id, project.id);
    return reply.header('content-disposition', `attachment; filename="${r.key}-${q.lang}.md"`).type('text/markdown; charset=utf-8').send(q.lang === 'ja' ? r.report_ja : r.report_en);
  });
  app.get('/api/v1/projects/:projectId/bug-intakes', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'defect:read');
    return ok(reply, await svc().listIntakes(project.id));
  });
  app.post('/api/v1/projects/:projectId/bug-intakes', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'project:write');
    return ok(reply, await svc().createIntake(req.ctx, project, parse(BugIntakeCreate, req.body)), 201);
  });
  app.delete('/api/v1/projects/:projectId/bug-intakes/:id', async (req, reply) => {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const { project } = await requireProject(req, projectId, 'project:write');
    await svc().revokeIntake(req.ctx, project, id);
    return ok(reply, { revoked: true });
  });

  // ---------- external intake (no login; per-intake token in a header) ----------
  async function intakeCtx(req: FastifyRequest) {
    const { intakeId } = req.params as { intakeId: string };
    const token = req.headers[INTAKE_TOKEN_HEADER];
    const { intake, actor } = await svc().resolveIntake(intakeId, typeof token === 'string' ? token : undefined);
    const project = await app.svc.projects.getRow(intake.project_id);
    if (project.archived_at) throw notFound('intake');
    const ctx: Ctx = { actor, ip: req.ip, requestId: req.id };
    return { intake, project, ctx };
  }
  app.get('/api/v1/intake/:intakeId', { config: INTAKE_RATE }, async (req, reply) => {
    const { intake, project } = await intakeCtx(req);
    return ok(reply, svc().intakePublicInfo(intake, project.name));
  });
  app.post('/api/v1/intake/:intakeId/preview', { config: INTAKE_RATE }, async (req, reply) => {
    const { project } = await intakeCtx(req);
    return ok(reply, await svc().preview(project, parse(BugReportPreview, req.body) as never, { withSimilar: false }));
  });
  app.put('/api/v1/intake/:intakeId/attachments', { config: INTAKE_RATE }, async (req, reply) => {
    const { intake, project, ctx } = await intakeCtx(req);
    const q = parse(z.object({ fileName: z.string().min(1).max(300) }), req.query);
    return ok(reply, await svc().uploadAttachment(ctx, project, { fileName: q.fileName, contentType: ct(req), body: rawBody(req), intake }), 201);
  });
  app.post('/api/v1/intake/:intakeId/bug-reports', { config: INTAKE_RATE }, async (req, reply) => {
    const { intake, project, ctx } = await intakeCtx(req);
    const body = parse(BugReportSubmit, req.body);
    // External reporters cannot pick severity / priority / RC / environment / target defect: the intake decides.
    const r = await svc().submit(ctx, project, { ...body, severity: undefined, priority: undefined, releaseCandidateId: undefined, environmentId: undefined, existingDefectId: undefined } as never, { intake });
    return ok(reply, r, r.replayed ? 200 : 201);
  });
}
