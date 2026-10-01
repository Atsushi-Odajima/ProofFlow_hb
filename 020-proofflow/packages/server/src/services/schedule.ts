import type { Db } from '../db/db.js';
import { nowIso, asBool } from '../db/db.js';
import { ulid } from '@proofflow/shared';
import { badRequest, notFound, SYSTEM, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { ProjectService, ProjectRow } from './projects.js';
import type { RunService } from './runs.js';

// ---------- minimal 5-field cron (minute hour dom month dow), timezone aware, no dependencies ----------
function parseField(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw badRequest(`invalid cron field "${part}"`);
    const step = m[3] ? Number(m[3]) : 1;
    let lo = m[1] === '*' ? min : Number(m[1]); let hi = m[1] === '*' ? max : m[2] ? Number(m[2]) : (m[3] ? max : Number(m[1]));
    if (lo < min || hi > max || lo > hi || step < 1) throw badRequest(`cron field out of range "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
export function parseCron(cron: string) {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) throw badRequest('cron must have 5 fields (minute hour day-of-month month day-of-week)');
  return { minute: parseField(f[0]!, 0, 59), hour: parseField(f[1]!, 0, 23), dom: parseField(f[2]!, 1, 31), month: parseField(f[3]!, 1, 12), dow: parseField(f[4]!.replace(/7/g, '0'), 0, 6), domStar: f[2] === '*', dowStar: f[4] === '*' };
}
function localParts(d: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  const p: Record<string, string> = {}; for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return { minute: Number(p.minute), hour: Number(p.hour), dom: Number(p.day), month: Number(p.month), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!) };
}
export function cronMatches(cron: ReturnType<typeof parseCron>, d: Date, tz: string): boolean {
  const l = localParts(d, tz);
  if (!cron.minute.has(l.minute) || !cron.hour.has(l.hour) || !cron.month.has(l.month)) return false;
  const domOk = cron.dom.has(l.dom); const dowOk = cron.dow.has(l.dow);
  return cron.domStar && cron.dowStar ? true : cron.domStar ? dowOk : cron.dowStar ? domOk : (domOk || dowOk);
}
/** Next matching instant strictly after `from` (minute resolution). Searches up to ~70 days. */
export function nextCron(cronExpr: string, tz: string, from = new Date()): Date | null {
  const cron = parseCron(cronExpr);
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw badRequest(`unknown timezone ${tz}`); }
  const t = new Date(from); t.setUTCSeconds(0, 0); t.setUTCMinutes(t.getUTCMinutes() + 1);
  for (let i = 0; i < 100_000; i++) { if (cronMatches(cron, t, tz)) return t; t.setUTCMinutes(t.getUTCMinutes() + 1); }
  return null;
}

export class ScheduleService {
  constructor(private db: Db, private audit: AuditService, private projects: ProjectService, private runs: RunService) {}
  async list(projectId: string) { return (await this.db.all(`SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at`, [projectId])).map((r) => ({ ...r, enabled: asBool(r.enabled as number) })); }
  async get(id: string, projectId: string) { const r = await this.db.get<Record<string, unknown>>(`SELECT * FROM schedules WHERE id = ? AND project_id = ?`, [id, projectId]); if (!r) throw notFound('schedule'); return r; }
  async create(ctx: Ctx, p: ProjectRow, input: { suiteId: string; environmentId: string; cron: string; timezone: string; enabled: boolean; priority: number; overlapPolicy: 'skip' | 'queue'; label?: string }) {
    if (!(await this.db.get(`SELECT 1 FROM suites WHERE id = ? AND project_id = ?`, [input.suiteId, p.id]))) throw badRequest('suite not in project');
    await this.projects.getEnvironmentRow(input.environmentId, p.id);
    const next = nextCron(input.cron, input.timezone);
    if (!next) throw badRequest('cron never fires within 70 days');
    const id = ulid(); const now = nowIso();
    await this.db.run(`INSERT INTO schedules (id, org_id, project_id, suite_id, environment_id, label, cron, timezone, enabled, priority, overlap_policy, next_run_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, input.suiteId, input.environmentId, input.label ?? null, input.cron, input.timezone, input.enabled ? 1 : 0, input.priority, input.overlapPolicy, next.toISOString(), ctx.actor.id, now, now]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'schedule.create', targetType: 'schedule', targetId: id, projectId: p.id, after: { cron: input.cron, timezone: input.timezone, suiteId: input.suiteId, environmentId: input.environmentId }, ip: ctx.ip });
    return this.get(id, p.id);
  }
  async update(ctx: Ctx, p: ProjectRow, id: string, patch: Partial<{ cron: string; timezone: string; enabled: boolean; priority: number; overlapPolicy: string; label: string; suiteId: string; environmentId: string }>) {
    const cur = await this.get(id, p.id);
    const cron = patch.cron ?? (cur.cron as string); const tz = patch.timezone ?? (cur.timezone as string);
    const next = nextCron(cron, tz); if (!next) throw badRequest('cron never fires within 70 days');
    await this.db.run(`UPDATE schedules SET cron = ?, timezone = ?, enabled = ?, priority = ?, overlap_policy = ?, label = ?, suite_id = ?, environment_id = ?, next_run_at = ?, updated_at = ? WHERE id = ?`, [cron, tz, (patch.enabled ?? asBool(cur.enabled as number)) ? 1 : 0, patch.priority ?? (cur.priority as number), patch.overlapPolicy ?? (cur.overlap_policy as string), patch.label ?? (cur.label as string | null), patch.suiteId ?? (cur.suite_id as string), patch.environmentId ?? (cur.environment_id as string), next.toISOString(), nowIso(), id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'schedule.update', targetType: 'schedule', targetId: id, projectId: p.id, before: { cron: cur.cron, enabled: asBool(cur.enabled as number) }, after: { cron, enabled: patch.enabled ?? asBool(cur.enabled as number) }, ip: ctx.ip });
    return this.get(id, p.id);
  }
  async remove(ctx: Ctx, p: ProjectRow, id: string) { await this.get(id, p.id); await this.db.run(`DELETE FROM schedules WHERE id = ?`, [id]); await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'schedule.delete', targetType: 'schedule', targetId: id, projectId: p.id, ip: ctx.ip }); }

  /**
   * Fire due schedules. Idempotent per (schedule, due time) via run idempotency keys, so a double tick or a restart never
   * creates duplicate runs. Missed firings while the server was down collapse into one (catch-up = 1).
   */
  async tick(now = new Date()): Promise<{ fired: string[]; skipped: string[] }> {
    const due = await this.db.all<{ id: string; org_id: string; project_id: string; suite_id: string; environment_id: string; cron: string; timezone: string; priority: number; overlap_policy: string; next_run_at: string; label: string | null }>(`SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 100`, [now.toISOString()]);
    const fired: string[] = []; const skipped: string[] = [];
    for (const s of due) {
      const dueAt = s.next_run_at;
      const next = nextCron(s.cron, s.timezone, now);
      await this.db.run(`UPDATE schedules SET next_run_at = ?, last_fired_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ?`, [next?.toISOString() ?? null, now.toISOString(), nowIso(), s.id, dueAt]);
      if (s.overlap_policy === 'skip') {
        const active = await this.db.get(`SELECT 1 FROM test_runs WHERE project_id = ? AND suite_id = ? AND environment_id = ? AND status IN ('queued','running') LIMIT 1`, [s.project_id, s.suite_id, s.environment_id]);
        if (active) { skipped.push(s.id); continue; }
      }
      try {
        const p = await this.projects.getRow(s.project_id);
        const { run, deduplicated } = await this.runs.create({ actor: SYSTEM, ip: 'scheduler', requestId: 'scheduler' }, p, { environmentId: s.environment_id, suiteId: s.suite_id, trigger: 'schedule', priority: s.priority, idempotencyKey: `schedule:${s.id}:${dueAt}`, label: s.label ?? `Scheduled ${s.cron}` }, { canRunDestructive: false });
        if (!deduplicated) { fired.push(s.id); await this.db.run(`UPDATE schedules SET last_run_id = ? WHERE id = ?`, [run.id, s.id]); }
        else skipped.push(s.id);
      } catch (e) { skipped.push(s.id); await this.audit.log({ orgId: s.org_id, actor: SYSTEM, action: 'schedule.fire_failed', targetType: 'schedule', targetId: s.id, projectId: s.project_id, after: { error: e instanceof Error ? e.message : String(e) } }); }
    }
    return { fired, skipped };
  }
}
