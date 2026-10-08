// ProofFlow 不具合報告 — report generation (ja/en) and ProofFlow 個人情報マスク applied to a whole report.
// Generation is ported from ErrorRelay core (generate/report.ts: short / detailed / json); similarity from status/knownIssues.ts;
// the quality checklist from quality/check.ts. Product / submission / analysis sections were dropped (not part of the merge).
import { scanText, SCANNER_VERSION, type Finding, type FindingCategory, type Severity } from './scanner.js';
import { redactText, type RedactionDecision } from './redact.js';
import { environmentLines } from './environment.js';
import { ENV_KEYS, type BugReportContent, type Lang, type RedactionSummary } from './types.js';

export type ReportFormat = 'short' | 'detailed' | 'json';

const L = {
  ja: {
    title: '件名', occurred: '発生日時', reported: '報告日時', frequency: '再現頻度',
    freq: { first_time: '初めて', sometimes: '時々', always: '毎回', unknown: '不明' },
    description: '何が起きたか', steps: '再現手順', expected: '期待する動作', actual: '実際の動作', error: 'エラーメッセージ',
    env: '環境', attachments: '添付', notes: '補足', none: '（なし）', unknown: '不明', reporter: '報告者', redaction: '個人情報マスク',
    masked: '（マスク済み）',
  },
  en: {
    title: 'Title', occurred: 'Occurred', reported: 'Reported', frequency: 'Frequency',
    freq: { first_time: 'First time', sometimes: 'Sometimes', always: 'Every time', unknown: 'Unknown' },
    description: 'What happened', steps: 'Steps to Reproduce', expected: 'Expected Behavior', actual: 'Actual Behavior', error: 'Error Message',
    env: 'Environment', attachments: 'Attachments', notes: 'Additional Notes', none: '(none)', unknown: 'unknown', reporter: 'Reporter', redaction: 'Redaction',
    masked: ' (redacted)',
  },
} as const;

export interface ReportAttachmentRef { fileName: string; redacted: boolean; }
export interface GenerateOptions { attachments?: ReportAttachmentRef[]; reportedAt?: string | null; redaction?: RedactionSummary | null; }

function attachmentsList(o: GenerateOptions, lang: Lang): string {
  const a = o.attachments ?? [];
  if (!a.length) return L[lang].none;
  return a.map((x) => `${x.fileName}${x.redacted ? L[lang].masked : ''}`).join(', ');
}
export function stepsBlock(r: Pick<BugReportContent, 'steps'>, lang: Lang): string {
  return r.steps.length ? r.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : L[lang].none;
}

export function generateShort(r: BugReportContent, lang: Lang, o: GenerateOptions = {}): string {
  const t = L[lang];
  const lines = [
    `${t.title}: ${r.title || '-'}`,
    `${t.occurred}: ${r.occurredAt?.display ?? t.unknown}`,
    `${t.frequency}: ${t.freq[r.frequency]}`,
    '',
    `${t.steps}:`,
    stepsBlock(r, lang),
    '',
    `${t.expected}: ${r.expected || '-'}`,
    `${t.actual}: ${r.actual || '-'}`,
  ];
  if (r.errorText.trim()) lines.push('', `${t.error}:`, r.errorText.trim());
  const env = environmentLines(r.environment, lang);
  if (env.length) lines.push('', `${t.env}:`, ...env);
  lines.push(`${t.attachments}: ${attachmentsList(o, lang)}`);
  return lines.join('\n');
}

export function generateDetailed(r: BugReportContent, lang: Lang, o: GenerateOptions = {}): string {
  const t = L[lang];
  const env = environmentLines(r.environment, lang);
  const lines = [
    `# ${r.title || '-'}`,
    '',
    `## ${t.occurred}`,
    `${r.occurredAt?.display ?? t.unknown}${r.occurredAt ? ` (${r.occurredAt.source}, confidence: ${r.occurredAt.confidence})` : ''}`,
    `${t.reported}: ${o.reportedAt ?? t.unknown}`,
    '',
    `## ${t.env}`,
    env.length ? env.join('\n') : t.unknown,
    '',
    `## ${t.description}`,
    r.description || '-',
    '',
    `## ${t.steps}`,
    stepsBlock(r, lang),
    '',
    `## ${t.expected}`,
    r.expected || '-',
    '',
    `## ${t.actual}`,
    r.actual || '-',
    '',
    `## ${t.error}`,
    r.errorText.trim() ? '```\n' + r.errorText.trim() + '\n```' : t.none,
    '',
    `## ${t.frequency}`,
    t.freq[r.frequency],
  ];
  lines.push('', `## ${t.attachments}`, attachmentsList(o, lang));
  if (r.reporterName.trim()) lines.push('', `## ${t.reporter}`, r.reporterName.trim());
  if (r.additionalNotes.trim()) lines.push('', `## ${t.notes}`, r.additionalNotes.trim());
  if (o.redaction) {
    const c = Object.entries(o.redaction.counts).map(([k, v]) => `${k}: ${v}`).join(', ');
    lines.push('', `## ${t.redaction}`, c || t.none);
  }
  return lines.join('\n');
}

/** Export-safe JSON (content only; no tenant / storage references). */
export function generateJson(r: BugReportContent): string { return JSON.stringify(r, null, 2); }

export function generateReport(r: BugReportContent, format: ReportFormat, lang: Lang, o: GenerateOptions = {}): string {
  switch (format) {
    case 'short': return generateShort(r, lang, o);
    case 'detailed': return generateDetailed(r, lang, o);
    case 'json': return generateJson(r);
  }
}

// ---------------- ProofFlow 個人情報マスク over a whole report ----------------

