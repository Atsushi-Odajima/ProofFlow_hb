import { createHash } from 'node:crypto';

export interface FailureInfo { type: string; message?: string; stepIndex?: number; stepType?: string; url?: string; locator?: string; status?: number; ruleId?: string; stack?: string; }

/** Normalize volatile parts (ids, numbers, timestamps, uuids) so similar failures share a fingerprint. */
export function normalizeMessage(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s"']+/g, (m) => { try { const u = new URL(m); return u.origin + u.pathname.replace(/\d+/g, '{n}'); } catch { return '{url}'; } })
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
    .replace(/[0-9A-HJKMNP-TV-Z]{26}/g, '{ulid}')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[^\s]*/g, '{ts}')
    .replace(/\b\d+(\.\d+)?(ms|s|px)\b/g, '{n}$2')
    .replace(/\b\d{3,}\b/g, '{n}')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

export function failureFingerprint(f: FailureInfo): string {
  const parts = [f.type, f.stepType ?? '', f.stepIndex ?? '', f.locator ?? '', f.ruleId ?? '', f.status ?? '', normalizeMessage(f.message ?? '')];
  if (f.url) { try { const u = new URL(f.url); parts.push(u.pathname.replace(/\d+/g, '{n}')); } catch { /* ignore */ } }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}
