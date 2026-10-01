import type { Db } from '../db/db.js';
import { nowIso, asJson, asBool, toJson } from '../db/db.js';
import { ulid, checkTargetUrl, type EnvironmentKind } from '@proofflow/shared';
import type { Config } from '../config.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { badRequest, conflict, notFound, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';

export interface ProjectRow { id: string; org_id: string; workspace_id: string; name: string; slug: string; description: string | null; type: string; repository_url: string | null; default_environment_id: string | null; timezone: string; owners_json: string | null; tags_json: string | null; settings_json: string | null; seq_counters_json: string | null; created_at: string; updated_at: string; archived_at: string | null; }
export interface EnvironmentRow { id: string; org_id: string; project_id: string; name: string; kind: EnvironmentKind; base_url: string; api_base_url: string | null; destructive_policy: 'deny' | 'allow'; test_data_policy: string; auth_profile_json: string | null; allow_private_network: number; allowed_hosts_json: string | null; privacy_json: string | null; noise_rules_json: string | null; domain_verified: number; created_at: string; updated_at: string; }

export function projectView(p: ProjectRow) {
  return { id: p.id, orgId: p.org_id, workspaceId: p.workspace_id, name: p.name, slug: p.slug, description: p.description, type: p.type, repositoryUrl: p.repository_url, defaultEnvironmentId: p.default_environment_id, timezone: p.timezone, ownerUserIds: asJson<string[]>(p.owners_json, []), tags: asJson<string[]>(p.tags_json, []), settings: asJson<Record<string, unknown>>(p.settings_json, {}), createdAt: p.created_at, updatedAt: p.updated_at, archivedAt: p.archived_at };
}
export function environmentView(e: EnvironmentRow) {
  const privacy = asJson<Record<string, unknown>>(e.privacy_json, {});
  const noise = asJson<Record<string, unknown>>(e.noise_rules_json, {});
  return { id: e.id, orgId: e.org_id, projectId: e.project_id, name: e.name, kind: e.kind, baseUrl: e.base_url, apiBaseUrl: e.api_base_url, destructivePolicy: e.destructive_policy, testDataPolicy: e.test_data_policy, authProfile: asJson<Record<string, unknown>>(e.auth_profile_json, { kind: 'none' }), allowPrivateNetwork: asBool(e.allow_private_network), allowedHosts: asJson<string[]>(e.allowed_hosts_json, []), maskSelectors: (privacy.maskSelectors as string[]) ?? [], redactHeaders: (privacy.redactHeaders as string[]) ?? [], captureBodies: !!privacy.captureBodies, consoleIgnorePatterns: (noise.consoleIgnorePatterns as string[]) ?? [], networkIgnorePatterns: (noise.networkIgnorePatterns as string[]) ?? [], domainVerified: asBool(e.domain_verified), createdAt: e.created_at, updatedAt: e.updated_at };
}

export class ProjectService {
  constructor(private db: Db, private cfg: Config, private audit: AuditService) {}

