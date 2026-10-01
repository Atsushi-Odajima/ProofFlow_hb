import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ScheduleCreate, ScheduleUpdate, DomainVerifyCreate } from '@proofflow/shared';
import { ok, parse, requireProject, requireOrg, userIdOf } from '../http.js';
import { unauthorized } from '../context.js';

export async function opsRoutes(app: FastifyInstance) {
  // Schedules
  app.get('/api/v1/projects/:projectId/schedules', async (req, reply) => { const { projectId } = req.params as { projectId: string }; const { project } = await requireProject(req, projectId, 'schedule:read'); return ok(reply, await app.svc.schedules.list(project.id)); });
  app.post('/api/v1/projects/:projectId/schedules', async (req, reply) => { const { projectId } = req.params as { projectId: string }; const { project } = await requireProject(req, projectId, 'schedule:write'); return ok(reply, await app.svc.schedules.create(req.ctx, project, parse(ScheduleCreate, req.body)), 201); });
  app.patch('/api/v1/projects/:projectId/schedules/:id', async (req, reply) => { const { projectId, id } = req.params as { projectId: string; id: string }; const { project } = await requireProject(req, projectId, 'schedule:write'); return ok(reply, await app.svc.schedules.update(req.ctx, project, id, parse(ScheduleUpdate, req.body))); });
  app.delete('/api/v1/projects/:projectId/schedules/:id', async (req, reply) => { const { projectId, id } = req.params as { projectId: string; id: string }; const { project } = await requireProject(req, projectId, 'schedule:write'); await app.svc.schedules.remove(req.ctx, project, id); return ok(reply, { deleted: true }); });
  app.post('/api/v1/orgs/:orgId/schedules/tick', async (req, reply) => { const { orgId } = req.params as { orgId: string }; await requireOrg(req, orgId, 'schedule:write'); return ok(reply, await app.svc.schedules.tick()); });
  // Notifications (in-app)
  app.get('/api/v1/orgs/:orgId/notifications', async (req, reply) => { const { orgId } = req.params as { orgId: string }; await requireOrg(req, orgId, 'org:read'); const uid = userIdOf(req); if (!uid) throw unauthorized(); const q = req.query as { unread?: string; limit?: string }; return ok(reply, await app.svc.notify.listForUser(orgId, uid, { unreadOnly: q.unread === 'true', limit: q.limit ? Number(q.limit) : undefined })); });
  app.post('/api/v1/orgs/:orgId/notifications/read', async (req, reply) => { const { orgId } = req.params as { orgId: string }; await requireOrg(req, orgId, 'org:read'); const uid = userIdOf(req); if (!uid) throw unauthorized(); const body = parse(z.object({ ids: z.union([z.array(z.string()).max(500), z.literal('all')]) }), req.body); await app.svc.notify.markRead(orgId, uid, body.ids); return ok(reply, { ok: true }); });
  app.get('/api/v1/orgs/:orgId/notification-channels', async (req, reply) => { const { orgId } = req.params as { orgId: string }; await requireOrg(req, orgId, 'notification:manage'); return ok(reply, await app.svc.notify.channels(orgId)); });
  app.post('/api/v1/orgs/:orgId/notification-channels', async (req, reply) => { const { orgId } = req.params as { orgId: string }; await requireOrg(req, orgId, 'notification:manage'); const body = parse(z.object({ projectId: z.string().optional(), type: z.enum(['webhook', 'slack', 'email']), name: z.string().min(1).max(100), config: z.record(z.string(), z.unknown()), events: z.array(z.string().max(60)).min(1).max(50) }), req.body); return ok(reply, await app.svc.notify.createChannel(req.ctx, orgId, body), 201); });
  app.delete('/api/v1/orgs/:orgId/notification-channels/:id', async (req, reply) => { const { orgId, id } = req.params as { orgId: string; id: string }; await requireOrg(req, orgId, 'notification:manage'); await app.svc.notify.deleteChannel(req.ctx, orgId, id); return ok(reply, { deleted: true }); });
  app.get('/api/v1/orgs/:orgId/notification-deliveries', async (req, reply) => { const { orgId } = req.params as { orgId: string }; await requireOrg(req, orgId, 'notification:manage'); return ok(reply, await app.svc.notify.deliveries(orgId)); });
  // Domain verification
  app.get('/api/v1/projects/:projectId/domains', async (req, reply) => { const { projectId } = req.params as { projectId: string }; const { project } = await requireProject(req, projectId, 'environment:read'); return ok(reply, await app.svc.domains.list(project.id)); });
  app.post('/api/v1/projects/:projectId/domains', async (req, reply) => { const { projectId } = req.params as { projectId: string }; const { project } = await requireProject(req, projectId, 'domain:verify'); return ok(reply, await app.svc.domains.start(req.ctx, project, parse(DomainVerifyCreate, req.body)), 201); });
  app.post('/api/v1/projects/:projectId/domains/:id/verify', async (req, reply) => { const { projectId, id } = req.params as { projectId: string; id: string }; const { project, role } = await requireProject(req, projectId, 'domain:verify'); return ok(reply, await app.svc.domains.verify(req.ctx, project, id, role)); });
}
