import type { Db } from '../db/db.js';
import { nowIso, asJson, asBool } from '../db/db.js';
import { ulid, SCHEMA_VERSION, APP_VERSION, StepsSchema, type Step, type Matrix } from '@proofflow/shared';
import { badRequest, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { ProjectRow } from './projects.js';
import type { ScenarioService } from './scenarios.js';
import type { RequirementService } from './requirements.js';
import type { RunService, RunRow } from './runs.js';

/** Git/CI/AI-coding-agent integration helpers: test impact candidates, test definition export/import, CI summaries. */
export class IntegrationService {
  constructor(private db: Db, private audit: AuditService, private scenarios: ScenarioService, private requirements: RequirementService, private runs: RunService) {}

  /** Candidate scenarios for changed files/routes. Heuristic + explicit rules; never a substitute for required release suites. */
  async testImpact(p: ProjectRow, changed: string[]) {
    const scenarios = await this.scenarios.list(p.id, { limit: 500 });
    const rules = await this.db.all<{ pattern: string; scenario_ids_json: string }>(`SELECT pattern, scenario_ids_json FROM test_impact_rules WHERE project_id = ?`, [p.id]);
    const tokens = new Set<string>();
    for (const f of changed) {
      const base = f.split('/').pop() ?? f;
      const stem = base.replace(/\.[^.]+$/, '').toLowerCase();
      for (const t of stem.split(/[^a-z0-9]+/).filter((x) => x.length >= 3)) tokens.add(t);
      for (const seg of f.toLowerCase().split('/').filter((x) => x.length >= 3 && !['src', 'app', 'pages', 'components', 'routes', 'lib', 'index', 'test', 'tests', 'spec'].includes(x))) tokens.add(seg.replace(/\.[^.]+$/, ''));
    }
    const candidates = new Map<string, { scenarioId: string; key: string; title: string; reasons: string[] }>();
    const add = (s: { id: string; key: string; title: string }, reason: string) => { const c = candidates.get(s.id) ?? { scenarioId: s.id, key: s.key, title: s.title, reasons: [] }; if (!c.reasons.includes(reason)) c.reasons.push(reason); candidates.set(s.id, c); };
    for (const r of rules) { const re = globToRe(r.pattern); if (changed.some((f) => re.test(f))) for (const sid of asJson<string[]>(r.scenario_ids_json, [])) { const s = scenarios.find((x) => x.id === sid); if (s) add(s, `rule ${r.pattern}`); } }
    for (const s of scenarios) {
      const hay = `${s.title} ${s.tags.join(' ')} ${(s.steps as Step[]).map((st) => ('url' in st ? st.url : '') + ' ' + ('target' in st ? JSON.stringify(st.target) : '')).join(' ')}`.toLowerCase();
      for (const t of tokens) if (hay.includes(t)) add(s, `matches "${t}"`);
    }
    return { changedFiles: changed, candidates: [...candidates.values()], note: 'Candidates only: required release-gate suites must still run in full.' };
  }
  async setImpactRule(ctx: Ctx, p: ProjectRow, pattern: string, scenarioIds: string[]) {
    const id = ulid();
    await this.db.run(`INSERT INTO test_impact_rules (id, org_id, project_id, pattern, scenario_ids_json, created_at) VALUES (?,?,?,?,?,?)`, [id, p.org_id, p.id, pattern, JSON.stringify(scenarioIds), nowIso()]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'impact_rule.create', targetType: 'test_impact_rule', targetId: id, projectId: p.id, after: { pattern, scenarios: scenarioIds.length }, ip: ctx.ip });
    return { id };
  }

  /** Export test definitions (requirements, scenarios, suites) as repo-friendly JSON. Secrets are references only. */
  async exportDefinitions(p: ProjectRow) {
    const reqs = await this.requirements.list(p.id, { limit: 500 });
    const scenarios = await this.scenarios.list(p.id, { limit: 500 });
    const suites = await this.scenarios.suites(p.id);
    const keyOf = (id: string) => scenarios.find((s) => s.id === id)?.key ?? id;
    return {
      format: 'proofflow-definitions', schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, exportedAt: nowIso(), project: { slug: p.slug, name: p.name, type: p.type },
      requirements: reqs.map((r) => ({ key: r.key, title: r.title, description: r.description, priority: r.priority, status: r.status, acceptanceCriteria: r.acceptanceCriteria.map((a) => ({ format: a.format, given: a.given, when: a.when, then: a.then, text: a.text })) })),
      scenarios: scenarios.map((s) => ({ key: s.key, title: s.title, description: s.description, preconditions: s.preconditions, steps: s.steps, expected: s.expected, priority: s.priority, tags: s.tags, browsers: s.browsers, status: s.status, requirementKeys: s.requirementIds.map((id) => reqs.find((r) => r.id === id)?.key ?? id) })),
      suites: suites.map((s) => ({ name: s.name, kind: s.kind, description: s.description, matrix: s.matrix, requiredForRelease: s.requiredForRelease, scenarioKeys: s.scenarioIds.map(keyOf) })),
    };
  }
  /** Import/upsert by key. Changes go through the normal versioned, audited scenario path. Visual baselines are never touched. */
  async importDefinitions(ctx: Ctx, p: ProjectRow, doc: { requirements?: Array<Record<string, unknown>>; scenarios?: Array<Record<string, unknown>>; suites?: Array<Record<string, unknown>> }, opts: { changeReason?: string } = {}) {
    const result = { requirements: { created: 0, updated: 0 }, scenarios: { created: 0, updated: 0, unchanged: 0 }, suites: { created: 0, updated: 0 }, errors: [] as string[] };
    const reqs = await this.requirements.list(p.id, { limit: 500 });
    const reqByKey = new Map(reqs.map((r) => [r.key, r]));
    for (const r of doc.requirements ?? []) {
      const key = String(r.key ?? ''); const existing = key ? reqByKey.get(key) : undefined;
      try {
        if (existing) { await this.requirements.update(ctx, p, await this.requirements.getRow(existing.id, p.id), { title: r.title as string, description: r.description as string, priority: r.priority as string, status: r.status as string, acceptanceCriteria: r.acceptanceCriteria as never }); result.requirements.updated++; }
        else { const created = await this.requirements.create(ctx, p, { title: String(r.title), description: r.description as string, priority: (r.priority as string) ?? 'p2', status: (r.status as string) ?? 'draft', acceptanceCriteria: r.acceptanceCriteria as never }); reqByKey.set(created.key, created); if (key) reqByKey.set(key, created); result.requirements.created++; }
      } catch (e) { result.errors.push(`requirement ${key || r.title}: ${e instanceof Error ? e.message : e}`); }
    }
    const scenarios = await this.scenarios.list(p.id, { limit: 500 });
    const scByKey = new Map(scenarios.map((s) => [s.key, s]));
    for (const s of doc.scenarios ?? []) {
      const key = String(s.key ?? ''); const existing = key ? scByKey.get(key) : undefined;
      const parsed = StepsSchema.safeParse(s.steps);
      if (!parsed.success) { result.errors.push(`scenario ${key || s.title}: invalid steps`); continue; }
      const requirementIds = ((s.requirementKeys as string[]) ?? []).map((k) => reqByKey.get(k)?.id).filter((x): x is string => !!x);
      try {
        if (existing) {
          const same = JSON.stringify(existing.steps) === JSON.stringify(parsed.data) && (existing.expected ?? null) === ((s.expected as string) ?? null) && existing.title === s.title;
          if (same) { result.scenarios.unchanged++; continue; }
          await this.scenarios.update(ctx, p, await this.scenarios.getRow(existing.id, p.id), { title: s.title, description: s.description, preconditions: s.preconditions, steps: parsed.data, expected: s.expected ?? null, priority: s.priority, tags: s.tags, browsers: s.browsers, status: s.status, requirementIds, changeReason: opts.changeReason ?? 'imported from repository definitions' });
          result.scenarios.updated++;
        } else { const created = await this.scenarios.create(ctx, p, { title: String(s.title), description: s.description as string, preconditions: s.preconditions as string, steps: parsed.data, expected: s.expected as string, priority: (s.priority as string) ?? 'p2', tags: s.tags as string[], browsers: s.browsers as string[], requirementIds, status: (s.status as string) ?? 'active', origin: 'import', changeReason: opts.changeReason ?? 'imported' }); scByKey.set(created.key, created); if (key) scByKey.set(key, created); result.scenarios.created++; }
      } catch (e) { result.errors.push(`scenario ${key || s.title}: ${e instanceof Error ? e.message : e}`); }
    }
    const suites = await this.scenarios.suites(p.id);
    for (const su of doc.suites ?? []) {
      const ids = ((su.scenarioKeys as string[]) ?? []).map((k) => scByKey.get(k)?.id).filter((x): x is string => !!x);
      const existing = suites.find((x) => x.name === su.name);
      try {
        if (existing) { await this.scenarios.updateSuite(ctx, p, existing.id, { kind: su.kind as string, description: su.description as string, matrix: su.matrix as Matrix, scenarioIds: ids, requiredForRelease: su.requiredForRelease as boolean }); result.suites.updated++; }
        else { await this.scenarios.createSuite(ctx, p, { name: String(su.name), kind: (su.kind as string) ?? 'custom', description: su.description as string, matrix: su.matrix as Matrix, scenarioIds: ids, requiredForRelease: su.requiredForRelease as boolean }); result.suites.created++; }
      } catch (e) { result.errors.push(`suite ${su.name}: ${e instanceof Error ? e.message : e}`); }
    }
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'definitions.import', targetType: 'project', targetId: p.id, projectId: p.id, after: result, ip: ctx.ip });
    return result;
  }

  /** PR/CI comment content. ProofFlow never posts to GitHub itself; the CLI/CI step does so explicitly with its own credentials. */
  async ciSummary(run: RunRow) {
    const detail = await this.runs.detail(run);
    const failed = detail.results.filter((r) => r.status !== 'passed');
    const icon = run.status === 'passed' ? '✅' : run.status === 'flaky' ? '⚠️' : run.status === 'infra_error' ? '🛠️' : run.status === 'cancelled' ? '⏹️' : '❌';
    const lines = [`### ${icon} ProofFlow run \`${run.id}\` — **${run.status.toUpperCase()}**`, '', `| passed | flaky | failed | infra error | total |`, `|---|---|---|---|---|`, `| ${detail.counts.passed ?? 0} | ${(detail.counts.flaky ?? 0) + (detail.counts.passedAfterRetry ?? 0)} | ${detail.counts.failed ?? 0} | ${detail.counts.infraError ?? 0} | ${detail.counts.total ?? 0} |`, ''];
    if (run.commit_sha || run.branch || run.pr_number) lines.push(`commit \`${run.commit_sha ?? '-'}\` · branch \`${run.branch ?? '-'}\` · PR ${run.pr_number ?? '-'} · build \`${run.build_id ?? '-'}\``, '');
    if (failed.length) { lines.push('| scenario | browser | viewport | status | failure |', '|---|---|---|---|---|'); for (const r of failed.slice(0, 30)) lines.push(`| ${r.scenario?.key ?? ''} ${r.scenario?.title ?? ''} | ${r.browser} | ${r.viewport.name ?? `${r.viewport.width}x${r.viewport.height}`} | ${r.status} (${r.outcomeDetail}) | ${(r.failure?.message ?? '').replace(/\|/g, '\\|').slice(0, 160)} |`); lines.push(''); }
    lines.push(`Evidence (screenshots, traces, videos) is attached to each result in ProofFlow. _Automated checks cover a subset of quality; see manual device checks and the release gate._`);
    return { markdown: lines.join('\n'), json: { runId: run.id, status: run.status, counts: detail.counts, failed: failed.map((r) => ({ resultId: r.id, scenario: r.scenario?.key, browser: r.browser, status: r.status, failure: r.failure?.message ?? null })) } };
  }
  bool = asBool;
}
function globToRe(glob: string): RegExp { return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::ALL::').replace(/\*/g, '[^/]*').replace(/::ALL::/g, '.*').replace(/\?/g, '.') + '$'); }
