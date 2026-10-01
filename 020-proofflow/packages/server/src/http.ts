import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { Permission, Role } from '@proofflow/shared';
import { assertPermission, badRequest, forbidden, notFound, unauthorized, type Ctx } from './context.js';
import type { Services } from './services/index.js';
import type { ProjectRow } from './services/projects.js';

declare module 'fastify' {
  interface FastifyRequest { ctx: Ctx; }
  interface FastifyInstance { svc: Services; }
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}
export function ok(reply: FastifyReply, data: unknown, status = 200) { return reply.code(status).send({ data }); }

/** Authorize an actor for an organization and permission. Returns the effective role. */
export async function requireOrg(req: FastifyRequest, orgId: string, perm: Permission): Promise<Role> {
  const { actor } = req.ctx;
  if (actor.kind === 'anonymous') throw unauthorized();
  const role = await req.server.svc.auth.roleInOrg(actor, orgId);
  if (!role) throw forbidden('not a member of this organization');
  assertPermission(role, perm);
  return role;
}
/** Load a project and authorize in one step. Cross-tenant ids are 404 (no leak). Service tokens may be restricted to project ids. */
export async function requireProject(req: FastifyRequest, projectId: string, perm: Permission): Promise<{ project: ProjectRow; role: Role }> {
  const { actor } = req.ctx;
  if (actor.kind === 'anonymous') throw unauthorized();
  const project = await req.server.svc.projects.getRow(projectId);
  const role = await req.server.svc.auth.roleInOrg(actor, project.org_id);
  if (!role) throw notFound('project');
  if (actor.projectIds && !actor.projectIds.includes(project.id)) throw notFound('project');
  assertPermission(role, perm);
  return { project, role };
}
export function userIdOf(req: FastifyRequest): string | null { return req.ctx.actor.userId ?? (req.ctx.actor.kind === 'user' ? req.ctx.actor.id : null); }

/** Body for artifact/fixture uploads: streams and buffers pass through; JSON-parsed bodies (application/json) are re-serialized. */
export function rawBody(req: FastifyRequest): import('node:stream').Readable | Buffer {
  const b = req.body as unknown;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b);
  if (b && typeof (b as { pipe?: unknown }).pipe === 'function') return b as import('node:stream').Readable;
  if (b === undefined || b === null) return Buffer.alloc(0);
  return Buffer.from(JSON.stringify(b));
}
