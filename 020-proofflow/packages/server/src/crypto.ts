import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = scryptSync(password, Buffer.from(saltB64, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(keyB64, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export function sha256(s: string | Buffer): string { return createHash('sha256').update(s).digest('hex'); }
export function hmac(secret: string, s: string): string { return createHmac('sha256', secret).update(s).digest('base64url'); }
export function safeEqual(a: string, b: string): boolean { const ba = Buffer.from(a); const bb = Buffer.from(b); return ba.length === bb.length && timingSafeEqual(ba, bb); }

// AES-256-GCM. Output: v1.<keyId>.<iv b64>.<tag b64>.<ct b64>
export function encryptSecret(plain: string, key: Buffer, keyId = 'k1'): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${keyId}.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}
export function decryptSecret(blob: string, key: Buffer): string {
  const [v, , ivB64, tagB64, ctB64] = blob.split('.');
  if (v !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('bad secret blob');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}
export function newApiToken(kind: string): { token: string; prefix: string } {
  const p = kind === 'runner' ? 'pfr' : kind === 'service' ? 'pfs' : kind === 'mcp' ? 'pfm' : 'pf';
  const token = `${p}_${randomBytes(24).toString('base64url')}`;
  return { token, prefix: token.slice(0, 10) };
}
