import type { Db } from '../db/db.js';
import { asJson } from '../db/db.js';
import { redactDeep, type Step } from '@proofflow/shared';
import { badRequest, type Ctx } from '../context.js';
import type { AiService } from './ai.js';
import type { ProjectRow } from './projects.js';
import type { RunService } from './runs.js';
import type { ArtifactService } from './artifacts.js';
import type { ArtifactStore } from '../storage/store.js';
import type { DefectService } from './defects.js';
import type { ScenarioService } from './scenarios.js';
import { OUTPUT_SCHEMAS } from '../ai/features.js';

/**
 * AI assistance on failures: summary / defect draft / selector repair.
 * Evidence policy: artifact excerpts are sent only when the organization allows it (ai.sendArtifacts),
 * never for `restricted` artifacts, and always after redaction. AI output never modifies results.
 */
export class AiAssistService {
  constructor(private db: Db, private ai: AiService, private runs: RunService, private artifacts: ArtifactService, private store: ArtifactStore, private defects: DefectService, private scenarios: ScenarioService) {}

  private async orgSendsArtifacts(orgId: string): Promise<boolean> {
    const o = await this.db.get<{ settings_json: string | null }>(`SELECT settings_json FROM organizations WHERE id = ?`, [orgId]);
    return !!asJson<{ ai?: { sendArtifacts?: boolean } }>(o?.settings_json, {}).ai?.sendArtifacts;
  }
  private async readArtifactText(id: string, max = 20_000): Promise<string | null> {
    const row = await this.artifacts.getRow(id);
    if (!row || row.deleted_at || !this.store.exists(row.storage_key)) return null;
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of this.store.getStream(row.storage_key)) { chunks.push(c as Buffer); size += (c as Buffer).length; if (size > max) break; }
    return Buffer.concat(chunks).toString('utf8').slice(0, max);
  }
  /** Gather redacted, policy-filtered evidence for a result. */
  private async evidenceInput(p: ProjectRow, resultId: string, opts: { includeDom?: boolean } = {}) {
    const r = await this.runs.getResult(resultId, p.id);
    const run = await this.runs.getRow(r.run_id);
    const scenario = await this.db.get<{ key: string; title: string; steps_json: string; expected: string | null }>(`SELECT key, title, steps_json, expected FROM scenarios WHERE id = ?`, [r.scenario_id]);
    const sendArtifacts = await this.orgSendsArtifacts(p.org_id);
    const arts = await this.artifacts.listForResult(r.id);
    let restrictedExcluded = 0; let artifactsRedacted = 0;
    const excerpts: Record<string, string> = {};
    if (sendArtifacts) {
      for (const a of arts) {
        if (a.restricted) { restrictedExcluded++; continue; }
        if (a.kind === 'console' || a.kind === 'network' || (opts.includeDom && a.kind === 'dom')) {
          const text = await this.readArtifactText(a.id, a.kind === 'dom' ? 30_000 : 8_000);
          if (text != null) { excerpts[a.kind] = text; artifactsRedacted++; }
        }
      }
    } else { restrictedExcluded = arts.filter((a) => a.restricted).length; }
    const input = redactDeep({
      scenario: { key: scenario?.key, title: scenario?.title, expected: scenario?.expected, steps: asJson<Step[]>(scenario?.steps_json, []) },
      result: { status: r.status, outcomeDetail: r.outcome_detail, browser: r.browser, browserVersion: r.browser_version, viewport: asJson(r.viewport_json, {}), failure: asJson(r.failure_json, null), steps: asJson(r.steps_json, []), consoleSummary: asJson(r.console_summary_json, null), networkSummary: asJson(r.network_summary_json, null), checks: asJson(r.checks_json, null) },
      run: { id: run.id, environmentId: run.environment_id, commitSha: run.commit_sha, branch: run.branch },
      artifactExcerpts: excerpts, artifactPolicy: { sendArtifacts, restrictedExcluded },
    }, {});
    return { r, input, restrictedExcluded, artifactsRedacted };
  }
  async failureSummary(ctx: Ctx, p: ProjectRow, resultId: string) {
    const { input, restrictedExcluded, artifactsRedacted } = await this.evidenceInput(p, resultId);
    return this.ai.run(ctx, p, 'failure_summary', input, { targetType: 'result', targetId: resultId, restrictedExcluded, artifactsRedacted });
  }
  async defectDraft(ctx: Ctx, p: ProjectRow, resultId: string) {
    const { input, restrictedExcluded, artifactsRedacted } = await this.evidenceInput(p, resultId);
    return this.ai.run(ctx, p, 'defect_draft', input, { targetType: 'result', targetId: resultId, restrictedExcluded, artifactsRedacted });
  }
  async selectorRepair(ctx: Ctx, p: ProjectRow, resultId: string) {
    const { r, input, restrictedExcluded, artifactsRedacted } = await this.evidenceInput(p, resultId, { includeDom: true });
    const f = asJson<{ stepIndex?: number; type: string } | null>(r.failure_json, null);
    if (!f || (f.type !== 'locator_not_found' && f.type !== 'timeout')) throw badRequest('selector repair applies to locator/timeout failures only');
    const steps = (input as { scenario: { steps: Step[] } }).scenario.steps;
    const failingStep = f.stepIndex !== undefined ? steps[f.stepIndex] : undefined;
    return this.ai.run(ctx, p, 'selector_repair', { ...input, failingStepIndex: f.stepIndex, failingStep }, { targetType: 'result', targetId: resultId, restrictedExcluded, artifactsRedacted });
  }
  /** Apply a defect draft: creates a real defect through the normal path (audited; the result is untouched). */
  async applyDefectDraft(ctx: Ctx, p: ProjectRow, suggestionId: string) {
    const s = await this.ai.getRow(suggestionId, p.id);
    if (s.feature !== 'defect_draft') throw badRequest('not a defect draft');
    if (s.status === 'applied') throw badRequest('already applied');
    const out = OUTPUT_SCHEMAS.defect_draft.parse(asJson(s.output_json, {}));
    const resultId = s.target_type === 'result' ? s.target_id : null;
    let scenarioIds: string[] = []; let artifactIds: string[] = []; let envId: string | undefined; let browser: string | undefined;
    if (resultId) { const r = await this.runs.getResult(resultId, p.id); scenarioIds = [r.scenario_id]; artifactIds = (await this.artifacts.listForResult(r.id)).map((a) => a.id); envId = (await this.runs.getRow(r.run_id)).environment_id; browser = r.browser; }
    const d = await this.defects.create(ctx, p, { title: out.title, severity: out.severity, priority: out.priority, reproduction: out.reproduction, expected: out.expected, actual: out.actual, resultIds: resultId ? [resultId] : [], scenarioIds, artifactIds, environmentId: envId, browser, fromAiSuggestionId: s.id });
    await this.ai.markApplied(ctx, p, s.id, d.id);
    return d;
  }
  /** Apply a selector repair candidate: edits the scenario step (new version, audited). The failed result stays failed; a rerun is required. */
  async applySelectorRepair(ctx: Ctx, p: ProjectRow, suggestionId: string, candidateIndex: number) {
    const s = await this.ai.getRow(suggestionId, p.id);
    if (s.feature !== 'selector_repair') throw badRequest('not a selector repair');
    if (s.status === 'applied') throw badRequest('already applied');
    const out = OUTPUT_SCHEMAS.selector_repair.parse(asJson(s.output_json, {}));
    const cand = out.candidates[candidateIndex];
    if (!cand) throw badRequest('candidate not found');
    if (!s.target_id) throw badRequest('suggestion has no target result');
    const r = await this.runs.getResult(s.target_id, p.id);
    const f = asJson<{ stepIndex?: number } | null>(r.failure_json, null);
    if (f?.stepIndex === undefined) throw badRequest('result has no failing step index');
    const sc = await this.scenarios.getRow(r.scenario_id, p.id);
    const steps = asJson<Step[]>(sc.steps_json, []);
    const step = steps[f.stepIndex] as (Step & { target?: unknown }) | undefined;
    if (!step || !('target' in step)) throw badRequest('failing step has no target');
    const nextSteps = steps.map((st, i) => (i === f.stepIndex ? { ...st, target: cand.target } : st));
    const updated = await this.scenarios.update(ctx, p, sc, { steps: nextSteps, changeReason: `AI selector repair candidate ${candidateIndex} applied from suggestion ${s.id} (reviewed by ${ctx.actor.name})` });
    await this.ai.markApplied(ctx, p, s.id, updated.id);
    return { scenario: updated, rerunRequired: true, resultId: r.id, resultStatus: r.status };
  }
}
