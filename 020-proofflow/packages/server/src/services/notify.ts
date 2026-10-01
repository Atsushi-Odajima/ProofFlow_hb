import type { Db } from '../db/db.js';
import { nowIso, asJson, asBool } from '../db/db.js';
import { ulid, checkTargetUrl, ROLE_RANK, type Role } from '@proofflow/shared';
import { badRequest, notFound, type Ctx } from '../context.js';
import type { Config } from '../config.js';
import type { AuditService } from './audit.js';

export interface Notification { id: string; orgId: string; projectId: string | null; kind: string; title: string; body: string | null; link: string | null; createdAt: string; }
/** Channel adapters. Email/Slack/Teams are adapters; the in-app feed is always on. */
export interface ChannelAdapter { type: string; send(config: Record<string, unknown>, n: Notification): Promise<void>; }

export class WebhookAdapter implements ChannelAdapter {
  type = 'webhook';
  constructor(private allowPrivate: boolean, private fetchImpl: typeof fetch = fetch) {}
  async send(config: Record<string, unknown>, n: Notification) {
    const url = String(config.url ?? '');
    const pol = checkTargetUrl(url, { allowPrivateNetwork: this.allowPrivate });
    if (!pol.allowed) throw new Error(`webhook URL rejected: ${pol.reason}`);
    const res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(config.secretHeader ? { 'x-proofflow-signature': String(config.secretHeader) } : {}) }, body: JSON.stringify({ event: n.kind, title: n.title, body: n.body, link: n.link, projectId: n.projectId, at: n.createdAt }), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  }
}
export class SlackAdapter implements ChannelAdapter {
  type = 'slack';
  constructor(private fetchImpl: typeof fetch = fetch) {}
  async send(config: Record<string, unknown>, n: Notification) {
    const url = String(config.webhookUrl ?? '');
    if (!/^https:\/\/hooks\.slack\.com\//.test(url)) throw new Error('slack incoming webhook URL must start with https://hooks.slack.com/');
    const res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `*${n.title}*\n${n.body ?? ''}${n.link ? `\n${n.link}` : ''}` }), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`slack responded ${res.status}`);
  }
}
/** Email is an adapter point: no SMTP provider is bundled in the initial release (delivery is recorded as skipped). */
export class EmailAdapter implements ChannelAdapter { type = 'email'; async send(): Promise<void> { throw new Error('email adapter not configured (see OPERATIONS.md)'); } }

export class NotificationService {
  private adapters = new Map<string, ChannelAdapter>();
  constructor(private db: Db, private cfg: Config, private audit: AuditService) { this.register(new WebhookAdapter(cfg.allowPrivateTargetsGlobally)); this.register(new SlackAdapter()); this.register(new EmailAdapter()); }
  register(a: ChannelAdapter) { this.adapters.set(a.type, a); }

