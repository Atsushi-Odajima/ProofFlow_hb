// Ported from ErrorRelay core (repro/builder.ts), rule-based part only. The paid AI path (provider.suggestReproduction) is not
// merged (DECISIONS D-022). ErrorRelay's product context step ("Open ChatGPT …") became an optional, caller-supplied context step.
import type { Lang } from './types.js';

export interface ReproResult {
  steps: string[];
  expected: string;
  actual: string;
  /** Open questions instead of fabricated steps. */
  questions: string[];
  source: 'rules' | 'user';
  needsConfirmation: true;
}

// ProofFlow change: split AFTER the connective (lookbehind) so the verb stays in its step ("カートを開いて" → "カートを開く。"),
// where ErrorRelay dropped it ("カートを。").
const JA_SPLIT = /(?<=して|したら|すると|したところ|押したら|押して|開いて|開いたら|たら|ら、|、そして|、その後|、次に)|→|->/;
const JA_TAIL: Array<[RegExp, string]> = [[/押したら$|押して$/, '押す'], [/開いたら$|開いて$/, '開く'], [/したところ$|したら$|すると$|して$/, 'する'], [/、?(?:そして|その後|次に)$/, ''], [/ら、$/, ''], [/たら$/, 'た']];
const EN_SPLIT = /(?:,?\s+(?:and\s+)?then\s+|,\s+and\s+|\s+after\s+that\s+|;\s+|→|->)/i;

const JA_FAIL = /(できな(?:い|かった)|失敗|エラー|落ち|止ま|表示されな|開かな|反応しな|真っ白|フリーズ|固ま)/;
const EN_FAIL = /(fail|error|crash|could ?n[o']t|cannot|can't|unable|nothing happens|blank|freeze|froze|stuck|not (?:load|open|respond)|didn't|doesn't)/i;

export function isJapanese(s: string): boolean {
  return /[぀-ヿ一-龯]/.test(s);
}

function normalizeClause(c: string, lang: Lang): string {
  let s = c.trim().replace(/^[、,。.\s]+|[、,\s]+$/g, '');
  if (!s) return '';
  if (lang === 'ja') {
    // Convert casual "してもらって" / "頼んで" endings into request form; keep user words, avoid inventing.
    s = s.replace(/(作って|生成して|出して)もらっ?て?$/, '$1もらうよう依頼する');
    if (!/依頼する$/.test(s)) for (const [re, to] of JA_TAIL) if (re.test(s)) { s = s.replace(re, to); break; }
    s = s.replace(/(押し|タップし|クリックし)$/, '$1た').replace(/[、,\s]+$/, '');
    if (!s) return '';
    if (!/[。]$/.test(s)) s += '。';
  } else {
    s = s.charAt(0).toUpperCase() + s.slice(1);
    if (!/[.]$/.test(s)) s += '.';
  }
  return s;
}

/**
 * Rule-based conversion. Splits the reporter's description into clauses in order; the last failing clause becomes the actual
 * result. It never adds steps that are not in the text except the optional context step supplied by the caller
 * (e.g. "ログイン画面を開く。"), which is derived from a field the reporter chose, not invented.
 */
export function buildReproFromText(description: string, language?: Lang, contextStep?: string | null): ReproResult {
  // The description's own script wins: a Japanese sentence in an English-language report is still split with Japanese rules.
  const lang: Lang = isJapanese(description) ? 'ja' : (language ?? 'en');
  const raw = description.replace(/\s+/g, ' ').trim();
  const clauses = raw.split(lang === 'ja' ? JA_SPLIT : EN_SPLIT).map((c) => c.trim()).filter(Boolean);
  const steps: string[] = [];
  const ctx = contextStep?.trim() || null;
  if (ctx) steps.push(ctx);
  let actual = '';
  const failRe = lang === 'ja' ? JA_FAIL : EN_FAIL;
  clauses.forEach((c, idx) => {
    const isLast = idx === clauses.length - 1;
    if (isLast && failRe.test(c)) {
      actual = normalizeClause(c, lang);
    } else {
      const n = normalizeClause(c, lang);
      if (n) steps.push(n);
    }
  });
  const questions: string[] = [];
  if (steps.length <= (ctx ? 1 : 0)) questions.push(lang === 'ja' ? 'エラーの直前に何をしましたか？（押したボタン・入力内容など）' : 'What did you do right before the error (button pressed, input)?');
  if (!actual) questions.push(lang === 'ja' ? '実際には何が起きましたか？（表示されたメッセージ等）' : 'What actually happened (message shown, etc.)?');
  const expected = actual ? deriveExpected(actual, lang) : '';
  return { steps, expected, actual, questions, source: 'rules', needsConfirmation: true };
}

/** Very conservative expected-behaviour template from the failing clause. Marked for reporter confirmation. */
export function deriveExpected(actual: string, lang: Lang): string {
  if (lang === 'ja') {
    const m = /(.+?)(?:が|を)?(?:できな(?:い|かった)|失敗(?:した|する)|エラー(?:になった|が出た|が表示された)?)/.exec(actual);
    if (m && m[1]) return `${m[1].replace(/[。]$/, '')}が正常に完了する。`;
    return '操作が正常に完了する。';
  }
  const m = /(?:could ?n[o']t|cannot|can't|unable to|failed to|fails? to|didn't|doesn't)\s+(.+?)[.]?$/i.exec(actual);
  if (m && m[1]) return `The app ${m[1].replace(/\.$/, '')} successfully.`;
  return 'The operation completes without an error.';
}

export const REPRO_QUESTIONS = {
  ja: ['何をしていましたか？', '何を押した直後に起きましたか？', '初めてですか？毎回ですか？時々ですか？', '再試行しましたか？結果は？', '本来どうなるはずでしたか？（期待）', '実際にはどうなりましたか？（実際）'],
  en: ['What were you doing?', 'What did you press right before it happened?', 'First time, every time, or sometimes?', 'Did you retry? What happened?', 'What did you expect to happen?', 'What actually happened?'],
};
