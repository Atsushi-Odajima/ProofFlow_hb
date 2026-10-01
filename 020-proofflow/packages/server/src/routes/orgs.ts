import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MemberInvite, MemberRoleUpdate, WorkspaceCreate, ROLES } from '@proofflow/shared';
import { ok, parse, requireOrg } from '../http.js';

export async function orgRoutes(app: FastifyInstance) {
  app.get('/api/v1/orgs/:orgId', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const role = await requireOrg(req, orgId, 'org:read');
    return ok(reply, { ...(await app.svc.orgs.get(orgId)), role });
  });
  app.patch('/api/v1/orgs/:orgId', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'org:manage');
    const body = parse(z.object({ name: z.string().min(1).max(100).optional(), settings: z.record(z.string(), z.unknown()).optional() }), req.body);
    return ok(reply, await app.svc.orgs.update(req.ctx, orgId, body));
  });
  app.get('/api/v1/orgs/:orgId/members', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'org:read');
    return ok(reply, await app.svc.orgs.members(orgId));
  });
  app.post('/api/v1/orgs/:orgId/members', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const role = await requireOrg(req, orgId, 'org:members');
    const body = parse(MemberInvite, req.body);
    return ok(reply, await app.svc.orgs.addMember(req.ctx, orgId, role, body), 201);
  });
  app.patch('/api/v1/orgs/:orgId/members/:userId', async (req, reply) => {
    const { orgId, userId } = req.params as { orgId: string; userId: string };
    const role = await requireOrg(req, orgId, 'org:members');
    const body = parse(MemberRoleUpdate, req.body);
    if (!ROLES.includes(body.role)) throw new Error('bad role');
    await app.svc.orgs.updateRole(req.ctx, orgId, role, userId, body.role);
    return ok(reply, { updated: true });
  });
  app.delete('/api/v1/orgs/:orgId/members/:userId', async (req, reply) => {
    const { orgId, userId } = req.params as { orgId: string; userId: string };
    const role = await requireOrg(req, orgId, 'org:members');
    await app.svc.orgs.removeMember(req.ctx, orgId, role, userId);
    return ok(reply, { removed: true });
  });
  app.get('/api/v1/orgs/:orgId/workspaces', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'workspace:read');
    return ok(reply, await app.svc.orgs.workspaces(orgId));
  });
  app.post('/api/v1/orgs/:orgId/workspaces', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'workspace:write');
    return ok(reply, await app.svc.orgs.createWorkspace(req.ctx, orgId, parse(WorkspaceCreate, req.body)), 201);
  });
  app.get('/api/v1/orgs/:orgId/audit', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'audit:read');
    const q = req.query as Record<string, string | undefined>;
    return ok(reply, await app.svc.audit.list(orgId, { limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor, targetType: q.targetType, targetId: q.targetId, action: q.action, projectId: q.projectId }));
  });
}
