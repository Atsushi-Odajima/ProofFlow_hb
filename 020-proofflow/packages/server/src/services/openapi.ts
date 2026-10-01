import type { Db } from '../db/db.js';
import { nowIso, asJson, asBool } from '../db/db.js';
import { ulid } from '@proofflow/shared';
import { sha256 } from '../crypto.js';
import { badRequest, notFound, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { ProjectRow } from './projects.js';

export interface EndpointInfo { method: string; path: string; operationId?: string; summary?: string; params: string[]; requestBody?: boolean; responses: Record<string, { schemaHash?: string; schema?: unknown }>; }
export interface ContractDiff { added: string[]; removed: string[]; changed: { endpoint: string; changes: string[] }[]; breakingCandidates: string[]; }

/** OpenAPI 3.x inventory. When no spec exists we never infer a contract — endpoints must come from the document. */
export class OpenApiService {
  constructor(private db: Db, private audit: AuditService) {}

  parse(spec: Record<string, unknown>): EndpointInfo[] {
    if (!spec || typeof spec !== 'object' || !spec.paths) throw badRequest('not an OpenAPI document (missing paths)');
    const out: EndpointInfo[] = [];
    const resolve = (s: unknown): unknown => { if (s && typeof s === 'object' && '$ref' in (s as Record<string, unknown>)) { const ref = String((s as Record<string, unknown>).$ref); const parts = ref.replace(/^#\//, '').split('/'); let cur: unknown = spec; for (const p of parts) cur = (cur as Record<string, unknown> | undefined)?.[p]; return cur ?? s; } return s; };
    for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
        const op = item[method] as Record<string, unknown> | undefined; if (!op) continue;
        const params = [...((item.parameters as { name: string; in: string }[]) ?? []), ...((op.parameters as { name: string; in: string }[]) ?? [])].map((p) => `${p.in}:${p.name}`);
        const responses: EndpointInfo['responses'] = {};
        for (const [code, r] of Object.entries((op.responses as Record<string, Record<string, unknown>>) ?? {})) {
          const content = (resolve(r) as { content?: Record<string, { schema?: unknown }> }).content;
          const schema = content ? resolve(Object.values(content)[0]?.schema) : undefined;
          responses[code] = { schemaHash: schema ? sha256(JSON.stringify(schema)).slice(0, 16) : undefined, schema: schema ? this.simplify(schema, resolve) : undefined };
        }
        out.push({ method: method.toUpperCase(), path, operationId: op.operationId as string | undefined, summary: op.summary as string | undefined, params, requestBody: !!op.requestBody, responses });
      }
    }
    return out;
  }
  private simplify(schema: unknown, resolve: (s: unknown) => unknown, depth = 0): unknown {
    const s = resolve(schema) as Record<string, unknown>;
    if (!s || typeof s !== 'object' || depth > 6) return undefined;
    const out: Record<string, unknown> = {};
    if (s.type) out.type = s.type; if (s.required) out.required = s.required; if (s.enum) out.enum = s.enum; if (s.nullable) out.nullable = true; if (s.format) out.format = s.format;
    if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [k, this.simplify(v, resolve, depth + 1)]));
    if (s.items) out.items = this.simplify(s.items, resolve, depth + 1);
    if (s.additionalProperties !== undefined) out.additionalProperties = typeof s.additionalProperties === 'object' ? this.simplify(s.additionalProperties, resolve, depth + 1) : s.additionalProperties;
    if (s.oneOf || s.anyOf || s.allOf) out.composed = true;
    return out;
  }
  diff(base: EndpointInfo[], next: EndpointInfo[]): ContractDiff {
    const key = (e: EndpointInfo) => `${e.method} ${e.path}`;
    const bm = new Map(base.map((e) => [key(e), e])); const nm = new Map(next.map((e) => [key(e), e]));
    const added = [...nm.keys()].filter((k) => !bm.has(k)); const removed = [...bm.keys()].filter((k) => !nm.has(k));
    const changed: ContractDiff['changed'] = []; const breaking: string[] = [...removed.map((r) => `${r}: endpoint removed`)];
    for (const [k, b] of bm) {
      const n = nm.get(k); if (!n) continue; const changes: string[] = [];
      for (const p of b.params) if (!n.params.includes(p)) changes.push(`parameter removed ${p}`);
      for (const p of n.params) if (!b.params.includes(p)) changes.push(`parameter added ${p}`);
      for (const [code, r] of Object.entries(b.responses)) { const nr = n.responses[code]; if (!nr) { changes.push(`response ${code} removed`); breaking.push(`${k}: response ${code} removed`); continue; } if (r.schemaHash && nr.schemaHash && r.schemaHash !== nr.schemaHash) { changes.push(`response ${code} schema changed`); const req = (r.schema as { required?: string[] })?.required ?? []; const nreq = (nr.schema as { required?: string[] })?.required ?? []; const dropped = req.filter((x) => !nreq.includes(x)); if (dropped.length) breaking.push(`${k}: response ${code} required fields removed: ${dropped.join(', ')}`); const bt = (r.schema as { properties?: Record<string, { type?: unknown }> })?.properties ?? {}; const nt = (nr.schema as { properties?: Record<string, { type?: unknown }> })?.properties ?? {}; for (const [f, v] of Object.entries(bt)) if (nt[f] && v.type && nt[f]!.type && JSON.stringify(v.type) !== JSON.stringify(nt[f]!.type)) breaking.push(`${k}: response ${code} field "${f}" type changed ${JSON.stringify(v.type)} → ${JSON.stringify(nt[f]!.type)}`); } }
      if (changes.length) changed.push({ endpoint: k, changes });
    }
    return { added, removed, changed, breakingCandidates: breaking };
  }
  async import(ctx: Ctx, p: ProjectRow, spec: Record<string, unknown>, source?: string) {
    const endpoints = this.parse(spec);
    const hash = sha256(JSON.stringify(spec));
    const id = ulid();
    const baseline = await this.baseline(p.id);
    const diff = baseline ? this.diff(baseline.endpoints, endpoints) : null;
    await this.db.run(`INSERT INTO openapi_specs (id, org_id, project_id, source, spec_hash, endpoints_json, is_baseline, imported_by, imported_at) VALUES (?,?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, source ?? null, hash, JSON.stringify(endpoints), baseline ? 0 : 1, ctx.actor.id, nowIso()]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'openapi.import', targetType: 'openapi_spec', targetId: id, projectId: p.id, after: { endpoints: endpoints.length, hash: hash.slice(0, 16), isBaseline: !baseline, breakingCandidates: diff?.breakingCandidates.length ?? 0 }, ip: ctx.ip });
    return { id, endpoints, isBaseline: !baseline, diffFromBaseline: diff };
  }
  async baseline(projectId: string) {
    const r = await this.db.get<{ id: string; endpoints_json: string; imported_at: string }>(`SELECT id, endpoints_json, imported_at FROM openapi_specs WHERE project_id = ? AND is_baseline = 1 ORDER BY imported_at DESC LIMIT 1`, [projectId]);
    return r ? { id: r.id, endpoints: asJson<EndpointInfo[]>(r.endpoints_json, []), importedAt: r.imported_at } : null;
  }
  async list(projectId: string) { return (await this.db.all<{ id: string; source: string | null; spec_hash: string; endpoints_json: string; is_baseline: number; imported_at: string }>(`SELECT * FROM openapi_specs WHERE project_id = ? ORDER BY imported_at DESC LIMIT 50`, [projectId])).map((r) => ({ id: r.id, source: r.source, hash: r.spec_hash.slice(0, 16), endpointCount: asJson<EndpointInfo[]>(r.endpoints_json, []).length, isBaseline: asBool(r.is_baseline), importedAt: r.imported_at })); }
  /** Promoting a spec to the contract baseline is a governed change (history + audit). */
  async setBaseline(ctx: Ctx, p: ProjectRow, specId: string, reason: string) {
    const s = await this.db.get<{ id: string }>(`SELECT id FROM openapi_specs WHERE id = ? AND project_id = ?`, [specId, p.id]);
    if (!s) throw notFound('spec');
    const prev = await this.baseline(p.id);
    await this.db.run(`UPDATE openapi_specs SET is_baseline = 0 WHERE project_id = ?`, [p.id]);
    await this.db.run(`UPDATE openapi_specs SET is_baseline = 1 WHERE id = ?`, [specId]);
    await this.db.run(`INSERT INTO baseline_history (id, org_id, project_id, kind, baseline_id, action, actor_id, actor_kind, reason, from_ref, to_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [ulid(), p.org_id, p.id, 'api_contract', specId, 'update', ctx.actor.id, ctx.actor.kind, reason, prev?.id ?? null, specId, nowIso()]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'baseline.api_contract.update', targetType: 'openapi_spec', targetId: specId, projectId: p.id, before: { baseline: prev?.id ?? null }, after: { baseline: specId, reason }, ip: ctx.ip });
  }
}
