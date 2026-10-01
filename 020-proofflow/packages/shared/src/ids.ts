import { randomBytes } from 'node:crypto';

// Crockford base32 ULID: 48-bit time + 80-bit randomness. Time-sortable, globally unique.
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let time = now;
  let t = '';
  for (let i = 9; i >= 0; i--) {
    t = ENC[time % 32] + t;
    time = Math.floor(time / 32);
  }
  const rnd = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += ENC[(rnd[i] as number) % 32];
  return t + r;
}

export function isUlid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
