// Ported from ErrorRelay core (env/environment.ts). Captures only what a browser legitimately knows; never guesses a device model.
import { emptyEnvironment, ENV_KEYS, type EnvField, type EnvKey, type Lang, type ReportEnvironment } from './types.js';

export const autoField = (v: string | null | undefined): EnvField => (v == null || v === '' ? { value: null, source: 'unknown' } : { value: String(v), source: 'auto' });
export const manualField = (v: string): EnvField => ({ value: v, source: 'manual' });
export const inferredField = (v: string): EnvField => ({ value: v, source: 'inferred' });

export interface BrowserLike {
  userAgent?: string;
  language?: string;
  onLine?: boolean;
  platform?: string;
  innerWidth?: number;
  innerHeight?: number;
  standalone?: boolean;
  connectionType?: string;
  /** Page where the problem happened (ProofFlow addition). Query strings are scanned/redacted before storage. */
  href?: string;
}

/** Capture what a browser/PWA can legitimately know. Nothing here is a device model guess. */
export function captureBrowserEnvironment(b: BrowserLike): ReportEnvironment {
  const env = emptyEnvironment();
  env.userAgent = autoField(b.userAgent);
  env.locale = autoField(b.language);
  env.viewport = b.innerWidth && b.innerHeight ? autoField(`${b.innerWidth}x${b.innerHeight}`) : env.viewport;
  env.displayMode = b.standalone === undefined ? env.displayMode : autoField(b.standalone ? 'pwa-standalone' : 'browser');
  env.networkState = b.onLine === undefined ? env.networkState : autoField(`${b.onLine ? 'online' : 'offline'}${b.connectionType ? ` (${b.connectionType})` : ''}`);
  env.browser = autoField(browserNameFromUA(b.userAgent));
  env.os = autoField(osNameFromUA(b.userAgent));
  env.platform = autoField(b.platform);
  env.pageUrl = autoField(b.href);
  return env;
}

export function browserNameFromUA(ua?: string): string | null {
  if (!ua) return null;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return 'Chrome';
  if (/CriOS\//.test(ua)) return 'Chrome (iOS)';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
  return null;
}

export function osNameFromUA(ua?: string): string | null {
  if (!ua) return null;
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS/iPadOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

/** Merge manual overrides; manual always wins over auto/unknown. */
export function mergeEnvironment(base: ReportEnvironment, patch: Partial<Record<EnvKey, EnvField>>): ReportEnvironment {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch) as [EnvKey, EnvField | undefined][]) {
    if (!v) continue;
    if (v.source === 'manual' || out[k].source === 'unknown' || out[k].source === 'inferred') out[k] = v;
  }
  return out;
}

export const ENV_LABELS: Record<EnvKey, { ja: string; en: string }> = {
  pageUrl: { ja: '発生ページ', en: 'Page URL' },
  appVersion: { ja: 'アプリバージョン', en: 'App version' },
  browser: { ja: 'ブラウザ', en: 'Browser' },
  os: { ja: 'OS', en: 'OS' },
  osVersion: { ja: 'OSバージョン', en: 'OS version' },
  device: { ja: '端末', en: 'Device' },
  platform: { ja: 'プラットフォーム', en: 'Platform' },
  userAgent: { ja: 'User Agent', en: 'User agent' },
  viewport: { ja: 'ビューポート', en: 'Viewport' },
  displayMode: { ja: '表示モード', en: 'Display mode' },
  networkState: { ja: 'ネットワーク', en: 'Network' },
  locale: { ja: 'ロケール', en: 'Locale' },
};

export function environmentLines(env: ReportEnvironment, lang: Lang): string[] {
  const unknown = lang === 'ja' ? '不明' : 'unknown';
  const lines: string[] = [];
  for (const k of ENV_KEYS) {
    const f = env[k];
    if (!f || f.source === 'unknown') continue; // omitted: unknown is not "empty"
    const tag = f.source === 'inferred' ? (lang === 'ja' ? '（推定・要確認）' : ' (inferred, unconfirmed)') : '';
    lines.push(`${ENV_LABELS[k][lang]}: ${f.value ?? unknown}${tag}`);
  }
  return lines;
}