  async list(orgId: string, workspaceId?: string) {
    const rows = workspaceId ? await this.db.all<ProjectRow>(`SELECT * FROM projects WHERE org_id = ? AND workspace_id = ? AND archived_at IS NULL ORDER BY name`, [orgId, workspaceId]) : await this.db.all<ProjectRow>(`SELECT * FROM projects WHERE org_id = ? AND archived_at IS NULL ORDER BY name`, [orgId]);
    return rows.map(projectView);
  }
  /** Loads a project by id. Tenant isolation: the caller passes the org it is authorized for; mismatches are 404 (no existence leak). */
  async getRow(projectId: string, orgId?: string): Promise<ProjectRow> {
    const p = await this.db.get<ProjectRow>(`SELECT * FROM projects WHERE id = ?`, [projectId]);
    if (!p || (orgId && p.org_id !== orgId)) throw notFound('project');
    return p;
  }
  async create(ctx: Ctx, orgId: string, workspaceId: string, input: { name: string; slug?: string; description?: string; type: string; repositoryUrl?: string; timezone: string; ownerUserIds?: string[]; tags?: string[] }) {
    const id = ulid(); const now = nowIso();
    const slug = input.slug ?? (input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project');
    if (await this.db.get(`SELECT 1 FROM projects WHERE org_id = ? AND slug = ?`, [orgId, slug])) throw conflict('project slug exists');
    const owners = input.ownerUserIds ?? (ctx.actor.userId ? [ctx.actor.userId] : ctx.actor.kind === 'user' && ctx.actor.id ? [ctx.actor.id] : []);
    await this.db.run(`INSERT INTO projects (id, org_id, workspace_id, name, slug, description, type, repository_url, default_environment_id, timezone, owners_json, tags_json, settings_json, seq_counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)`,
      [id, orgId, workspaceId, input.name, slug, input.description ?? null, input.type, input.repositoryUrl || null, input.timezone, JSON.stringify(owners), JSON.stringify(input.tags ?? []), JSON.stringify({}), JSON.stringify({}), now, now]);
    await this.audit.log({ orgId, actor: ctx.actor, action: 'project.create', targetType: 'project', targetId: id, projectId: id, after: { name: input.name, slug, type: input.type }, ip: ctx.ip });
    return projectView(await this.getRow(id));
  }
  async update(ctx: Ctx, p: ProjectRow, patch: Record<string, unknown>) {
    const before = projectView(p);
    const next = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as typeof before & { settings?: Record<string, unknown> };
    if (patch.settings) next.settings = { ...before.settings, ...(patch.settings as Record<string, unknown>) };
    if (next.defaultEnvironmentId) { const e = await this.db.get(`SELECT 1 FROM environments WHERE id = ? AND project_id = ?`, [next.defaultEnvironmentId, p.id]); if (!e) throw badRequest('default environment must belong to project'); }
    await this.db.run(`UPDATE projects SET name = ?, description = ?, type = ?, repository_url = ?, default_environment_id = ?, timezone = ?, owners_json = ?, tags_json = ?, settings_json = ?, updated_at = ? WHERE id = ?`,
      [next.name, next.description ?? null, next.type, next.repositoryUrl || null, next.defaultEnvironmentId ?? null, next.timezone, JSON.stringify(next.ownerUserIds ?? []), JSON.stringify(next.tags ?? []), JSON.stringify(next.settings ?? {}), nowIso(), p.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'project.update', targetType: 'project', targetId: p.id, projectId: p.id, before: { name: before.name, settings: before.settings, defaultEnvironmentId: before.defaultEnvironmentId }, after: { name: next.name, settings: next.settings, defaultEnvironmentId: next.defaultEnvironmentId }, ip: ctx.ip });
    return projectView(await this.getRow(p.id));
  }
  async archive(ctx: Ctx, p: ProjectRow) {
    await this.db.run(`UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), p.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'project.archive', targetType: 'project', targetId: p.id, projectId: p.id, ip: ctx.ip });
  }
  /** Per-project human-readable keys (REQ-1, SCN-1, DEF-1, MC-1). Serialized through a transaction on the project row. */
  async nextKey(db: Db, projectId: string, prefix: string): Promise<string> {
    return db.tx(async (tx) => {
      const p = await tx.get<{ seq_counters_json: string | null }>(`SELECT seq_counters_json FROM projects WHERE id = ?`, [projectId]);
      const counters = asJson<Record<string, number>>(p?.seq_counters_json, {});
      const n = (counters[prefix] ?? 0) + 1; counters[prefix] = n;
      await tx.run(`UPDATE projects SET seq_counters_json = ? WHERE id = ?`, [JSON.stringify(counters), projectId]);
      return `${prefix}-${n}`;
    });
  }

  // ---------- Environments ----------
  async environments(projectId: string) { return (await this.db.all<EnvironmentRow>(`SELECT * FROM environments WHERE project_id = ? ORDER BY created_at`, [projectId])).map(environmentView); }
  async getEnvironmentRow(envId: string, projectId?: string): Promise<EnvironmentRow> {
    const e = await this.db.get<EnvironmentRow>(`SELECT * FROM environments WHERE id = ?`, [envId]);
    if (!e || (projectId && e.project_id !== projectId)) throw notFound('environment');
    return e;
  }
  async createEnvironment(ctx: Ctx, p: ProjectRow, input: Record<string, unknown>) {
    const kind = input.kind as EnvironmentKind;
    const allowPrivate = !!input.allowPrivateNetwork && kind === 'local';
    const policy = checkTargetUrl(String(input.baseUrl), { allowPrivateNetwork: allowPrivate || this.cfg.allowPrivateTargetsGlobally });
    if (!policy.allowed) throw badRequest(`baseUrl rejected by target policy: ${policy.reason}`, { reason: policy.reason, hint: kind === 'local' ? 'set allowPrivateNetwork=true for a local environment run by a self-hosted runner' : 'private/localhost targets need a local environment with a self-hosted runner' });
    // Production: destructive actions are denied by default and only changeable explicitly by a privileged role.
    const destructive = kind === 'production' ? 'deny' : ((input.destructivePolicy as string) ?? 'allow');
    const id = ulid(); const now = nowIso();
    await this.db.run(`INSERT INTO environments (id, org_id, project_id, name, kind, base_url, api_base_url, destructive_policy, test_data_policy, auth_profile_json, allow_private_network, allowed_hosts_json, privacy_json, noise_rules_json, domain_verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      [id, p.org_id, p.id, String(input.name), kind, String(input.baseUrl), (input.apiBaseUrl as string) || null, destructive, (input.testDataPolicy as string) ?? 'fixture', toJson(input.authProfile ?? { kind: 'none' }), allowPrivate ? 1 : 0, toJson(input.allowedHosts ?? []), toJson({ maskSelectors: input.maskSelectors ?? [], redactHeaders: input.redactHeaders ?? [], captureBodies: !!input.captureBodies }), toJson({ consoleIgnorePatterns: input.consoleIgnorePatterns ?? [], networkIgnorePatterns: input.networkIgnorePatterns ?? [] }), now, now]);
    if (!p.default_environment_id) await this.db.run(`UPDATE projects SET default_environment_id = ? WHERE id = ?`, [id, p.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'environment.create', targetType: 'environment', targetId: id, projectId: p.id, after: { name: input.name, kind, baseUrl: input.baseUrl, destructivePolicy: destructive }, ip: ctx.ip });
    return environmentView(await this.getEnvironmentRow(id));
  }
  async updateEnvironment(ctx: Ctx, p: ProjectRow, e: EnvironmentRow, patch: Record<string, unknown>) {
    const before = environmentView(e);
    const next = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    if (next.kind === 'production' && patch.destructivePolicy === 'allow' && !patch.confirmProductionDestructive) throw badRequest('enabling destructive tests on production requires confirmProductionDestructive=true', { code: 'production_destructive_confirmation_required' });
    const allowPrivate = !!next.allowPrivateNetwork && next.kind === 'local';
    const policy = checkTargetUrl(String(next.baseUrl), { allowPrivateNetwork: allowPrivate || this.cfg.allowPrivateTargetsGlobally });
    if (!policy.allowed) throw badRequest(`baseUrl rejected by target policy: ${policy.reason}`, { reason: policy.reason });
    await this.db.run(`UPDATE environments SET name = ?, kind = ?, base_url = ?, api_base_url = ?, destructive_policy = ?, test_data_policy = ?, auth_profile_json = ?, allow_private_network = ?, allowed_hosts_json = ?, privacy_json = ?, noise_rules_json = ?, updated_at = ? WHERE id = ?`,
      [next.name, next.kind, next.baseUrl, next.apiBaseUrl || null, next.destructivePolicy, next.testDataPolicy, toJson(next.authProfile), allowPrivate ? 1 : 0, toJson(next.allowedHosts), toJson({ maskSelectors: next.maskSelectors, redactHeaders: next.redactHeaders, captureBodies: next.captureBodies }), toJson({ consoleIgnorePatterns: next.consoleIgnorePatterns, networkIgnorePatterns: next.networkIgnorePatterns }), nowIso(), e.id]);
    const { authProfile: _a, ...beforeMin } = before; const { authProfile: _b, ...afterMin } = next; void _a; void _b;
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'environment.update', targetType: 'environment', targetId: e.id, projectId: p.id, before: beforeMin, after: afterMin, ip: ctx.ip });
    return environmentView(await this.getEnvironmentRow(e.id));
  }
  async deleteEnvironment(ctx: Ctx, p: ProjectRow, e: EnvironmentRow) {
    await this.db.run(`DELETE FROM environments WHERE id = ?`, [e.id]);
    if (p.default_environment_id === e.id) await this.db.run(`UPDATE projects SET default_environment_id = NULL WHERE id = ?`, [p.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'environment.delete', targetType: 'environment', targetId: e.id, projectId: p.id, before: { name: e.name, kind: e.kind }, ip: ctx.ip });
  }

