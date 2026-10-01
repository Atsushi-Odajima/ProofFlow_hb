import type { Db } from '../db/db.js';
import { nowIso, asJson } from '../db/db.js';
import { ulid, type Role, ROLE_RANK, randomToken } from '@proofflow/shared';
import { hashPassword, sha256 } from '../crypto.js';
import { badRequest, conflict, forbidden, notFound, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';

export class OrgService {
  constructor(private db: Db, private audit: AuditService) {}

  async get(orgId: string) {
    const o = await this.db.get<{ id: string; name: string; slug: string; settings_json: string | null; created_at: string }>(`SELECT * FROM organizations WHERE id = ?`, [orgId]);
    if (!o) throw notFound('organization');
    return { id: o.id, name: o.name, slug: o.slug, settings: asJson<Record<string, unknown>>(o.settings_json, {}), createdAt: o.created_at };
  }
  async listForUser(userId: string) {
    return this.db.all<{ id: string; name: string; slug: string; role: Role }>(`SELECT o.id, o.name, o.slug, m.role FROM organizations o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.name`, [userId]);
  }
  async update(ctx: Ctx, orgId: string, patch: { name?: string; settings?: Record<string, unknown> }) {
    const before = await this.get(orgId);
    const settings = patch.settings ? { ...before.settings, ...patch.settings } : before.settings;
    await this.db.run(`UPDATE organizations SET name = ?, settings_json = ?, updated_at = ? WHERE id = ?`, [patch.name ?? before.name, JSON.stringify(settings), nowIso(), orgId]);
    await this.audit.log({ orgId, actor: ctx.actor, action: 'org.update', targetType: 'organization', targetId: orgId, before: { name: before.name, settings: before.settings }, after: { name: patch.name ?? before.name, settings }, ip: ctx.ip });
    return this.get(orgId);
  }

  async members(orgId: string) {
    return this.db.all(`SELECT u.id, u.email, u.name, m.role, m.created_at, u.is_active FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at`, [orgId]);
  }
  /** Add a member: existing user by email, or create a user with a temporary password. Invitation emails are an adapter (Pro). */
  async addMember(ctx: Ctx, orgId: string, actorRole: Role, input: { email: string; role: Role; name?: string; temporaryPassword?: string }) {
    if (ROLE_RANK[input.role] > ROLE_RANK[actorRole]) throw forbidden('cannot grant a role above your own');
    if (input.role === 'owner' && actorRole !== 'owner') throw forbidden('only owners can add owners');
    const email = input.email.toLowerCase();
    let user = await this.db.get<{ id: string }>(`SELECT id FROM users WHERE email = ?`, [email]);
    const now = nowIso();
    let temporaryPassword: string | undefined;
    if (!user) {
      temporaryPassword = input.temporaryPassword ?? randomToken(12);
      const id = ulid();
      await this.db.run(`INSERT INTO users (id, email, name, password_hash, is_active, must_change_password, created_at, updated_at) VALUES (?,?,?,?,1,1,?,?)`, [id, email, input.name ?? email.split('@')[0] ?? 'user', hashPassword(temporaryPassword), now, now]);
      user = { id };
    }
    const exists = await this.db.get(`SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?`, [orgId, user.id]);
    if (exists) throw conflict('already a member');
    await this.db.run(`INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?,?,?,?)`, [orgId, user.id, input.role, now]);
    await this.audit.log({ orgId, actor: ctx.actor, action: 'member.add', targetType: 'user', targetId: user.id, after: { email, role: input.role }, ip: ctx.ip });
    return { userId: user.id, email, role: input.role, temporaryPassword };
  }
  async updateRole(ctx: Ctx, orgId: string, actorRole: Role, userId: string, role: Role) {
    const m = await this.db.get<{ role: Role }>(`SELECT role FROM org_members WHERE org_id = ? AND user_id = ?`, [orgId, userId]);
    if (!m) throw notFound('member');
    if (ROLE_RANK[role] > ROLE_RANK[actorRole] || ROLE_RANK[m.role] > ROLE_RANK[actorRole]) throw forbidden('cannot change roles above your own');
    if (m.role === 'owner' && role !== 'owner') {
      const owners = await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM org_members WHERE org_id = ? AND role = 'owner'`, [orgId]);
      if (Number(owners?.c ?? 0) <= 1) throw badRequest('organization needs at least one owner');
    }
    await this.db.run(`UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?`, [role, orgId, userId]);
    await this.audit.log({ orgId, actor: ctx.actor, action: 'member.role_change', targetType: 'user', targetId: userId, before: { role: m.role }, after: { role }, ip: ctx.ip });
  }
  async removeMember(ctx: Ctx, orgId: string, actorRole: Role, userId: string) {
    const m = await this.db.get<{ role: Role }>(`SELECT role FROM org_members WHERE org_id = ? AND user_id = ?`, [orgId, userId]);
    if (!m) throw notFound('member');
    if (ROLE_RANK[m.role] > ROLE_RANK[actorRole]) throw forbidden('cannot remove a member above your role');
    if (m.role === 'owner') { const owners = await this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM org_members WHERE org_id = ? AND role = 'owner'`, [orgId]); if (Number(owners?.c ?? 0) <= 1) throw badRequest('organization needs at least one owner'); }
    await this.db.run(`DELETE FROM org_members WHERE org_id = ? AND user_id = ?`, [orgId, userId]);
    await this.db.run(`UPDATE api_tokens SET revoked_at = ? WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL`, [nowIso(), orgId, userId]);
    await this.audit.log({ orgId, actor: ctx.actor, action: 'member.remove', targetType: 'user', targetId: userId, before: { role: m.role }, ip: ctx.ip });
  }

  async workspaces(orgId: string) { return this.db.all(`SELECT * FROM workspaces WHERE org_id = ? ORDER BY created_at`, [orgId]); }
  async createWorkspace(ctx: Ctx, orgId: string, input: { name: string; slug?: string; description?: string }) {
    const id = ulid(); const now = nowIso();
    const slug = input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (await this.db.get(`SELECT 1 FROM workspaces WHERE org_id = ? AND slug = ?`, [orgId, slug])) throw conflict('workspace slug exists');
    await this.db.run(`INSERT INTO workspaces (id, org_id, name, slug, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`, [id, orgId, input.name, slug, input.description ?? null, now, now]);
    await this.audit.log({ orgId, actor: ctx.actor, action: 'workspace.create', targetType: 'workspace', targetId: id, after: { name: input.name, slug }, ip: ctx.ip });
    return this.db.get(`SELECT * FROM workspaces WHERE id = ?`, [id]);
  }
  async defaultWorkspace(orgId: string): Promise<string> {
    const w = await this.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE org_id = ? ORDER BY created_at LIMIT 1`, [orgId]);
    if (w) return w.id;
    const id = ulid(); const now = nowIso();
    await this.db.run(`INSERT INTO workspaces (id, org_id, name, slug, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`, [id, orgId, 'Default', 'default', null, now, now]);
    return id;
  }
  async sha(s: string) { return sha256(s); }
}
