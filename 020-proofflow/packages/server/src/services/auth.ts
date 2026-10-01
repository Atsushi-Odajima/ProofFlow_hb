import type { Db } from '../db/db.js';
import { nowIso, asJson, asBool } from '../db/db.js';
import type { Config } from '../config.js';
import { hashPassword, verifyPassword, sha256, newApiToken } from '../crypto.js';
import { ulid, randomToken, type Role, ROLE_RANK } from '@proofflow/shared';
import { HttpError, badRequest, conflict, forbidden, unauthorized, type Actor, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';

export interface UserRow { id: string; email: string; name: string; password_hash: string | null; is_active: number; must_change_password: number; created_at: string; }
export interface TokenRow { id: string; org_id: string; user_id: string | null; name: string; kind: string; token_hash: string; token_prefix: string; role: Role; project_ids_json: string | null; expires_at: string | null; revoked_at: string | null; }

export class AuthService {
  constructor(private db: Db, private cfg: Config, private audit: AuditService) {}

  async signup(input: { email: string; password: string; name: string; organizationName: string }, ip: string) {
    const email = input.email.toLowerCase();
    const existing = await this.db.get(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existing) throw conflict('email already registered');
    const now = nowIso();
    const userId = ulid(); const orgId = ulid(); const wsId = ulid();
    const slug = await this.uniqueOrgSlug(input.organizationName);
    await this.db.tx(async (tx) => {
      await tx.run(`INSERT INTO users (id, email, name, password_hash, is_active, must_change_password, created_at, updated_at) VALUES (?,?,?,?,1,0,?,?)`, [userId, email, input.name, hashPassword(input.password), now, now]);
      await tx.run(`INSERT INTO organizations (id, name, slug, settings_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`, [orgId, input.organizationName, slug, JSON.stringify({ ai: { enabled: false, sendArtifacts: false } }), now, now]);
      await tx.run(`INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?,?,?,?)`, [orgId, userId, 'owner', now]);
      await tx.run(`INSERT INTO workspaces (id, org_id, name, slug, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`, [wsId, orgId, 'Default', 'default', 'Default workspace', now, now]);
      await this.audit.log({ orgId, actor: { kind: 'user', id: userId, name: input.name }, action: 'org.create', targetType: 'organization', targetId: orgId, ip }, tx);
    });
    return { userId, orgId, workspaceId: wsId };
  }

  private async uniqueOrgSlug(name: string): Promise<string> {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';
    let slug = base; let i = 1;
    while (await this.db.get(`SELECT 1 FROM organizations WHERE slug = ?`, [slug])) slug = `${base}-${++i}`;
    return slug;
  }

  async login(email: string, password: string, ip: string, userAgent?: string): Promise<{ sessionToken: string; user: UserRow }> {
    const user = await this.db.get<UserRow>(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase()]);
    if (!user || !asBool(user.is_active) || !verifyPassword(password, user.password_hash)) throw unauthorized('invalid credentials');
    const token = randomToken(32);
    const exp = new Date(Date.now() + this.cfg.sessionTtlHours * 3600_000).toISOString();
    await this.db.run(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)`, [ulid(), user.id, sha256(token), exp, nowIso(), ip, (userAgent ?? '').slice(0, 300)]);
    return { sessionToken: token, user };
  }

  async logout(sessionToken: string): Promise<void> { await this.db.run(`DELETE FROM sessions WHERE token_hash = ?`, [sha256(sessionToken)]); }

  async resolveSession(sessionToken: string): Promise<Actor | null> {
    const row = await this.db.get<{ user_id: string; expires_at: string; name: string; is_active: number }>(
      `SELECT s.user_id, s.expires_at, u.name, u.is_active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, [sha256(sessionToken)]);
    if (!row || row.expires_at < nowIso() || !asBool(row.is_active)) return null;
    return { kind: 'user', id: row.user_id, userId: row.user_id, name: row.name };
  }

  async resolveApiToken(token: string): Promise<Actor | null> {
    const row = await this.db.get<TokenRow & { user_name: string | null; user_active: number | null }>(
      `SELECT t.*, u.name AS user_name, u.is_active AS user_active FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`, [sha256(token)]);
    if (!row || row.revoked_at || (row.expires_at && row.expires_at < nowIso())) return null;
    if (row.user_id && row.user_active != null && !asBool(row.user_active)) return null;
    await this.db.run(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, [nowIso(), row.id]);
    const base = { id: row.id, name: row.user_name ? `${row.user_name} (${row.name})` : row.name, tokenOrgId: row.org_id, tokenRole: row.role, projectIds: asJson<string[] | null>(row.project_ids_json, null) };
    if (row.kind === 'runner') { const runner = await this.db.get<{ id: string }>(`SELECT id FROM runners WHERE token_id = ?`, [row.id]); return { kind: 'runner', ...base, runnerId: runner?.id }; }
    return { kind: 'token', ...base, userId: row.user_id ?? undefined };
  }

  /** Role of actor inside org, or null. Tokens are bound to one org; personal tokens follow the user's current membership. */
  async roleInOrg(actor: Actor, orgId: string): Promise<Role | null> {
    if (actor.kind === 'system') return 'owner';
    if (actor.kind === 'token' || actor.kind === 'runner') {
      if (actor.tokenOrgId !== orgId) return null;
      if (actor.userId) {
        const m = await this.db.get<{ role: Role }>(`SELECT role FROM org_members WHERE org_id = ? AND user_id = ?`, [orgId, actor.userId]);
        if (!m) return null;
        return ROLE_RANK[m.role] < ROLE_RANK[actor.tokenRole ?? 'viewer'] ? m.role : (actor.tokenRole ?? m.role);
      }
      return actor.tokenRole ?? null;
    }
    if (actor.kind === 'user' && actor.id) {
      const m = await this.db.get<{ role: Role }>(`SELECT role FROM org_members WHERE org_id = ? AND user_id = ?`, [orgId, actor.id]);
      return m?.role ?? null;
    }
    return null;
  }

  async createToken(ctx: Ctx, orgId: string, creatorRole: Role, input: { name: string; kind: 'personal' | 'service' | 'runner' | 'mcp'; role?: Role; expiresInDays?: number; projectIds?: string[] }) {
    const role: Role = input.kind === 'personal' ? creatorRole : (input.role ?? 'developer');
    if (ROLE_RANK[role] > ROLE_RANK[creatorRole]) throw forbidden('token role cannot exceed your role');
    if (input.kind === 'runner') { if (ROLE_RANK[creatorRole] < ROLE_RANK.admin) throw forbidden('runner tokens require admin'); }
    const { token, prefix } = newApiToken(input.kind);
    const id = ulid(); const now = nowIso();
    const exp = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000).toISOString() : null;
    await this.db.run(`INSERT INTO api_tokens (id, org_id, user_id, name, kind, token_hash, token_prefix, role, project_ids_json, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, orgId, input.kind === 'personal' ? (ctx.actor.userId ?? ctx.actor.id) : null, input.name, input.kind, sha256(token), prefix, input.kind === 'runner' ? 'tester' : role, input.projectIds ? JSON.stringify(input.projectIds) : null, exp, ctx.actor.id, now]);
    if (input.kind === 'runner') {
      await this.db.run(`INSERT INTO runners (id, org_id, name, token_id, capabilities_json, status, self_hosted, allow_private_network, created_at) VALUES (?,?,?,?,?,?,?,?,?)`, [ulid(), orgId, input.name, id, null, 'registered', 1, 0, now]);
    }
    await this.audit.log({ orgId, actor: ctx.actor, action: 'token.create', targetType: 'api_token', targetId: id, after: { name: input.name, kind: input.kind, role, prefix, expiresAt: exp }, ip: ctx.ip });
    return { id, token, prefix, role, expiresAt: exp };
  }

  async revokeToken(ctx: Ctx, orgId: string, tokenId: string) {
    const r = await this.db.run(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL`, [nowIso(), tokenId, orgId]);
    if (!r.changes) throw new HttpError(404, 'not_found', 'token not found');
    await this.audit.log({ orgId, actor: ctx.actor, action: 'token.revoke', targetType: 'api_token', targetId: tokenId, ip: ctx.ip });
  }

  async listTokens(orgId: string) {
    return this.db.all(`SELECT id, org_id, user_id, name, kind, token_prefix, role, project_ids_json, expires_at, last_used_at, created_by, created_at, revoked_at FROM api_tokens WHERE org_id = ? ORDER BY id DESC LIMIT 500`, [orgId]);
  }

  async changePassword(userId: string, current: string, next: string) {
    const u = await this.db.get<UserRow>(`SELECT * FROM users WHERE id = ?`, [userId]);
    if (!u || !verifyPassword(current, u.password_hash)) throw badRequest('current password incorrect');
    await this.db.run(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`, [hashPassword(next), nowIso(), userId]);
    await this.db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
  }
}
