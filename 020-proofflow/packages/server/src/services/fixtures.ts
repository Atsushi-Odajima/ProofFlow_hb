import type { Db } from '../db/db.js';
import { nowIso } from '../db/db.js';
import { ulid } from '@proofflow/shared';
import { badRequest, conflict, notFound, type Ctx } from '../context.js';
import type { ArtifactStore } from '../storage/store.js';
import type { AuditService } from './audit.js';
import type { ProjectRow } from './projects.js';
import type { Readable } from 'node:stream';

const ALLOWED_FIXTURE_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/(plain|csv)|application\/json|application\/zip|application\/octet-stream|video\/(mp4|webm))$/;
const BLOCKED_EXT = /\.(exe|bat|cmd|sh|ps1|msi|dll|com|scr|js|jar|app)$/i;

/** Fixture files used by `upload` steps. Stored server-side; runners download them through signed URLs. Executables are refused. */
export class FixtureService {
  constructor(private db: Db, private store: ArtifactStore, private audit: AuditService) {}
  async list(projectId: string) { return this.db.all(`SELECT id, name, content_type, size_bytes, created_at FROM fixtures WHERE project_id = ? ORDER BY name`, [projectId]); }
  async put(ctx: Ctx, p: ProjectRow, name: string, contentType: string, body: Readable | Buffer, opts: { allowUnsafeForTesting?: boolean } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(name)) throw badRequest('invalid fixture name');
    if (BLOCKED_EXT.test(name) && !opts.allowUnsafeForTesting) throw badRequest('executable fixtures are not allowed');
    if (!ALLOWED_FIXTURE_TYPES.test(contentType) && !opts.allowUnsafeForTesting) throw badRequest(`fixture content type ${contentType} not allowed`);
    if (await this.db.get(`SELECT 1 FROM fixtures WHERE project_id = ? AND name = ?`, [p.id, name])) throw conflict('fixture name exists (delete it first)');
    const id = ulid(); const key = `${p.org_id}/${p.id}/${id}`;
    const put = await this.store.put(key, body, 50 * 1024 * 1024);
    await this.db.run(`INSERT INTO fixtures (id, org_id, project_id, name, content_type, size_bytes, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?)`, [id, p.org_id, p.id, name, contentType, put.sizeBytes, key, nowIso()]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'fixture.create', targetType: 'fixture', targetId: id, projectId: p.id, after: { name, contentType, sizeBytes: put.sizeBytes }, ip: ctx.ip });
    return { id, name, contentType, sizeBytes: put.sizeBytes };
  }
  async remove(ctx: Ctx, p: ProjectRow, id: string) {
    const f = await this.db.get<{ id: string; name: string; storage_key: string }>(`SELECT id, name, storage_key FROM fixtures WHERE id = ? AND project_id = ?`, [id, p.id]);
    if (!f) throw notFound('fixture');
    await this.store.delete(f.storage_key);
    await this.db.run(`DELETE FROM fixtures WHERE id = ?`, [f.id]);
    await this.audit.log({ orgId: p.org_id, actor: ctx.actor, action: 'fixture.delete', targetType: 'fixture', targetId: f.id, projectId: p.id, before: { name: f.name }, ip: ctx.ip });
  }
}
