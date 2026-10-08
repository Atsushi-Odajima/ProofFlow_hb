// ProofFlow 個人情報マスク — ported from ErrorRelay core/test/privacy.test.ts (tests 4, 5, 6) plus ProofFlow report-level masking.
// Not ported: redactDoctorOutput / redactApiBody (Codex / OpenAI specific) and the ZIP package tests (ZIP export not merged).
import { describe, it, expect } from 'vitest';
import { bugreport as br } from '@proofflow/shared';

const SECRET_TEXT = `Contact me at taro.yamada@example.com or 090-1234-5678.
API key: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd
Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789
token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U
ghp_abcdefghijklmnopqrstuvwxyz0123456789
path /Users/taroyamada/Projects/app/main.py
card 4111 1111 1111 1111
OTP: 123456
password: hunter2!!`;

describe('privacy scanner & redaction (ErrorRelay tests 4, 5)', () => {
  it('detects the major categories', () => {
    const f = br.scanText(SECRET_TEXT);
    const cats = new Set(f.map((x) => x.category));
    for (const c of ['email', 'phone', 'api_key', 'jwt', 'access_token', 'file_path_username', 'credit_card', 'otp', 'password']) expect(cats, c).toContain(c);
  });
  it('redacted output contains none of the original secrets and no partial masks', () => {
    const f = br.scanText(SECRET_TEXT);
    const r = br.redactText(SECRET_TEXT, f);
    expect(br.containsAnyOriginal(r.redacted, f)).toEqual([]);
    expect(r.redacted).toContain('[REDACTED_API_KEY_1]');
    expect(r.redacted).not.toContain('sk-proj');
    expect(r.redacted).not.toContain('example.com');
    expect(r.redacted).not.toContain('4111');
    expect(JSON.stringify(r.summary)).not.toContain('hunter2');
  });
  it('user can keep a category', () => {
    const f = br.scanText('mail me: a@b.co');
    const r = br.redactText('mail me: a@b.co', f, { email: 'keep' });
    expect(r.redacted).toContain('a@b.co');
    expect(r.summary.keptCategories).toEqual(['email']);
  });
  it('redacts headers by key in JSON', () => {
    const { value } = br.redactJsonValue({ headers: { Authorization: 'Bearer abc', 'x-request-id': 'req_1234567890' }, body: 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
    expect(value.headers.Authorization).toBe('[REDACTED]');
    expect(value.headers['x-request-id']).toBe('req_1234567890');
    expect(value.body).toMatch(/REDACTED_API_KEY/);
  });
  it('Luhn-invalid digit runs are not reported as cards; 127.x is not an IP finding', () => {
    expect(br.scanText('order 1234 5678 9012 3456').some((f) => f.category === 'credit_card')).toBe(false);
    expect(br.scanText('host 127.0.0.1 and 203.0.113.9').filter((f) => f.category === 'ip_address').map((f) => f.match)).toEqual(['203.0.113.9']);
  });
  it('detects Japanese address / name fields and URL tokens', () => {
    const f = br.scanText('お名前：山田太郎\n〒100-0001 東京都千代田区1-1\nhttps://app.example.com/reset?token=abcdef123456');
    const cats = new Set(f.map((x) => x.category));
    expect(cats).toContain('person_name');
    expect(cats).toContain('postal_address');
    expect(cats).toContain('url_with_token');
  });
});

function minimalJpegWithExif(): Uint8Array {
  const soi = [0xff, 0xd8];
  const exifPayload = [...new TextEncoder().encode('Exif\0\0IIxx2026:09:30 10:20:00')];
  const app1 = [0xff, 0xe1, (exifPayload.length + 2) >> 8, (exifPayload.length + 2) & 0xff, ...exifPayload];
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
  const sos = [0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0x03, 0xff, 0xd9];
  return Uint8Array.from([...soi, ...app0, ...app1, ...sos]);
}
function minimalPngWithText(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  return Uint8Array.from([...sig, ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]), ...chunk('tEXt', [...new TextEncoder().encode('Author\0Taro')]), ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND', [])]);
}

describe('EXIF / metadata stripping (ErrorRelay test 6)', () => {
  it('removes APP1 from JPEG and keeps image data', () => {
    const j = minimalJpegWithExif();
    expect(br.detectImageType(j)).toBe('jpeg');
    const r = br.stripImageMetadata(j);
    expect(r.removed).toContain('APP1');
    const s = new TextDecoder('latin1').decode(r.bytes);
    expect(s).not.toContain('2026:09:30');
    expect(r.bytes[r.bytes.length - 1]).toBe(0xd9);
  });
  it('removes tEXt from PNG', () => {
    const p = minimalPngWithText();
    const r = br.stripImageMetadata(p);
    expect(r.removed).toEqual(['tEXt']);
    expect(new TextDecoder('latin1').decode(r.bytes)).not.toContain('Taro');
    expect(new TextDecoder('latin1').decode(r.bytes)).toContain('IDAT');
  });
  it('unsupported formats are reported as unsupported, not silently passed as stripped', () => {
    const r = br.stripImageMetadata(Uint8Array.from([1, 2, 3]));
    expect(r.supported).toBe(false);
  });
});

describe('ProofFlow 個人情報マスク over a whole report', () => {
  const content = (over: Partial<br.BugReportContent> = {}): br.BugReportContent => ({ title: 'Login fails for taro@example.com', description: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789 in the log', expected: '', actual: 'card 4111 1111 1111 1111 rejected', steps: ['Open /login', 'type password: hunter2!!'], errorText: '', frequency: 'always', occurredAt: null, environment: { ...br.emptyEnvironment(), pageUrl: { value: 'https://app.example.com/cb?token=supersecret123', source: 'auto' } }, reporterName: '', additionalNotes: '', language: 'ja', ...over });
  it('masks every field including steps and environment values; findings carry no matched text', () => {
    const s = br.sanitizeReport(content());
    const json = JSON.stringify(s.content);
    for (const leak of ['taro@example.com', 'abcdefghijklmnopqrstuvwxyz0123456789', '4111', 'hunter2', 'supersecret123']) expect(json).not.toContain(leak);
    expect(s.content.environment.pageUrl.value).toMatch(/REDACTED_URL_WITH_TOKEN/);
    expect(JSON.stringify(s.findings)).not.toContain('taro@example.com');
    expect(new Set(s.findings.map((f) => f.field))).toEqual(new Set(['title', 'description', 'actual', 'steps.1', 'environment.pageUrl']));
    expect(s.summary.counts.email).toBe(1);
  });
  it('keep is honoured for low-risk categories only (high-risk are always masked)', () => {
    const s = br.sanitizeReport(content(), { email: 'keep', credit_card: 'keep', password: 'keep' });
    expect(s.content.title).toContain('taro@example.com');
    expect(s.content.actual).not.toContain('4111');
    expect(s.content.steps[1]).not.toContain('hunter2');
    expect(s.summary.keptCategories).toEqual(['email']);
    expect(br.effectiveDecisions({ email: 'keep', jwt: 'keep' })).toEqual({ email: 'keep' });
  });
});
