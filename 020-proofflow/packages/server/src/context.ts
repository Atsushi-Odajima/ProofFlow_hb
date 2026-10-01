import type { Permission, Role } from '@proofflow/shared';
import { roleHas, ROLE_RANK } from '@proofflow/shared';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) { super(message ?? code); }
}
export const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'forbidden') => new HttpError(403, 'forbidden', msg);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const unauthorized = (msg = 'authentication required') => new HttpError(401, 'unauthorized', msg);

export type ActorKind = 'user' | 'token' | 'runner' | 'system' | 'anonymous';
export interface Actor {
  kind: ActorKind;
  id: string | null;            // user id (user) or token id (token/runner)
  userId?: string;              // for personal tokens
  name: string;
  tokenOrgId?: string;          // tokens are bound to exactly one organization
  tokenRole?: Role;             // effective role cap for tokens
  projectIds?: string[] | null; // service token restriction (null = all projects in org)
  runnerId?: string;
}
export interface Ctx { actor: Actor; ip: string; requestId: string; }

export const ANON: Actor = { kind: 'anonymous', id: null, name: 'anonymous' };
export const SYSTEM: Actor = { kind: 'system', id: null, name: 'system' };

export function assertPermission(role: Role, perm: Permission): void {
  if (!roleHas(role, perm)) throw forbidden(`role ${role} lacks ${perm}`);
}
export function capRole(membershipRole: Role, actor: Actor): Role {
  if (actor.tokenRole && ROLE_RANK[actor.tokenRole] < ROLE_RANK[membershipRole]) return actor.tokenRole;
  return membershipRole;
}
