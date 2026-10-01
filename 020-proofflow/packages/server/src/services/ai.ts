import type { Db } from '../db/db.js';
import { nowIso, asJson } from '../db/db.js';
import { ulid, redactDeep, type AiFeature } from '@proofflow/shared';
import type { Config } from '../config.js';
import { badRequest, notFound, HttpError, type Ctx } from '../context.js';
import type { AuditService } from './audit.js';
import type { AiProvider } from '../ai/provider.js';
import { AiDisabledError, NoneProvider, MockProvider } from '../ai/provider.js';
import { OUTPUT_SCHEMAS, buildPrompt, jsonSchemaFor, type AiFeatureName } from '../ai/features.js';
import type { ProjectRow } from './projects.js';
import type { ScenarioService } from './scenarios.js';

export interface SuggestionRow { id: string; org_id: string; project_id: string; feature: string; target_type: string | null; target_id: string | null; input_summary: string | null; output_json: string; provider: string; model: string | null; status: string; applied_by: string | null; applied_at: string | null; applied_target_id: string | null; created_by: string | null; created_at: string; }

export function suggestionView(s: SuggestionRow) {
  return { id: s.id, projectId: s.project_id, feature: s.feature, targetType: s.target_type, targetId: s.target_id, inputSummary: s.input_summary, output: asJson<unknown>(s.output_json, null), provider: s.provider, model: s.model, status: s.status, appliedBy: s.applied_by, appliedAt: s.applied_at, appliedTargetId: s.applied_target_id, createdBy: s.created_by, createdAt: s.created_at };
}

export async function createProviderFromConfig(cfg: Config): Promise<AiProvider> {
  switch (cfg.aiProvider) {
    case 'anthropic': { const m = await import('../ai/anthropic.js'); return new m.AnthropicProvider(cfg.anthropicApiKey ?? '', cfg.aiModel); }
    case 'openai': { const m = await import('../ai/openai.js'); return new m.OpenAiProvider(cfg.openaiApiKey ?? '', cfg.aiModel); }
    case 'mock': return new MockProvider();
    default: return new NoneProvider();
  }
}

export class AiService {
  constructor(private db: Db, private cfg: Config, private audit: AuditService, public provider: AiProvider, private scenarios: ScenarioService) {}

  get enabled(): boolean { return this.provider.name !== 'none'; }

  /** Org-level switch (defaults to off) on top of the server-level provider. */
  private async orgAllows(orgId: string): Promise<{ enabled: boolean; sendArtifacts: boolean }> {
    const o = await this.db.get<{ settings_json: string | null }>(`SELECT settings_json FROM organizations WHERE id = ?`, [orgId]);
    const s = asJson<{ ai?: { enabled?: boolean; sendArtifacts?: boolean } }>(o?.settings_json, {});
    return { enabled: !!s.ai?.enabled, sendArtifacts: !!s.ai?.sendArtifacts };
  }

  /**
   * Run a feature: policy check → redact input → provider → validate → persist suggestion.
   * Artifacts flagged `restricted` are never included; all text is passed through the redaction pipeline first.
   */
  async run(ctx: Ctx, p: ProjectRow, feature: AiFeatureName, input: Record<string, unknown>, opts: { targetType?: string; targetId?: string; secrets?: string[]; restrictedExcluded?: number; artifactsRedacted?: number } = {}) {
    const started = Date.now();
    const org = await this.orgAllows(p.org_id);
    if (!this.enabled || !org.enabled) {
      await this.record(p, feature, 'disabled', started, 'ai_disabled', opts);
      throw new HttpError(409, 'ai_disabled', this.enabled ? 'AI assistance is disabled for this organization (Settings → AI)' : 'AI assistance is disabled on this server (PROOFFLOW_AI_PROVIDER=none)');
    }
    const safeInput = redactDeep(input, { secrets: opts.secrets ?? [] });
    const { system, user } = buildPrompt(feature, safeInput);
    let result;
    try {
      result = await this.provider.complete({ feature, system, user, jsonSchema: jsonSchemaFor(feature), maxTokens: 16_000 });
    } catch (e) {
      await this.record(p, feature, 'error', started, e instanceof Error ? e.message.slice(0, 500) : 'error', opts);
      if (e instanceof AiDisabledError) throw new HttpError(409, 'ai_disabled', e.message);
      throw new HttpError(502, 'ai_provider_error', 'AI provider call failed', { message: e instanceof Error ? e.message : String(e) });
    }
    const parsed = OUTPUT_SCHEMAS[feature].safeParse(result.json);
    if (!parsed.success) {
      await this.record(p, feature, 'invalid_output', started, 'schema validation failed', opts, result);
      throw new HttpError(502, 'ai_invalid_output', 'AI output did not match the expected schema', parsed.error.issues.slice(0, 10));
    }
    const id = ulid();
    await this.db.run(`INSERT INTO ai_suggestions (id, org_id, project_id, feature, target_type, target_id, input_summary, output_json, provider, model, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, p.org_id, p.id, feature, opts.targetType ?? null, opts.targetId ?? null, JSON.stringify(safeInput).slice(0, 2000), JSON.stringify(parsed.data), this.provider.name, result.model, 'proposed', ctx.actor.id, nowIso()]);
    await this.record(p, feature, 'ok', started, null, opts, result);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'ai.suggest', targetType: 'ai_suggestion', targetId: id, projectId: p.id, after: { feature, provider: this.provider.name, model: result.model, targetType: opts.targetType ?? null, targetId: opts.targetId ?? null }, ip: ctx.ip });
    return suggestionView((await this.db.get<SuggestionRow>(`SELECT * FROM ai_suggestions WHERE id = ?`, [id]))!);
  }
  private async record(p: ProjectRow, feature: string, status: string, started: number, error: string | null, opts: { restrictedExcluded?: number; artifactsRedacted?: number }, result?: { model: string; inputTokens?: number; outputTokens?: number }) {
    await this.db.run(`INSERT INTO ai_invocations (id, org_id, project_id, feature, provider, model, input_tokens, output_tokens, duration_ms, artifacts_redacted, restricted_excluded, status, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ulid(), p.org_id, p.id, feature, this.provider.name, result?.model ?? null, result?.inputTokens ?? null, result?.outputTokens ?? null, Date.now() - started, opts.artifactsRedacted ?? 0, opts.restrictedExcluded ?? 0, status, error, nowIso()]);
  }

