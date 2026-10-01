import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import { AuditService } from './audit.js';
import { AuthService } from './auth.js';
import { OrgService } from './orgs.js';
import { ProjectService } from './projects.js';
import { RequirementService } from './requirements.js';
import { ScenarioService } from './scenarios.js';
import { AiService, createProviderFromConfig } from './ai.js';
import type { AiProvider } from '../ai/provider.js';

export interface Services { db: Db; cfg: Config; audit: AuditService; auth: AuthService; orgs: OrgService; projects: ProjectService; requirements: RequirementService; scenarios: ScenarioService; ai: AiService; }

export async function createServices(db: Db, cfg: Config, opts: { aiProvider?: AiProvider } = {}): Promise<Services> {
  const audit = new AuditService(db);
  const auth = new AuthService(db, cfg, audit);
  const orgs = new OrgService(db, audit);
  const projects = new ProjectService(db, cfg, audit);
  const requirements = new RequirementService(db, audit, projects);
  const scenarios = new ScenarioService(db, audit, projects);
  const provider = opts.aiProvider ?? (await createProviderFromConfig(cfg));
  const ai = new AiService(db, cfg, audit, provider, scenarios);
  return { db, cfg, audit, auth, orgs, projects, requirements, scenarios, ai };
}
