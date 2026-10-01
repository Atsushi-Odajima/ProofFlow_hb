import dns from 'node:dns/promises';
import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { ulid, randomToken, checkTargetUrl, ROLE_RANK, type Role } from '@proofflow/shared';
import type { Config } from '../config.js';
import { badRequest, forbidden, notFound, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { ProjectRow } from './projects.js';

export interface DomainRow { id: string; org_id: string; project_id: string; hostname: string; method: string; token: string; status: string; last_error: string | null; verified_at: string | null; verified_by: string | null; created_by: string | null; created_at: string; }

/**
 * Domain ownership verification (DOMAIN_VERIFICATION.md). Unverified public targets run in low-load mode.
 * Methods: dns_txt (TXT record), html_token (<meta name="proofflow-verify">), well_known (/.well-known/proofflow-verify.txt), manual (Owner/Admin attestation).
 */
export class DomainService {
  constructor(private db: Db, private cfg: Config, private audit: AuditService, private fetchImpl: typeof fetch = fetch) {}
  async list(projectId: string) { return this.db.all<DomainRow>(`SELECT id, project_id, hostname, method, status, last_error, verified_at, verified_by, created_at FROM domain_verifications WHERE project_id = ? ORDER BY hostname`, [projectId]); }
  instructions(d: { hostname: string; method: string; token: string }) {
    switch (d.method) {
      case 'dns_txt': return `Add a DNS TXT record on ${d.hostname} (or _proofflow.${d.hostname}) with value: proofflow-verify=${d.token}`;
      case 'html_token': return `Add <meta name="proofflow-verify" content="${d.token}"> to the <head> of https://${d.hostname}/`;
      case 'well_known': return `Serve https://${d.hostname}/.well-known/proofflow-verify.txt containing: ${d.token}`;
      default: return 'An organization Owner/Admin attests ownership of this host (recorded in the audit log).';
    }
  }
  async start(ctx: Ctx, p: ProjectRow, input: { hostname: string; method: string }) {
    const hostname = input.hostname.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+(:\d+)?$/.test(hostname)) throw badRequest('invalid hostname');
    const token = `pf-${randomToken(18)}`;
    const existing = await this.db.get<DomainRow>(`SELECT * FROM domain_verifications WHERE project_id = ? AND hostname = ?`, [p.id, hostname]);
    const id = existing?.id ?? ulid();
    if (existing) await this.db.run(`UPDATE domain_verifications SET method = ?, token = ?, status = 'pending', last_error = NULL, verified_at = NULL, verified_by = NULL WHERE id = ?`, [input.method, token, id]);
    else await this.db.run(`INSERT INTO domain_verifications (id, org_id, project_id, hostname, method, token, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, hostname, input.method, token, 'pending', ctx.actor.id, nowIso()]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'domain.start', targetType: 'domain_verification', targetId: id, projectId: p.id, after: { hostname, method: input.method }, ip: ctx.ip });
    return { id, hostname, method: input.method, token, status: 'pending', instructions: this.instructions({ hostname, method: input.method, token }) };
  }
  private originFor(p: ProjectRow, hostname: string): Promise<string[]> {
    return this.db.all<{ base_url: string }>(`SELECT base_url FROM environments WHERE project_id = ?`, [p.id]).then((rows) => { const set = new Set<string>(); for (const r of rows) { try { const u = new URL(r.base_url); if (u.host.toLowerCase() === hostname) set.add(u.origin); } catch { /* ignore */ } } if (set.size === 0) set.add(`https://${hostname}`); return [...set]; });
  }
  async verify(ctx: Ctx, p: ProjectRow, id: string, role: Role) {
    const d = await this.db.get<DomainRow>(`SELECT * FROM domain_verifications WHERE id = ? AND project_id = ?`, [id, p.id]);
    if (!d) throw notFound('domain verification');
    let ok = false; let error: string | null = null;
    try {
      switch (d.method) {
        case 'dns_txt': {
          const host = d.hostname.replace(/:\d+$/, '');
          const records = [...(await dns.resolveTxt(host).catch(() => [])), ...(await dns.resolveTxt(`_proofflow.${host}`).catch(() => []))].map((r) => r.join(''));
          ok = records.some((r) => r.trim() === `proofflow-verify=${d.token}`);
          if (!ok) error = `TXT record not found (${records.length} records seen)`;
          break;
        }
        case 'html_token': case 'well_known': {
          for (const origin of await this.originFor(p, d.hostname)) {
            const url = d.method === 'well_known' ? `${origin}/.well-known/proofflow-verify.txt` : `${origin}/`;
            const pol = checkTargetUrl(url, { allowPrivateNetwork: this.cfg.allowPrivateTargetsGlobally });
            if (!pol.allowed) { error = `target policy: ${pol.reason}`; continue; }
            const res = await this.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'ProofFlow-DomainVerifier/0.1' } });
            const text = (await res.text()).slice(0, 200_000);
            ok = d.method === 'well_known' ? text.includes(d.token) : new RegExp(`<meta[^>]+name=["']proofflow-verify["'][^>]+content=["']${d.token}["']`, 'i').test(text) || new RegExp(`<meta[^>]+content=["']${d.token}["'][^>]+name=["']proofflow-verify["']`, 'i').test(text);
            if (ok) break; error = `token not found at ${url} (status ${res.status})`;
          }
          break;
        }
        case 'manual': {
          if (ROLE_RANK[role] < ROLE_RANK.admin) throw forbidden('manual verification requires an organization Owner/Admin');
          if (ctx.actor.kind !== 'user') throw forbidden('manual verification must be attested by a human user');
          ok = true; break;
        }
        default: throw badRequest('unknown method');
      }
    } catch (e) { if (e instanceof Error && 'status' in e) throw e; error = e instanceof Error ? e.message.slice(0, 300) : String(e); }
    const now = nowIso();
    await this.db.run(`UPDATE domain_verifications SET status = ?, last_error = ?, verified_at = ?, verified_by = ? WHERE id = ?`, [ok ? 'verified' : 'failed', ok ? null : error, ok ? now : null, ok ? ctx.actor.id : null, id]);
    if (ok) {
      const envs = await this.db.all<{ id: string; base_url: string }>(`SELECT id, base_url FROM environments WHERE project_id = ?`, [p.id]);
      for (const e of envs) { try { if (new URL(e.base_url).host.toLowerCase() === d.hostname) await this.db.run(`UPDATE environments SET domain_verified = 1, updated_at = ? WHERE id = ?`, [now, e.id]); } catch { /* ignore */ } }
    }
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: ok ? 'domain.verified' : 'domain.verify_failed', targetType: 'domain_verification', targetId: id, projectId: p.id, after: { hostname: d.hostname, method: d.method, error }, ip: ctx.ip });
    return { id, hostname: d.hostname, method: d.method, status: ok ? 'verified' : 'failed', error };
  }
}