  async list(projectId: string, opts: { feature?: string; status?: string; targetId?: string; limit?: number } = {}) {
    const where = ['project_id = ?']; const params: (string | number)[] = [projectId];
    if (opts.feature) { where.push('feature = ?'); params.push(opts.feature); }
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.targetId) { where.push('target_id = ?'); params.push(opts.targetId); }
    params.push(Math.min(opts.limit ?? 50, 200));
    return (await this.db.all<SuggestionRow>(`SELECT * FROM ai_suggestions WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params)).map(suggestionView);
  }
  async getRow(id: string, projectId: string): Promise<SuggestionRow> {
    const s = await this.db.get<SuggestionRow>(`SELECT * FROM ai_suggestions WHERE id = ? AND project_id = ?`, [id, projectId]);
    if (!s) throw notFound('ai suggestion');
    return s;
  }
  async reject(ctx: Ctx, p: ProjectRow, id: string, reason?: string) {
    const s = await this.getRow(id, p.id);
    await this.db.run(`UPDATE ai_suggestions SET status = 'rejected' WHERE id = ?`, [s.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'ai.reject', targetType: 'ai_suggestion', targetId: s.id, projectId: p.id, after: { reason: reason ?? null }, ip: ctx.ip });
  }
  /** Apply a scenario draft: creates real scenarios through the normal (audited, permission-checked) path. Expected stays null when the AI could not source it. */
  async applyScenarioDraft(ctx: Ctx, p: ProjectRow, id: string, pick: { indexes?: number[]; requirementIds?: string[] }) {
    const s = await this.getRow(id, p.id);
    if (s.feature !== 'scenario_draft') throw badRequest('not a scenario draft');
    if (s.status === 'applied') throw badRequest('already applied');
    const out = OUTPUT_SCHEMAS.scenario_draft.parse(asJson(s.output_json, {}));
    const idx = pick.indexes ?? out.drafts.map((_, i) => i);
    const created: string[] = [];
    for (const i of idx) {
      const d = out.drafts[i]; if (!d) continue;
      const sc = await this.scenarios.create(ctx, p, { title: d.title, steps: d.steps, expected: d.expectedSource === 'unspecified' ? undefined : (d.expected ?? undefined), priority: d.priority, tags: [...d.tags, 'ai-draft'], requirementIds: pick.requirementIds ?? (s.target_type === 'requirement' && s.target_id ? [s.target_id] : []), status: 'draft', origin: 'ai_draft', changeReason: `applied from AI suggestion ${s.id}`, fromAiSuggestionId: s.id });
      created.push(sc.id);
    }
    await this.db.run(`UPDATE ai_suggestions SET status = 'applied', applied_by = ?, applied_at = ?, applied_target_id = ? WHERE id = ?`, [ctx.actor.id, nowIso(), created.join(','), s.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'ai.apply', targetType: 'ai_suggestion', targetId: s.id, projectId: p.id, after: { feature: s.feature, createdScenarioIds: created }, ip: ctx.ip });
    return { scenarioIds: created };
  }
  async markApplied(ctx: Ctx, p: ProjectRow, suggestionId: string, appliedTargetId: string) {
    await this.db.run(`UPDATE ai_suggestions SET status = 'applied', applied_by = ?, applied_at = ?, applied_target_id = ? WHERE id = ?`, [ctx.actor.id, nowIso(), appliedTargetId, suggestionId]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'ai.apply', targetType: 'ai_suggestion', targetId: suggestionId, projectId: p.id, after: { appliedTargetId }, ip: ctx.ip });
  }
  async usage(orgId: string, period?: string) {
    const p = period ?? nowIso().slice(0, 7);
    return this.db.all(`SELECT feature, provider, status, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens FROM ai_invocations WHERE org_id = ? AND created_at >= ? GROUP BY feature, provider, status`, [orgId, `${p}-01`]);
  }
  featureName(f: string): AiFeatureName { if (!(f in OUTPUT_SCHEMAS)) throw badRequest(`unknown AI feature ${f}`); return f as AiFeature & AiFeatureName; }
}
