import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RCCreate, RCUpdate, AcceptedRiskCreate } from '@proofflow/shared';
import { ok, parse, requireProject } from '../http.js';

export async function releaseRoutes(app: FastifyInstance) {
  app.get('/api/v1/projects/:projectId/releases', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'release:read');
    return ok(reply, await app.svc.release.list(project.id));
  });
  app.post('/api/v1/projects/:projectId/releases', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'release:write');
    return ok(reply, await app.svc.release.create(req.ctx, project, parse(RCCreate, req.body)), 201);
  });
  app.get('/api/v1/projects/:projectId/releases/:rcId', async (req, reply) => {
    const { projectId, rcId } = req.params as { projectId: string; rcId: string };
    const { project } = await requireProject(req, projectId, 'release:read');
    const rc = await app.svc.release.getRow(rcId, project.id);
    const { rcView } = await import('../services/release.js');
    return ok(reply, { ...rcView(rc), runs: await app.svc.release.runsOf(rc.id), evaluations: await app.svc.release.evaluations(rc.id), acceptedRisks: await app.svc.release.risks(rc.id), reports: await app.svc.release.reports(rc.id) });
  });
  app.patch('/api/v1/projects/:projectId/releases/:rcId', async (req, reply) => {
    const { projectId, rcId } = req.params as { projectId: string; rcId: string };
    const { project } = await requireProject(req, projectId, 'release:approve'); // gate rule changes are a privileged operation
    const rc = await app.svc.release.getRow(rcId, project.id);
    return ok(reply, await app.svc.release.update(req.ctx, project, rc, parse(RCUpdate, req.body)));
  });
  app.post('/api/v1/projects/:projectId/releases/:rcId/evaluate', async (req, reply) => {
    const { projectId, rcId } = req.params as { projectId: string; rcId: string };
    const { project } = await requireProject(req, projectId, 'release:read');
    const rc = await app.svc.release.getRow(rcId, project.id);
    return ok(reply, await app.svc.release.evaluate(req.ctx, project, rc));
  });
  app.post('/api/v1/projects/:projectId/releases/:rcId/accepted-risks', async (req, reply) => {
    const { projectId, rcId } = req.params as { projectId: string; rcId: string };
    const { project } = await requireProject(req, projectId, 'release:accept_risk');
    const rc = await app.svc.release.getRow(rcId, project.id);
    return ok(reply, await app.svc.release.acceptRisk(req.ctx, project, rc, parse(AcceptedRiskCreate, req.body)), 201);
  });
  app.delete('/api/v1/projects/:projectId/releases/:rcId/accepted-risks/:defectId', async (req, reply) => {
    const { projectId, rcId, defectId } = req.params as { projectId: string; rcId: string; defectId: string };
    const { project } = await requireProject(req, projectId, 'release:accept_risk');
    const rc = await app.svc.release.getRow(rcId, project.id);
    await app.svc.release.revokeRisk(req.ctx, project, rc, defectId);
    return ok(reply, { revoked: true });
  });
  app.post('/api/v1/projects/:projectId/releases/:rcId/release', async (req, reply) => {
    const { projectId, rcId } = req.params as { projectId: string; rcId: string };
    const { project } = await requireProject(req, projectId, 'release:approve');
    const rc = await app.svc.release.getRow(rcId, project.id);
    const body = parse(z.object({ note: z.string().max(1000).optional() }).default({}), req.body ?? {});
    return ok(reply, await app.svc.release.release(req.ctx, project, rc, body.note));
  });
  app.post('/api/v1/projects/:projectId/releases/:rcId/report', async (req, reply) => {
    const { projectId, rcId } = req.params as { projectId: string; rcId: string };
    const { project } = await requireProject(req, projectId, 'release:write');
    const rc = await app.svc.release.getRow(rcId, project.id);
    const body = parse(z.object({ format: z.enum(['html', 'pdf']).default('html') }), req.body ?? {});
    const r = await app.svc.release.generateReport(req.ctx, project, rc, body.format);
    return ok(reply, { id: r.id, format: r.format, artifactId: r.artifactId, checksum: r.checksum, summary: r.summary }, 201);
  });
  app.get('/api/v1/projects/:projectId/releases/:rcId/report-preview', async (req, reply) => {
    const { projectId, rcId } = req.params as { projectId: string; rcId: string };
    const { project } = await requireProject(req, projectId, 'release:read');
    const rc = await app.svc.release.getRow(rcId, project.id);
    return reply.type('text/html; charset=utf-8').send(app.svc.release.renderHtml(await app.svc.release.buildReportData(project, rc)));
  });
  app.get('/api/v1/projects/:projectId/dashboard', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'project:read');
    return ok(reply, await app.svc.release.dashboard(project));
  });
}
