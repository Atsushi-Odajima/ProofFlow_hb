import type { Db } from '../db/db.js';
import { nowIso, toJson } from '../db/db.js';
import { ulid } from '@proofflow/shared';
import type { Actor } from '../context.js';

export interface AuditEntry { orgId: string; actor: Actor; action: string; targetType: string; targetId?: string | null; projectId?: string | null; before?: unknown; after?: unknown; ip?: string | null; }

// Never copy secret values or artifact bodies into audit entries; callers pass minimal diffs.
export class AuditService {
  constructor(private db: Db) {}
  async log(e: AuditEntry, db: Db = this.db): Promise<void> {
    await db.run(
      `INSERT INTO audit_logs (id, org_id, actor_kind, actor_id, action, target_type, target_id, project_id, before_json, after_json, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ulid(), e.orgId, e.actor.kind, e.actor.id, e.action, e.targetType, e.targetId ?? null, e.projectId ?? null, toJson(e.before), toJson(e.after), e.ip ?? null, nowIso()],
    );
  }
  async list(orgId: string, opts: { limit?: number; cursor?: string; targetType?: string; targetId?: string; action?: string; projectId?: string } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const where: string[] = ['org_id = ?']; const params: (string | number)[] = [orgId];
    if (opts.cursor) { where.push('id < ?'); params.push(opts.cursor); }
    if (opts.targetType) { where.push('target_type = ?'); params.push(opts.targetType); }
    if (opts.targetId) { where.push('target_id = ?'); params.push(opts.targetId); }
    if (opts.action) { where.push('action = ?'); params.push(opts.action); }
    if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
    params.push(limit);
    return this.db.all(`SELECT * FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params);
  }
}
