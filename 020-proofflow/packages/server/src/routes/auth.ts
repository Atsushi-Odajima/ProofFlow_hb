import type { FastifyInstance } from 'fastify';
import { SignupSchema, LoginSchema, TokenCreate, type Role } from '@proofflow/shared';
import { z } from 'zod';
import { ok, parse, requireOrg, userIdOf } from '../http.js';
import { unauthorized, badRequest } from '../context.js';

export const SESSION_COOKIE = 'pf_session';

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/signup', async (req, reply) => {
    const body = parse(SignupSchema, req.body);
    const r = await app.svc.auth.signup(body, req.ctx.ip);
    const { sessionToken } = await app.svc.auth.login(body.email, body.password, req.ctx.ip, req.headers['user-agent']);
    setSession(reply, sessionToken, app);
    return ok(reply, { userId: r.userId, organizationId: r.orgId, workspaceId: r.workspaceId }, 201);
  });
  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = parse(LoginSchema, req.body);
    const { sessionToken, user } = await app.svc.auth.login(body.email, body.password, req.ctx.ip, req.headers['user-agent']);
    setSession(reply, sessionToken, app);
    const orgs = await app.svc.orgs.listForUser(user.id);
    return ok(reply, { user: { id: user.id, email: user.email, name: user.name, mustChangePassword: user.must_change_password === 1 }, organizations: orgs });
  });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) await app.svc.auth.logout(t);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return ok(reply, { loggedOut: true });
  });
  app.get('/api/v1/auth/me', async (req, reply) => {
    const uid = userIdOf(req);
    if (req.ctx.actor.kind === 'anonymous') throw unauthorized();
    const orgs = uid ? await app.svc.orgs.listForUser(uid) : (req.ctx.actor.tokenOrgId ? [{ id: req.ctx.actor.tokenOrgId, role: req.ctx.actor.tokenRole as Role }] : []);
    return ok(reply, { actor: { kind: req.ctx.actor.kind, id: req.ctx.actor.id, userId: uid, name: req.ctx.actor.name }, organizations: orgs });
  });
  app.post('/api/v1/auth/change-password', async (req, reply) => {
    const uid = userIdOf(req); if (!uid || req.ctx.actor.kind !== 'user') throw unauthorized();
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string().min(10).max(200) }), req.body);
    await app.svc.auth.changePassword(uid, body.currentPassword, body.newPassword);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return ok(reply, { changed: true });
  });
  // API tokens (personal/service/mcp/runner) are organization-scoped.
  app.get('/api/v1/orgs/:orgId/tokens', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    await requireOrg(req, orgId, 'token:create_personal');
    return ok(reply, await app.svc.auth.listTokens(orgId));
  });
  app.post('/api/v1/orgs/:orgId/tokens', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const body = parse(TokenCreate, req.body);
    const role = await requireOrg(req, orgId, body.kind === 'personal' ? 'token:create_personal' : body.kind === 'runner' ? 'runner:manage' : 'token:create_service');
    if (req.ctx.actor.kind !== 'user') throw badRequest('tokens can only be created from an interactive session');
    return ok(reply, await app.svc.auth.createToken(req.ctx, orgId, role, body), 201);
  });
  app.delete('/api/v1/orgs/:orgId/tokens/:tokenId', async (req, reply) => {
    const { orgId, tokenId } = req.params as { orgId: string; tokenId: string };
    await requireOrg(req, orgId, 'token:create_personal');
    await app.svc.auth.revokeToken(req.ctx, orgId, tokenId);
    return ok(reply, { revoked: true });
  });
}

function setSession(reply: import('fastify').FastifyReply, token: string, app: FastifyInstance) {
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: app.svc.cfg.cookieSecure, maxAge: app.svc.cfg.sessionTtlHours * 3600 });
}