  /** Fan out an event to org members (developer+) with storm suppression by dedupeKey (60 min window). */
  async notify(orgId: string, projectId: string | null, kind: string, title: string, body: string, link: string, dedupeKey: string, opts: { minRole?: Role; windowMin?: number } = {}) {
    const since = new Date(Date.now() - (opts.windowMin ?? 60) * 60_000).toISOString();
    const dup = await this.db.get(`SELECT 1 FROM notifications WHERE org_id = ? AND dedupe_key = ? AND created_at >= ? LIMIT 1`, [orgId, dedupeKey, since]);
    if (dup) return { suppressed: true };
    const members = await this.db.all<{ user_id: string; role: Role }>(`SELECT user_id, role FROM org_members WHERE org_id = ? LIMIT 200`, [orgId]);
    const minRank = ROLE_RANK[opts.minRole ?? 'developer'];
    const now = nowIso(); let created = 0;
    for (const m of members) { if (ROLE_RANK[m.role] < minRank) continue; await this.db.run(`INSERT INTO notifications (id, org_id, user_id, project_id, kind, title, body, link, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [ulid(), orgId, m.user_id, projectId, kind, title, body.slice(0, 2000), link, dedupeKey, now]); created++; }
    const n: Notification = { id: ulid(), orgId, projectId, kind, title, body, link: `${this.cfg.publicUrl}${link}`, createdAt: now };
    await this.deliver(orgId, projectId, n);
    return { suppressed: false, created };
  }
  private async deliver(orgId: string, projectId: string | null, n: Notification) {
    const channels = await this.db.all<{ id: string; type: string; config_json: string; events_json: string; project_id: string | null }>(`SELECT * FROM notification_channels WHERE org_id = ? AND enabled = 1`, [orgId]);
    for (const ch of channels) {
      if (ch.project_id && ch.project_id !== projectId) continue;
      const events = asJson<string[]>(ch.events_json, []);
      if (!events.includes('*') && !events.includes(n.kind) && !events.some((e) => e.endsWith('*') && n.kind.startsWith(e.slice(0, -1)))) continue;
      const adapter = this.adapters.get(ch.type);
      let status = 'sent'; let error: string | null = null;
      try { if (!adapter) throw new Error(`no adapter for ${ch.type}`); await adapter.send(asJson<Record<string, unknown>>(ch.config_json, {}), n); } catch (e) { status = ch.type === 'email' ? 'skipped' : 'failed'; error = e instanceof Error ? e.message.slice(0, 500) : String(e); }
      await this.db.run(`INSERT INTO notification_deliveries (id, org_id, channel_id, notification_id, status, error, created_at) VALUES (?,?,?,?,?,?,?)`, [ulid(), orgId, ch.id, n.id, status, error, nowIso()]);
    }
  }
  async listForUser(orgId: string, userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
    return this.db.all(`SELECT id, project_id, kind, title, body, link, read_at, created_at FROM notifications WHERE org_id = ? AND user_id = ? ${opts.unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`, [orgId, userId, Math.min(opts.limit ?? 50, 200)]);
  }
  async markRead(orgId: string, userId: string, ids: string[] | 'all') {
    if (ids === 'all') await this.db.run(`UPDATE notifications SET read_at = ? WHERE org_id = ? AND user_id = ? AND read_at IS NULL`, [nowIso(), orgId, userId]);
    else for (const id of ids) await this.db.run(`UPDATE notifications SET read_at = ? WHERE id = ? AND org_id = ? AND user_id = ?`, [nowIso(), id, orgId, userId]);
  }
  async channels(orgId: string) { return (await this.db.all<{ id: string; project_id: string | null; type: string; name: string; config_json: string; events_json: string; enabled: number; created_at: string }>(`SELECT * FROM notification_channels WHERE org_id = ? ORDER BY created_at`, [orgId])).map((c) => ({ id: c.id, projectId: c.project_id, type: c.type, name: c.name, config: redactConfig(asJson<Record<string, unknown>>(c.config_json, {})), events: asJson<string[]>(c.events_json, []), enabled: asBool(c.enabled), createdAt: c.created_at })); }
  async createChannel(ctx: Ctx, orgId: string, input: { projectId?: string; type: string; name: string; config: Record<string, unknown>; events: string[] }) {
    if (!this.adapters.has(input.type)) throw badRequest(`unknown channel type ${input.type}`);
    if (input.type === 'webhook') { const pol = checkTargetUrl(String(input.config.url ?? ''), { allowPrivateNetwork: this.cfg.allowPrivateTargetsGlobally }); if (!pol.allowed) throw badRequest(`webhook URL rejected: ${pol.reason}`); }
    const id = ulid(); const now = nowIso();
    await this.db.run(`INSERT INTO notification_channels (id, org_id, project_id, type, name, config_json, events_json, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)`, [id, orgId, input.projectId ?? null, input.type, input.name, JSON.stringify(input.config), JSON.stringify(input.events), now, now]);
    await this.audit.log({ orgId, actor: ctx.actor, action: 'notification_channel.create', targetType: 'notification_channel', targetId: id, after: { type: input.type, name: input.name, events: input.events }, ip: ctx.ip });
    return { id };
  }
  async deleteChannel(ctx: Ctx, orgId: string, id: string) { const r = await this.db.run(`DELETE FROM notification_channels WHERE id = ? AND org_id = ?`, [id, orgId]); if (!r.changes) throw notFound('channel'); await this.audit.log({ orgId, actor: ctx.actor, action: 'notification_channel.delete', targetType: 'notification_channel', targetId: id, ip: ctx.ip }); }
  async deliveries(orgId: string, limit = 100) { return this.db.all(`SELECT d.*, c.type, c.name FROM notification_deliveries d JOIN notification_channels c ON c.id = d.channel_id WHERE d.org_id = ? ORDER BY d.id DESC LIMIT ?`, [orgId, limit]); }
}
function redactConfig(c: Record<string, unknown>) { const out: Record<string, unknown> = {}; for (const [k, v] of Object.entries(c)) out[k] = /url|secret|token|key/i.test(k) && typeof v === 'string' ? v.replace(/(.{12}).+/, '$1…') : v; return out; }
