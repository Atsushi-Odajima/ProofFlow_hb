import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import { AuditService } from './audit.js';
import { AuthService } from './auth.js';
import { OrgService } from './orgs.js';
import { ProjectService } from './projects.js';

export interface Services { db: Db; cfg: Config; audit: AuditService; auth: AuthService; orgs: OrgService; projects: ProjectService; }

export function createServices(db: Db, cfg: Config): Services {
  const audit = new AuditService(db);
  const auth = new AuthService(db, cfg, audit);
  const orgs = new OrgService(db, audit);
  const projects = new ProjectService(db, cfg, audit);
  return { db, cfg, audit, auth, orgs, projects };
}
