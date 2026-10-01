import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export interface PutResult { sizeBytes: number; sha256: string; }
/** Object storage abstraction. Local filesystem implementation ships; S3-compatible adapters implement the same interface (ARTIFACT_SECURITY.md). */
export interface ArtifactStore {
  put(key: string, body: Readable | Buffer, maxBytes?: number): Promise<PutResult>;
  getStream(key: string): Readable;
  exists(key: string): boolean;
  stat(key: string): { sizeBytes: number } | null;
  delete(key: string): Promise<boolean>;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }
  private path(key: string): string {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root))) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, body: Readable | Buffer, maxBytes = Infinity): Promise<PutResult> {
    const p = this.path(key); mkdirSync(dirname(p), { recursive: true });
    const hash = createHash('sha256'); let size = 0;
    if (Buffer.isBuffer(body)) {
      if (body.length > maxBytes) throw new Error('artifact too large');
      hash.update(body); size = body.length;
      await pipeline(Readable.from([body]), createWriteStream(p));
    } else {
      const counter = new Transform({ transform(chunk: Buffer, _e, cb) { size += chunk.length; if (size > maxBytes) return cb(new Error('artifact too large')); hash.update(chunk); cb(null, chunk); } });
      try { await pipeline(body, counter, createWriteStream(p)); } catch (e) { try { unlinkSync(p); } catch { /* ignore */ } throw e; }
    }
    return { sizeBytes: size, sha256: hash.digest('hex') };
  }
  getStream(key: string): Readable { return createReadStream(this.path(key)); }
  exists(key: string): boolean { return existsSync(this.path(key)); }
  stat(key: string) { const p = this.path(key); return existsSync(p) ? { sizeBytes: statSync(p).size } : null; }
  async delete(key: string): Promise<boolean> { const p = this.path(key); if (!existsSync(p)) return false; unlinkSync(p); return true; }
}
