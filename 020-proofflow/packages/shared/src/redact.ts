const DEFAULT_REDACT_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization', 'x-csrf-token'];
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk|pf|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g,      // common API key prefixes (incl. ProofFlow pf_)
  /\bAKIA[0-9A-Z]{16}\b/g,                                              // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,     // JWT
  /\b[0-9]{13,19}\b/g,                                                  // long digit runs (card-like numbers)
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,                           // emails (PII)
];
export const REDACTED = '[REDACTED]';

export interface RedactOptions { secrets?: string[]; headers?: string[]; piiPatterns?: boolean; }

export function redactString(input: string, opts: RedactOptions = {}): string {
  let s = input;
  for (const sec of opts.secrets ?? []) if (sec && sec.length >= 4) s = s.split(sec).join(REDACTED);
  if (opts.piiPatterns !== false) for (const re of SECRET_PATTERNS) s = s.replace(re, REDACTED);
  return s;
}

export function redactHeaders(headers: Record<string, string>, extra: string[] = []): Record<string, string> {
  const block = new Set([...DEFAULT_REDACT_HEADERS, ...extra.map((h) => h.toLowerCase())]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = block.has(k.toLowerCase()) ? REDACTED : v;
  return out;
}

export function redactDeep<T>(value: T, opts: RedactOptions = {}): T {
  if (typeof value === 'string') return redactString(value, opts) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, opts);
    return out as T;
  }
  return value;
}
