import { join } from 'node:path';
import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import { AuditService } from './audit.js';
import { AuthService } from './auth.js';
import { OrgService } from './orgs.js';
import { ProjectService } from './projects.js';
import { RequirementService } from './requirements.js';
import { ScenarioService } from './scenarios.js';
import { AiService, createProviderFromConfig } from './ai.js';
import { ArtifactService } from './artifacts.js';
import { RunService } from './runs.js';
import { LocalArtifactStore, type ArtifactStore } from '../storage/store.js';
import { FixtureService } from './fixtures.js';
import { OpenApiService } from './openapi.js';
import { VisualService } from './visual.js';
import { DefectService } from './defects.js';
import { AiAssistService } from './ai-assist.js';
import { ReleaseService } from './release.js';
import { ManualService } from './manual.js';
import { IntegrationService } from './integration.js';
import { asJson } from '../db/db.js';
import { ulid } from '@proofflow/shared';
import type { AiProvider } from '../ai/provider.js';

export interface Services { db: Db; cfg: Config; audit: AuditService; auth: AuthService; orgs: OrgService; projects: ProjectService; requirements: RequirementService; scenarios: ScenarioService; ai: AiService; artifacts: ArtifactService; artifactStore: ArtifactStore; fixtureStore: ArtifactStore; runs: RunService; fixtures: FixtureService; openapi: OpenApiService; visual: VisualService; defects: DefectService; aiAssist: AiAssistService; release: ReleaseService; manual: ManualService; integration: IntegrationService; }

export async function createServices(db: Db, cfg: Config, opts: { aiProvider?: AiProvider; artifactStore?: ArtifactStore } = {}): Promise<Services> {
  const audit = new AuditService(db);
  const auth = new AuthService(db, cfg, audit);
  const orgs = new OrgService(db, audit);
  const projects = new ProjectService(db, cfg, audit);
  const requirements = new RequirementService(db, audit, projects);
  const scenarios = new ScenarioService(db, audit, projects);
  const provider = opts.aiProvider ?? (await createProviderFromConfig(cfg));
  const ai = new AiService(db, cfg, audit, provider, scenarios);
  const artifactStore = opts.artifactStore ?? new LocalArtifactStore(join(cfg.dataDir, 'artifacts'));
  const fixtureStore = new LocalArtifactStore(join(cfg.dataDir, 'fixtures'));
  const artifacts = new ArtifactService(db, cfg, artifactStore, audit);
  const runs = new RunService(db, cfg, audit, projects, scenarios, artifacts);
  const fixtures = new FixtureService(db, fixtureStore, audit);
  const openapi = new OpenApiService(db, audit);
  const visual = new VisualService(db, audit, artifacts);
  const defects = new DefectService(db, audit, projects, runs, artifacts);
  const aiAssist = new AiAssistService(db, ai, runs, artifacts, artifactStore, defects, scenarios);
  const release = new ReleaseService(db, audit, projects, artifacts, visual);
  const manual = new ManualService(db, audit, projects, artifacts);
  const integration = new IntegrationService(db, audit, scenarios, requirements, runs);
  // Result hook: persist visual comparisons and crawl inventory from runner checks; group failures / reopen defects.
  runs.onResult = async (resultId, run, c, fingerprint) => {
    await defects.onResult(resultId, run, c, fingerprint);
    const r = await runs.getResult(resultId);
    await visual.ingest(run, resultId, c, r.browser, asJson(r.viewport_json, { width: 0, height: 0 }), r.scenario_id);
    const crawl = (c.checks as { crawlPages?: Array<{ url: string; status: number; title?: string; forms?: unknown[]; linksCount?: number }> } | null)?.crawlPages;
    if (crawl?.length) {
      await db.run(`DELETE FROM crawl_inventory WHERE environment_id = ?`, [run.environment_id]);
      for (const pg of crawl.slice(0, 2000)) await db.run(`INSERT INTO crawl_inventory (id, org_id, project_id, environment_id, run_id, url, title, status_code, kind, forms_json, links_count, discovered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [ulid(), run.org_id, run.project_id, run.environment_id, run.id, pg.url, pg.title ?? null, pg.status, (pg.forms?.length ?? 0) > 0 ? 'form_page' : 'page', JSON.stringify(pg.forms ?? []), pg.linksCount ?? null, new Date().toISOString()]);
    }
  };
  runs.onRunCompleted = async (run) => { await defects.onRunCompleted(run); };
  return { db, cfg, audit, auth, orgs, projects, requirements, scenarios, ai, artifacts, artifactStore, fixtureStore, runs, fixtures, openapi, visual, defects, aiAssist, release, manual, integration };
}
