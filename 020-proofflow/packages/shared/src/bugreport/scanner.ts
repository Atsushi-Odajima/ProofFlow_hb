// Ported from ErrorRelay core (privacy/scanner.ts, SCANNER_VERSION 1.0.0) — ProofFlow 個人情報マスク. Keep rules in sync with docs/BUG_REPORT_INTAKE.md.
export const SCANNER_VERSION = "1.0.0";

export type FindingCategory =
  | "email"
  | "phone"
  | "api_key"
  | "access_token"
  | "session_token"
  | "jwt"
  | "password"
  | "otp"
  | "credit_card"
  | "account_id"
  | "file_path_username"
  | "ip_address"
  | "postal_address"
  | "person_name"
  | "private_conversation"
  | "url_with_token";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  category: FindingCategory;
  severity: Severity;
  start: number;
  end: number;
  /** The raw matched text. Kept in memory only; never written to exports. */
  match: string;
  /** Human hint (no secret content). */
  hint: string;
}

interface Rule {
  category: FindingCategory;
  severity: Severity;
  re: RegExp;
  hint: string;
  validate?: (m: string) => boolean;
}

function luhn(num: string): boolean {
  const digits = num.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const RULES: Rule[] = [
  { category: "api_key", severity: "high", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}\b/g, hint: "OpenAI-style API key" },
  { category: "api_key", severity: "high", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, hint: "GitHub token" },
  { category: "api_key", severity: "high", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, hint: "GitHub fine-grained token" },
  { category: "api_key", severity: "high", re: /\bAKIA[0-9A-Z]{16}\b/g, hint: "AWS access key id" },
  { category: "api_key", severity: "high", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, hint: "Slack token" },
  { category: "api_key", severity: "high", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, hint: "Google API key" },
  { category: "api_key", severity: "high", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, hint: "Anthropic API key" },
  { category: "api_key", severity: "high", re: /(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret)\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{12,})["']?/gi, hint: "key=value style secret" },
  { category: "access_token", severity: "high", re: /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/g, hint: "Bearer token" },
  { category: "access_token", severity: "high", re: /(?:access[_-]?token|auth[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9._\-+/=]{12,})["']?/gi, hint: "token=value" },
  { category: "jwt", severity: "high", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, hint: "JWT" },
  { category: "session_token", severity: "high", re: /(?:__Secure-next-auth\.session-token|session[_-]?id|sessionid|_session|PHPSESSID|JSESSIONID)\s*[:=]\s*["']?([A-Za-z0-9._\-+/%=]{12,})["']?/gi, hint: "session cookie/token" },
  { category: "password", severity: "high", re: /(?:password|passwd|pwd|パスワード)\s*[:=：]\s*\S{4,}/gi, hint: "password field" },
  { category: "otp", severity: "high", re: /(?:OTP|one[- ]time (?:code|password)|verification code|認証コード|確認コード|ワンタイムパスワード)\s*(?:is|:|：|=)?\s*(\d{4,8})\b/gi, hint: "one-time code" },
  { category: "credit_card", severity: "high", re: /\b(?:\d[ -]?){13,19}\b/g, hint: "credit card number (Luhn valid)", validate: luhn },
  { category: "email", severity: "medium", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, hint: "email address" },
  { category: "phone", severity: "medium", re: /(?<![\w-])(?:\+?\d{1,3}[-\s.]?)?\(?0?\d{2,4}\)?[-\s.]\d{2,4}[-\s.]\d{3,4}(?![\w-])/g, hint: "phone number", validate: (m) => m.replace(/\D/g, "").length >= 10 && m.replace(/\D/g, "").length <= 15 },
  { category: "account_id", severity: "medium", re: /\b(?:user|org|acct|acc|cus|team)[-_][A-Za-z0-9]{8,}\b/g, hint: "account/org id" },
  { category: "file_path_username", severity: "medium", re: /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([^\s/\\"'<>]+)/g, hint: "file path containing a user name" },
  { category: "url_with_token", severity: "high", re: /https?:\/\/[^\s"'<>]*[?&](?:token|access_token|key|api_key|sig|signature|auth)=[^\s&"'<>]+/gi, hint: "URL with token in query" },
  { category: "ip_address", severity: "low", re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, hint: "IPv4 address", validate: (m) => !m.startsWith("127.") && !m.startsWith("0.") },
  { category: "postal_address", severity: "medium", re: /〒\s?\d{3}-?\d{4}[^\n]{0,40}/g, hint: "Japanese postal code + address" },
  { category: "postal_address", severity: "low", re: /\b\d{1,5}\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|Lane|Ln\.)\b/g, hint: "street address" },
  { category: "person_name", severity: "low", re: /(?:氏名|お名前|名前|Full Name|Name)\s*[:：]\s*([^\n\r]{2,40})/g, hint: "name field" },
];

export interface ScanOptions {
  /** Categories to skip (user choice). */
  ignoreCategories?: FindingCategory[];
}

export function scanText(text: string, opts: ScanOptions = {}): Finding[] {
  const skip = new Set(opts.ignoreCategories ?? []);
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (skip.has(rule.category)) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const whole = m[0];
      if (rule.validate && !rule.validate(whole)) continue;
      findings.push({
        category: rule.category,
        severity: rule.severity,
        start: m.index,
        end: m.index + whole.length,
        match: whole,
        hint: rule.hint,
      });
      if (whole.length === 0) rule.re.lastIndex++;
    }
  }
  return dedupeOverlaps(findings);
}

/** Keep the highest-severity, longest finding for overlapping ranges. */
function dedupeOverlaps(findings: Finding[]): Finding[] {
  const rank: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
  const sorted = [...findings].sort((a, b) => rank[b.severity] - rank[a.severity] || b.end - b.start - (a.end - a.start));
  const kept: Finding[] = [];
  for (const f of sorted) {
    if (kept.some((k) => f.start < k.end && k.start < f.end)) continue;
    kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function summarizeFindings(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.category] = (counts[f.category] ?? 0) + 1;
  return counts;
}

/** Checklist for things the automatic scanner cannot detect in images. */
export const IMAGE_MANUAL_CHECKLIST: { id: string; ja: string; en: string }[] = [
  { id: "face", ja: "顔写真・人物が写っていないか", en: "Faces or people visible" },
  { id: "qr", ja: "QRコード・バーコードが写っていないか", en: "QR codes or barcodes visible" },
  { id: "conversation", ja: "他人との私的な会話が写っていないか", en: "Private conversations visible" },
  { id: "customer", ja: "顧客データ・社外秘情報が写っていないか", en: "Customer or confidential data visible" },
  { id: "name", ja: "氏名・アカウント名が写っていないか", en: "Names or account names visible" },
];

export const SCANNER_DISCLAIMER = {
  ja: "自動検出は完全ではありません。送信前に必ず目視で確認してください。",
  en: "Automatic detection is not exhaustive. Always review manually before sending.",
};
