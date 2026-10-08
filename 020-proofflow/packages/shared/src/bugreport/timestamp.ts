// Ported from ErrorRelay core (time/timestamp.ts). Never guesses: invalid input returns null.
import type { Timestamp } from "./types.js";

const DEFAULT_TZ = "UTC";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(date: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const p of f.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  return {
    year: map.year!,
    month: map.month!,
    day: map.day!,
    hour: map.hour! === 24 ? 0 : map.hour!,
    minute: map.minute!,
    second: map.second!,
  };
}

/** Offset (minutes) of tz at the given instant. */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = partsInZone(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Convert a wall-clock time in tz to a UTC Date (handles DST by two-pass correction). */
export function zonedToUtc(p: Parts, tz: string): Date {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  let off = tzOffsetMinutes(new Date(guess), tz);
  let utc = guess - off * 60000;
  const off2 = tzOffsetMinutes(new Date(utc), tz);
  if (off2 !== off) utc = guess - off2 * 60000;
  return new Date(utc);
}

export function tzAbbreviation(date: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(date);
    const n = parts.find((p) => p.type === "timeZoneName")?.value;
    if (n) return n;
  } catch {
    /* fall through */
  }
  const off = tzOffsetMinutes(date, tz);
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** e.g. "2026-09-30 13:44 JST / Asia/Tokyo" */
export function formatDisplay(date: Date, tz: string): string {
  const p = partsInZone(date, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${tzAbbreviation(date, tz)} / ${tz}`;
}

export function makeTimestamp(
  date: Date,
  tz: string,
  source: Timestamp["source"],
  confidence: Timestamp["confidence"],
): Timestamp {
  const zone = isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  return { iso: date.toISOString(), timezone: zone, display: formatDisplay(date, zone), source, confidence };
}

/** "It happened just now" button. */
export function nowTimestamp(tz = detectTimeZone(), now = new Date()): Timestamp {
  return makeTimestamp(now, tz, "user_now", "high");
}

const MANUAL_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** Parse "2026-09-30 13:44" as wall-clock in tz. Returns null on invalid input; never guesses. */
export function parseManualTimestamp(text: string, tz: string): Timestamp | null {
  const m = MANUAL_RE.exec(text.trim());
  if (!m || !isValidTimeZone(tz)) return null;
  const parts: Parts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] ? Number(m[4]) : 0,
    minute: m[5] ? Number(m[5]) : 0,
    second: m[6] ? Number(m[6]) : 0,
  };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 || parts.hour > 23 || parts.minute > 59) {
    return null;
  }
  const d = zonedToUtc(parts, tz);
  const back = partsInZone(d, tz);
  if (back.day !== parts.day || back.month !== parts.month) return null; // e.g. Feb 30
  return makeTimestamp(d, tz, "user_manual", "high");
}

/** Timestamp visible in a screenshot (e.g. status bar clock) — low confidence, needs date + tz from user. */
export function timestampFromVisibleClock(
  clock: string,
  referenceDate: Date,
  tz: string,
): Timestamp | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!m || !isValidTimeZone(tz)) return null;
  const p = partsInZone(referenceDate, tz);
  const d = zonedToUtc({ ...p, hour: Number(m[1]), minute: Number(m[2]), second: 0 }, tz);
  return makeTimestamp(d, tz, "screenshot_visible", "low");
}

/** Re-express an existing timestamp in another zone without changing the instant. */
export function retimezone(ts: Timestamp, tz: string): Timestamp {
  return makeTimestamp(new Date(ts.iso), tz, ts.source, ts.confidence);
}