/** Categories that are always masked, whatever the reporter decides (ProofFlow policy, DECISIONS D-022). */
export const ALWAYS_REDACT: ReadonlySet<FindingCategory> = new Set<FindingCategory>(['api_key', 'access_token', 'session_token', 'jwt', 'password', 'otp', 'credit_card', 'url_with_token']);

export type Decisions = Partial<Record<FindingCategory, RedactionDecision>>;
/** Drops "keep" for high-risk categories. */
export function effectiveDecisions(d: Decisions = {}): Decisions {
  const out: Decisions = {};
  for (const [k, v] of Object.entries(d) as [FindingCategory, RedactionDecision][]) if (v === 'keep' && !ALWAYS_REDACT.has(k)) out[k] = 'keep';
  return out;
}

/** A finding without the matched text — safe to return over the API / show in UI. */
export interface PublicFinding { field: string; category: FindingCategory; severity: Severity; hint: string; kept: boolean; }

export interface SanitizeResult {
  content: BugReportContent;
  findings: PublicFinding[];
  summary: RedactionSummary;
  /** Raw findings (with matches) — in memory only, for leak guards; never serialize. */
  raw: Finding[];
}

/** Apply the scanner + redaction to every free-text field and environment value of a report. */
export function sanitizeReport(input: BugReportContent, decisions: Decisions = {}): SanitizeResult {
  const eff = effectiveDecisions(decisions);
  const findings: PublicFinding[] = [];
  const raw: Finding[] = [];
  const counts: Record<string, number> = {};
  const kept = new Set<string>();
  const one = (field: string, text: string): string => {
    if (!text) return text;
    const f = scanText(text);
    if (!f.length) return text;
    const r = redactText(text, f, eff);
    for (const x of f) {
      const isKept = eff[x.category] === 'keep';
      findings.push({ field, category: x.category, severity: x.severity, hint: x.hint, kept: isKept });
      if (isKept) kept.add(x.category); else { raw.push(x); counts[x.category] = (counts[x.category] ?? 0) + 1; }
    }
    return r.redacted;
  };
  const env = { ...input.environment };
  for (const k of ENV_KEYS) { const f = env[k]; if (f?.value) env[k] = { ...f, value: one(`environment.${k}`, f.value) }; }
  const content: BugReportContent = {
    ...input,
    title: one('title', input.title),
    description: one('description', input.description),
    expected: one('expected', input.expected),
    actual: one('actual', input.actual),
    steps: input.steps.map((s, i) => one(`steps.${i}`, s)),
    errorText: one('errorText', input.errorText),
    reporterName: one('reporterName', input.reporterName),
    additionalNotes: one('additionalNotes', input.additionalNotes),
    environment: env,
  };
  return { content, findings, raw, summary: { counts, keptCategories: [...kept].sort(), scannerVersion: SCANNER_VERSION, note: 'Automatic detection is not exhaustive; reporter reviewed the masked preview before submitting.' } };
}

// ---------------- known-issue hinting (ported from status/knownIssues.ts) ----------------
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'and', 'or', 'is', 'it', 'with', 'for', 'at', 'が', 'を', 'に', 'は', 'の', 'で', 'と', 'た', 'て']);
/** Tokens: ASCII words, plus Japanese runs split into character bigrams (ProofFlow addition — Japanese has no spaces). */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const t of s.toLowerCase().split(/[^a-z0-9぀-ヿ一-龯]+/)) {
    if (t.length <= 1 || STOP.has(t)) continue;
    if (/[぀-ヿ一-龯]/.test(t) && t.length > 2) { for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2)); } else out.push(t);
  }
  return out;
}
/** 0..1 overlap score; shown as "possible", never "duplicate". */
export function similarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(A.size, B.size);
}
export const KNOWN_ISSUE_NOTE = {
  ja: '似ている既存の不具合の候補です。同一とは限りません。報告はそのまま続けられます。',
  en: 'Possible similar existing defects. Not necessarily the same problem. You can continue reporting.',
};

// ---------------- quality checklist (ported from quality/check.ts; no numeric score) ----------------
export type CheckStatus = 'ok' | 'missing' | 'warn';
export interface QualityItem { id: string; status: CheckStatus; label: { ja: string; en: string } }
export function checkReportQuality(r: BugReportContent, opts: { attachments?: number } = {}): { items: QualityItem[]; missing: string[]; warnings: string[]; readyToSend: boolean } {
  const items: QualityItem[] = [];
  const add = (id: string, ok: boolean, ja: string, en: string, warn = false) => items.push({ id, status: ok ? 'ok' : warn ? 'warn' : 'missing', label: { ja, en } });
  add('title', r.title.trim().length > 0, '件名', 'Title');
  add('occurredAt', !!r.occurredAt, '発生日時', 'Occurred at', true);
  add('environment', Object.values(r.environment).some((f) => f.source !== 'unknown'), '環境情報', 'Environment', true);
  add('steps', r.steps.length > 0, '再現手順', 'Steps to reproduce', true);
  add('expected', r.expected.trim().length > 0, '期待する動作', 'Expected behavior', true);
  add('actual', r.actual.trim().length > 0 || r.description.trim().length > 0, '実際の動作', 'Actual behavior');
  add('screenshot', (opts.attachments ?? 0) > 0, 'スクリーンショット・添付', 'Screenshot / attachment', true);
  const missing = items.filter((i) => i.status === 'missing').map((i) => i.id);
  const warnings = items.filter((i) => i.status === 'warn').map((i) => i.id);
  return { items, missing, warnings, readyToSend: missing.length === 0 };
}
