// ProofFlow 不具合報告 — ported from ErrorRelay core/test/report.test.ts + timestamp.test.ts (report generation, environment,
// reproduction builder, quality checklist, timestamps). Not ported: state machine / submissions / follow-up / AI provider
// (ErrorRelay send flow is replaced by ProofFlow Defect creation), product-specific context steps.
import { describe, it, expect } from 'vitest';
import { bugreport as br } from '@proofflow/shared';

const tz = 'Asia/Tokyo';
const base = (over: Partial<br.BugReportContent> = {}): br.BugReportContent => ({ title: '', description: '', expected: '', actual: '', steps: [], errorText: '', frequency: 'unknown', occurredAt: null, environment: br.emptyEnvironment(), reporterName: '', additionalNotes: '', language: 'ja', ...over });

describe('report generation (ErrorRelay tests 1, 9, 17)', () => {
  it('text-only report without a screenshot (en short)', () => {
    const r = base({ title: 'Checkout error', errorText: 'Something went wrong', occurredAt: br.parseManualTimestamp('2026-09-30 10:20', tz), steps: ['Open cart', 'Press pay'], expected: 'Receipt appears', actual: 'Error shown' });
    const txt = br.generateReport(r, 'short', 'en');
    expect(txt).toContain('Attachments: (none)');
    expect(txt).toContain('1. Open cart\n2. Press pay');
    expect(txt).toContain('Occurred: 2026-09-30 10:20 GMT+9 / Asia/Tokyo');
    expect(txt).not.toMatch(/undefined/);
  });
  it('does not fabricate unknown fields: unknown env fields are omitted, not filled', () => {
    const r = base();
    expect(br.environmentLines(r.environment, 'en')).toEqual([]);
    const detailed = br.generateReport(r, 'detailed', 'en');
    expect(detailed).toContain('## Occurred\nunknown');
    expect(detailed).not.toMatch(/iPhone|Windows 11/);
  });
  it('Japanese detailed Markdown has all sections, attachments marked as masked, and a redaction summary', () => {
    const r = base({ title: '決済ボタンが反応しない', description: 'カートで支払うを押しても何も起きない', steps: ['カートを開く', '支払うを押す'], expected: '決済画面に進む', actual: '何も起きない', frequency: 'always', environment: { ...br.emptyEnvironment(), browser: { value: 'Safari', source: 'auto' }, device: { value: 'iPhone 15', source: 'manual' } } });
    const md = br.generateDetailed(r, 'ja', { attachments: [{ fileName: 'shot.png', redacted: true }], reportedAt: '2026-10-01T00:00:00.000Z', redaction: { counts: { email: 2 }, keptCategories: [], scannerVersion: br.SCANNER_VERSION, note: '' } });
    for (const h of ['# 決済ボタンが反応しない', '## 発生日時\n不明', '## 環境\nブラウザ: Safari\n端末: iPhone 15', '## 再現手順\n1. カートを開く\n2. 支払うを押す', '## 期待する動作\n決済画面に進む', '## 実際の動作\n何も起きない', '## 再現頻度\n毎回', '## 添付\nshot.png（マスク済み）', '## 個人情報マスク\nemail: 2']) expect(md).toContain(h);
    expect(JSON.parse(br.generateReport(r, 'json', 'ja')).title).toBe('決済ボタンが反応しない');
  });
});

