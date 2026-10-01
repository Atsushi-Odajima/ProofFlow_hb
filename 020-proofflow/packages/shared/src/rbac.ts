export const ROLES = ['owner', 'admin', 'qa_lead', 'tester', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner', admin: 'Admin', qa_lead: 'QA Lead', tester: 'Tester', developer: 'Developer', viewer: 'Viewer',
};

// Higher number = more privilege. Used only for "role at most" comparisons (service tokens).
export const ROLE_RANK: Record<Role, number> = { viewer: 0, developer: 1, tester: 2, qa_lead: 3, admin: 4, owner: 5 };

export const PERMISSIONS = [
  'org:read', 'org:manage', 'org:members', 'org:billing',
  'workspace:read', 'workspace:write',
  'project:read', 'project:write', 'project:delete',
  'environment:read', 'environment:write',
  'secret:read_meta', 'secret:write',
  'requirement:read', 'requirement:write',
  'scenario:read', 'scenario:write', 'scenario:delete',
  'suite:read', 'suite:write',
  'run:read', 'run:trigger', 'run:cancel', 'run:trigger_destructive',
  'artifact:read', 'artifact:read_restricted', 'artifact:delete',
  'baseline:read', 'baseline:update',
  'defect:read', 'defect:write', 'defect:close',
  'release:read', 'release:write', 'release:approve', 'release:accept_risk',
  'manual:read', 'manual:write',
  'exploratory:read', 'exploratory:write',
  'schedule:read', 'schedule:write',
  'ai:use', 'ai:apply',
  'audit:read',
  'backup:export', 'backup:restore',
  'token:create_personal', 'token:create_service', 'runner:manage',
  'domain:verify', 'retention:manage', 'notification:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS] as Permission[];
const READ_ONLY: Permission[] = ALL.filter((p) => p.endsWith(':read') || p === 'secret:read_meta' || p === 'artifact:read' || p === 'baseline:read');

const DEVELOPER: Permission[] = [
  ...READ_ONLY,
  'scenario:write', 'suite:write', 'run:trigger', 'run:cancel', 'defect:write', 'ai:use', 'token:create_personal',
  'manual:write', 'exploratory:write',
];
const TESTER: Permission[] = [
  ...DEVELOPER, 'requirement:write', 'artifact:read_restricted', 'release:write',
];
const QA_LEAD: Permission[] = [
  ...TESTER, 'baseline:update', 'defect:close', 'release:approve', 'release:accept_risk', 'ai:apply',
  'schedule:write', 'run:trigger_destructive', 'scenario:delete', 'environment:write', 'project:write',
  'token:create_service', 'audit:read', 'domain:verify', 'notification:manage',
];
const ADMIN: Permission[] = [
  ...QA_LEAD, 'org:members', 'workspace:write', 'secret:write', 'project:delete', 'artifact:delete', 'runner:manage',
  'retention:manage', 'backup:export', 'backup:restore', 'org:manage',
];
const OWNER: Permission[] = ALL;

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(READ_ONLY),
  developer: new Set(DEVELOPER),
  tester: new Set(TESTER),
  qa_lead: new Set(QA_LEAD),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

export function roleHas(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(perm);
}
