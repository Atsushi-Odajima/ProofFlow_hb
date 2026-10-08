// Ported from ErrorRelay core (privacy/redact.ts) — ProofFlow 個人情報マスク. Solid placeholders only (no partial masking).
import { scanText, summarizeFindings, SCANNER_VERSION, type Finding, type FindingCategory } from "./scanner.js";
import type { RedactionSummary } from "./types.js";

export type RedactionDecision = "redact" | "keep";

export interface RedactTextResult {
  redacted: string;
  /** Placeholder → original. In-memory only. Never serialize this. */
  placeholderMap: Map<string, string>;
  findings: Finding[];
  summary: RedactionSummary;
}

const LABEL: Record<FindingCategory, string> = {
  email: "EMAIL",
  phone: "PHONE",
  api_key: "API_KEY",
  access_token: "TOKEN",
  session_token: "SESSION",
  jwt: "JWT",
  password: "PASSWORD",
  otp: "OTP",
  credit_card: "CARD",
  account_id: "ACCOUNT_ID",
  file_path_username: "USER_PATH",
  ip_address: "IP",
  postal_address: "ADDRESS",
  person_name: "NAME",
  private_conversation: "PRIVATE",
  url_with_token: "URL_WITH_TOKEN",
};

/**
 * Replace findings with solid placeholders such as [REDACTED_API_KEY_1].
 * Placeholders carry no information from the original string (no partial masking).
 */
export function redactText(
  text: string,
  findings: Finding[] = scanText(text),
  decisions: Partial<Record<FindingCategory, RedactionDecision>> = {},
): RedactTextResult {
  const map = new Map<string, string>();
  const counters: Partial<Record<FindingCategory, number>> = {};
  const kept = new Set<string>();
  let out = "";
  let cursor = 0;
  const applied: Finding[] = [];
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    if (f.start < cursor) continue;
    if ((decisions[f.category] ?? "redact") === "keep") {
      kept.add(f.category);
      continue;
    }
    const n = (counters[f.category] = (counters[f.category] ?? 0) + 1);
    const placeholder = `[REDACTED_${LABEL[f.category]}_${n}]`;
    map.set(placeholder, f.match);
    out += text.slice(cursor, f.start) + placeholder;
    cursor = f.end;
    applied.push(f);
  }
  out += text.slice(cursor);
  return {
    redacted: out,
    placeholderMap: map,
    findings,
    summary: {
      counts: summarizeFindings(applied),
      keptCategories: [...kept],
      scannerVersion: SCANNER_VERSION,
      note: "Automatic detection is not exhaustive; user reviewed before export.",
    },
  };
}

/** Redact every string leaf of a JSON-like value (for logs, doctor output, API bodies). */
export function redactJsonValue<T>(value: T, decisions?: Partial<Record<FindingCategory, RedactionDecision>>): { value: T; findings: Finding[] } {
  const all: Finding[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v, scanText(v), decisions);
      all.push(...r.findings);
      return r.redacted;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        // Whole-key redaction for well-known secret keys regardless of value shape.
        if (/^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|password|token|secret)$/i.test(k)) {
          all.push({ category: "access_token", severity: "high", start: 0, end: 0, match: String(x), hint: `header ${k}` });
          o[k] = "[REDACTED]";
        } else o[k] = walk(x);
      }
      return o;
    }
    return v;
  };
  return { value: walk(value) as T, findings: all };
}

/** Assert that none of the original secret strings appear in the output. Used in tests and export guards. */
export function containsAnyOriginal(output: string, findings: Finding[]): Finding[] {
  return findings.filter((f) => f.match.length >= 4 && output.includes(f.match));
}