  // ---------- Secrets (values never leave the server except to an authorized runner lease) ----------
  async listSecrets(projectId: string) {
    return this.db.all(`SELECT id, project_id, environment_id, name, description, key_id, version, created_by, created_at, updated_at FROM secrets WHERE project_id = ? ORDER BY name`, [projectId]);
  }
  async putSecret(ctx: Ctx, p: ProjectRow, input: { name: string; value: string; environmentId?: string; description?: string }) {
    if (input.environmentId) await this.getEnvironmentRow(input.environmentId, p.id);
    const envId = input.environmentId ?? null;
    const existing = await this.db.get<{ id: string; version: number }>(`SELECT id, version FROM secrets WHERE project_id = ? AND name = ? AND ${envId ? 'environment_id = ?' : 'environment_id IS NULL'}`, envId ? [p.id, input.name, envId] : [p.id, input.name]);
    const ct = encryptSecret(input.value, this.cfg.masterKey);
    const now = nowIso();
    let id: string; let version: number;
    if (existing) { id = existing.id; version = existing.version + 1; await this.db.run(`UPDATE secrets SET ciphertext = ?, version = ?, description = ?, updated_at = ? WHERE id = ?`, [ct, version, input.description ?? null, now, id]); }
    else { id = ulid(); version = 1; await this.db.run(`INSERT INTO secrets (id, org_id, project_id, environment_id, name, description, ciphertext, key_id, version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, envId, input.name, input.description ?? null, ct, 'k1', 1, ctx.actor.id, now, now]); }
    // audit records the name/version only — never the value
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: existing ? 'secret.update' : 'secret.create', targetType: 'secret', targetId: id, projectId: p.id, after: { name: input.name, environmentId: envId, version }, ip: ctx.ip });
    return { id, name: input.name, environmentId: envId, version };
  }
  async deleteSecret(ctx: Ctx, p: ProjectRow, secretId: string) {
    const s = await this.db.get<{ id: string; name: string }>(`SELECT id, name FROM secrets WHERE id = ? AND project_id = ?`, [secretId, p.id]);
    if (!s) throw notFound('secret');
    await this.db.run(`DELETE FROM secrets WHERE id = ?`, [s.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'secret.delete', targetType: 'secret', targetId: s.id, projectId: p.id, before: { name: s.name }, ip: ctx.ip });
  }
  /** Resolve secret values for a runner lease: environment-specific overrides project-level. Server-side only. */
  async resolveSecrets(projectId: string, environmentId: string, names: string[]): Promise<Record<string, string>> {
    if (names.length === 0) return {};
    const rows = await this.db.all<{ name: string; environment_id: string | null; ciphertext: string }>(`SELECT name, environment_id, ciphertext FROM secrets WHERE project_id = ? AND (environment_id IS NULL OR environment_id = ?)`, [projectId, environmentId]);
    const out: Record<string, string> = {};
    for (const n of names) {
      const env = rows.find((r) => r.name === n && r.environment_id === environmentId);
      const proj = rows.find((r) => r.name === n && r.environment_id === null);
      const row = env ?? proj;
      if (row) out[n] = decryptSecret(row.ciphertext, this.cfg.masterKey);
    }
    return out;
  }
}
