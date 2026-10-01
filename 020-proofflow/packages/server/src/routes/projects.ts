import type { FastifyInstance } from 'fastify';
import { ProjectCreate, ProjectUpdate, EnvironmentCreate, EnvironmentUpdate, SecretCreate } from '@proofflow/shared';
import { z } from 'zod';
import { HttpError } from '../context.js';
import { ok, parse, requireOrg, requireProject } from '../http.js';

export async function projectRoutes(app: FastifyInstance) {
  app.get('/api/v1/orgs/:orgId/projects', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'project:read');
    const q = req.query as { workspaceId?: string };
    let list = await app.svc.projects.list(orgId, q.workspaceId);
    if (req.ctx.actor.projectIds) list = list.filter((p) => req.ctx.actor.projectIds!.includes(p.id));
    return ok(reply, list);
  });
  app.post('/api/v1/orgs/:orgId/projects', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'project:write');
    const body = parse(ProjectCreate, req.body);
    const wsId = body.workspaceId ?? (await app.svc.orgs.defaultWorkspace(orgId));
    const ws = await app.svc.db.get(`SELECT 1 FROM workspaces WHERE id = ? AND org_id = ?`, [wsId, orgId]);
    if (!ws) throw new Error('workspace not in organization');
    return ok(reply, await app.svc.projects.create(req.ctx, orgId, wsId, { ...body, repositoryUrl: body.repositoryUrl || undefined }), 201);
  });
  app.get('/api/v1/projects/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project, role } = await requireProject(req, projectId, 'project:read');
    const { projectView } = await import('../services/projects.js');
    return ok(reply, { ...projectView(project), role, environments: await app.svc.projects.environments(project.id) });
  });
  app.patch('/api/v1/projects/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'project:write');
    return ok(reply, await app.svc.projects.update(req.ctx, project, parse(ProjectUpdate, req.body)));
  });
  app.delete('/api/v1/projects/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'project:delete');
    await app.svc.projects.archive(req.ctx, project);
    return ok(reply, { archived: true });
  });
  // Environments
  app.get('/api/v1/projects/:projectId/environments', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'environment:read');
    return ok(reply, await app.svc.projects.environments(project.id));
  });
  app.post('/api/v1/projects/:projectId/environments', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'environment:write');
    return ok(reply, await app.svc.projects.createEnvironment(req.ctx, project, parse(EnvironmentCreate, req.body)), 201);
  });
  app.patch('/api/v1/projects/:projectId/environments/:envId', async (req, reply) => {
    const { projectId, envId } = req.params as { projectId: string; envId: string };
    const { project } = await requireProject(req, projectId, 'environment:write');
    const env = await app.svc.projects.getEnvironmentRow(envId, project.id);
    const body = parse(EnvironmentUpdate.extend({ confirmProductionDestructive: z.boolean().optional() }), req.body);
    if (body.destructivePolicy === 'allow' && env.kind === 'production') {
      // Enabling destructive tests on production is a human decision: QA Lead+ with run:trigger_destructive, never an API/service/MCP token.
      await requireProject(req, projectId, 'run:trigger_destructive');
      if (req.ctx.actor.kind !== 'user') throw new HttpError(403, 'human_required', 'enabling destructive tests on production requires a human user session (not an API token)');
    }
    return ok(reply, await app.svc.projects.updateEnvironment(req.ctx, project, env, body));
  });
  app.delete('/api/v1/projects/:projectId/environments/:envId', async (req, reply) => {
    const { projectId, envId } = req.params as { projectId: string; envId: string };
    const { project } = await requireProject(req, projectId, 'environment:write');
    await app.svc.projects.deleteEnvironment(req.ctx, project, await app.svc.projects.getEnvironmentRow(envId, project.id));
    return ok(reply, { deleted: true });
  });
  // Secrets: metadata only is ever returned.
  app.get('/api/v1/projects/:projectId/secrets', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'secret:read_meta');
    return ok(reply, await app.svc.projects.listSecrets(project.id));
  });
  app.put('/api/v1/projects/:projectId/secrets', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const { project } = await requireProject(req, projectId, 'secret:write');
    return ok(reply, await app.svc.projects.putSecret(req.ctx, project, parse(SecretCreate, req.body)), 201);
  });
  app.delete('/api/v1/projects/:projectId/secrets/:secretId', async (req, reply) => {
    const { projectId, secretId } = req.params as { projectId: string; secretId: string };
    const { project } = await requireProject(req, projectId, 'secret:write');
    await app.svc.projects.deleteSecret(req.ctx, project, secretId);
    return ok(reply, { deleted: true });
  });
}