describe('environment capture (ErrorRelay tests 3, 28)', () => {
  it('browser env never asserts device model; manual wins on merge', () => {
    const env = br.captureBrowserEnvironment({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', language: 'ja', onLine: true, innerWidth: 390, innerHeight: 844, standalone: true, href: 'https://app.example.com/cart' });
    expect(env.os.value).toBe('iOS/iPadOS');
    expect(env.browser.value).toBe('Safari');
    expect(env.device.source).toBe('unknown');
    expect(env.viewport.value).toBe('390x844');
    expect(env.displayMode.value).toBe('pwa-standalone');
    expect(env.pageUrl.value).toBe('https://app.example.com/cart');
    const merged = br.mergeEnvironment(env, { device: br.manualField('iPhone 15') });
    expect(merged.device).toEqual({ value: 'iPhone 15', source: 'manual' });
  });
  it('inferred values are tagged for confirmation', () => {
    const env = { ...br.emptyEnvironment(), osVersion: br.inferredField('17') };
    expect(br.environmentLines(env, 'ja')).toEqual(['OSバージョン: 17（推定・要確認）']);
  });
});

describe('quality checklist (no score)', () => {
  it('lists missing items without a score', () => {
    const q = br.checkReportQuality(base());
    expect(q.missing).toContain('title');
    expect(q.warnings).toContain('occurredAt');
    expect(q.readyToSend).toBe(false);
    expect((q as unknown as { score?: number }).score).toBeUndefined();
    expect(br.checkReportQuality(base({ title: 't', actual: 'a' })).readyToSend).toBe(true);
  });
});

describe('reproduction builder (ErrorRelay tests 10, 11)', () => {
  it('converts Japanese natural text into steps without inventing', () => {
    const r = br.buildReproFromText('txt作ってもらってリンク押したらdownloadできなかった', 'ja', 'チャット画面を開く。');
    expect(r.steps[0]).toBe('チャット画面を開く。');
    expect(r.steps.length).toBeGreaterThanOrEqual(2);
    expect(r.actual).toMatch(/download/);
    expect(r.expected).toMatch(/正常に完了/);
    expect(r.needsConfirmation).toBe(true);
    expect(r.steps.join(' ')).not.toMatch(/ダイアログ/);
  });
  it('ProofFlow change: Japanese connectives keep their verb in the step', () => {
    const r = br.buildReproFromText('カートを開いて支払うを押したら決済できなかった', 'ja');
    expect(r.steps).toEqual(['カートを開く。', '支払うを押す。']);
    expect(r.actual).toBe('決済できなかった。');
    expect(br.buildReproFromText('ログインして、その後設定画面を開いたら真っ白になった', 'ja').steps).toEqual(['ログインする。', '設定画面を開く。']);
  });
  it('English text', () => {
    const r = br.buildReproFromText('I asked for a TXT file and then tapped the attachment, then it could not download', 'en');
    expect(r.steps[0]).toBe('I asked for a TXT file.');
    expect(r.actual).toMatch(/could not download/i);
    expect(r.expected).toMatch(/download/);
  });
  it('asks questions instead of fabricating when info is missing', () => {
    const r = br.buildReproFromText('エラー', 'ja');
    expect(r.questions.length).toBeGreaterThan(0);
    expect(r.steps).toEqual([]);
    expect(br.deriveExpected('It failed to open the file.', 'en')).toBe('The app open the file successfully.');
  });
});

describe('timestamps (ErrorRelay tests 7, 8)', () => {
  it('parses a manual JST time to the correct UTC instant and display', () => {
    const ts = br.parseManualTimestamp('2026-09-30 13:44', 'Asia/Tokyo')!;
    expect(ts.iso).toBe('2026-09-30T04:44:00.000Z');
    expect(ts.display).toBe('2026-09-30 13:44 GMT+9 / Asia/Tokyo');
    expect(ts.source).toBe('user_manual');
  });
  it('handles DST zones', () => {
    expect(br.parseManualTimestamp('2026-07-01 12:00', 'America/New_York')!.iso).toBe('2026-07-01T16:00:00.000Z');
    expect(br.parseManualTimestamp('2026-01-01 12:00', 'America/New_York')!.iso).toBe('2026-01-01T17:00:00.000Z');
    expect(br.tzOffsetMinutes(new Date('2026-07-01T16:00:00.000Z'), 'America/New_York')).toBe(-240);
  });
  it('rejects invalid dates instead of guessing', () => {
    expect(br.parseManualTimestamp('2026-02-30 10:00', 'Asia/Tokyo')).toBeNull();
    expect(br.parseManualTimestamp('yesterday', 'Asia/Tokyo')).toBeNull();
    expect(br.parseManualTimestamp('2026-09-30 10:00', 'Not/AZone')).toBeNull();
  });
  it("'now' button records the instant and zone; retimezone keeps the instant", () => {
    const ts = br.nowTimestamp('Asia/Tokyo', new Date('2026-09-30T01:20:00Z'));
    expect(ts.display).toContain('2026-09-30 10:20');
    expect(ts.source).toBe('user_now');
    const la = br.retimezone(br.parseManualTimestamp('2026-09-30 13:44', 'Asia/Tokyo')!, 'America/Los_Angeles');
    expect(la.display).toContain('2026-09-29 21:44');
  });
});

describe('known-issue similarity', () => {
  it('scores overlapping wording (English words and Japanese bigrams), 0 for unrelated', () => {
    expect(br.similarity('checkout button does nothing', 'Checkout button does nothing on Safari')).toBeGreaterThan(0.5);
    expect(br.similarity('決済ボタンが反応しない', '決済ボタンが反応しない（iPhone）')).toBeGreaterThan(0.5);
    expect(br.similarity('login page', '決済')).toBe(0);
  });
});
