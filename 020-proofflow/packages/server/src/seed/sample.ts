/**
 * Seed the "Sample SaaS" demo project — requirements, scenarios, suites (Smoke / Critical / Visual / Mobile / API / Accessibility),
 * a manual device case, a nightly schedule (disabled) and Release Candidate 1.2.0 (docs/buyer/5分で最初のテスト.txt).
 *
 *   pnpm seed:sample                                    # same PROOFFLOW_* env as the server; prints the demo login + a runner token
 *   PROOFFLOW_SAMPLE_URL=http://127.0.0.1:4100 pnpm seed:sample
 *
 * The seed only writes metadata through the public API (no SQL shortcuts) and refuses to seed the same organization twice.
 * It never runs tests by itself: start `pnpm dev:sample` and `pnpm dev:runner` and trigger the suites from the UI / CLI.
 */
import type { FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { openDb } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { buildApp } from '../app.js';

export interface SeedOptions {
  sampleUrl: string;
  /** Create (or log into) this account; ignored when `account` is given. */
  email?: string; password?: string; name?: string; orgName?: string;
  /** Seed into an existing session/org instead of creating an account. */
  account?: { cookie: string; orgId: string; userId: string };
  projectName?: string;
  createRunnerToken?: boolean;
}
export interface SeedResult {
  orgId: string; userId: string; cookie: string; projectId: string; envId: string;
  requirements: Record<string, string>; scenarios: Record<string, string>; suites: Record<string, string>;
  rcId: string; manualCaseId: string; scheduleId: string; runnerToken: string | null;
  credentials: { email: string; password: string } | null;
}

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const PROFILE_SCHEMA = { type: 'object', required: ['id', 'email', 'name', 'plan'], properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, plan: { type: 'string' } } };
const DESKTOP = { width: 1280, height: 800, name: 'desktop' };
const IPHONE = { width: 390, height: 844, name: 'iPhone 15', isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const ANDROID = { width: 412, height: 915, name: 'Pixel 8', isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 };

export const SEED_REQUIREMENTS: Array<{ key: string; title: string; priority: 'p0' | 'p1' | 'p2'; ac: Array<{ given: string; when: string; then: string }> }> = [
  { key: 'login-error', title: 'ログイン失敗時にエラーメッセージを表示する', priority: 'p0', ac: [{ given: 'ログイン画面を開いている', when: '誤ったメール/パスワードで送信する', then: '「Invalid email or password」が表示され、ダッシュボードへ遷移しない' }] },
  { key: 'signup-guard', title: 'サインアップフォームは二重送信されない', priority: 'p0', ac: [{ given: 'サインアップ画面', when: '送信ボタンを連打する', then: 'アカウントは 1 件しか作成されない' }, { given: 'サインアップ画面', when: '空のまま送信する', then: '必須項目のエラーが表示される' }] },
  { key: 'dashboard-api', title: 'ダッシュボードの profile API が 5xx を返さない', priority: 'p0', ac: [{ given: 'ログイン済み', when: 'ダッシュボードを開く', then: '/api/profile が 200 を返しプロフィールが表示される' }] },
  { key: 'mobile-cta', title: 'スマホ幅でトップページの CTA が画面内に収まる', priority: 'p1', ac: [{ given: '幅 390px の端末', when: 'トップページを開く', then: '「Start free trial」が画面内に表示され、横スクロールが発生しない' }] },
  { key: 'landing-visual', title: 'トップページの見た目が意図せず変わらない', priority: 'p1', ac: [{ given: '承認済み baseline', when: 'リリース候補でトップページを撮影する', then: '差分がない。意図した変更は理由付きで baseline を更新する' }] },
  { key: 'links', title: 'サイト内リンクが切れていない', priority: 'p1', ac: [{ given: 'トップページ', when: '同一オリジンのリンクを辿る', then: '404 / 5xx が存在しない' }] },
  { key: 'console', title: 'サインアップ画面で JavaScript 例外が発生しない', priority: 'p2', ac: [{ given: 'サインアップ画面', when: 'ページを読み込む', then: 'uncaught exception / console error がない' }] },
  { key: 'download', title: 'レポートは report.csv (text/csv) としてダウンロードできる', priority: 'p1', ac: [{ given: 'ログイン済みダッシュボード', when: 'Download report を押す', then: 'ファイル名 report.csv、MIME text/csv' }] },
  { key: 'upload', title: 'アバターのアップロードは画像以外を拒否する', priority: 'p2', ac: [{ given: '設定画面', when: 'テキストファイルを選んで送信する', then: '「Rejected」と表示され保存されない' }] },
  { key: 'a11y', title: '設定画面に既知のアクセシビリティ違反がない', priority: 'p2', ac: [{ given: '設定画面', when: 'axe (WCAG 2.0 A/AA) を実行する', then: 'label 欠落・lang 欠落などの違反がない' }] },
  { key: 'api-contract', title: 'profile API のレスポンス契約を守る', priority: 'p0', ac: [{ given: 'ログイン API のトークン', when: 'GET /api/profile を呼ぶ', then: 'id/email/name/plan が文字列で返り 3 秒以内に応答する' }] },
];

export const SEED_SCENARIOS: Array<{ key: string; title: string; priority: 'p0' | 'p1' | 'p2'; req?: string; steps: unknown[]; expected: string; tags?: string[] }> = [
  { key: 'smoke-landing', title: 'トップページが表示される', priority: 'p1', tags: ['smoke'], expected: 'タイトルに Sample SaaS を含み、CTA が表示される', steps: [{ type: 'navigate', url: '/' }, { type: 'assert_title', title: 'Sample SaaS' }, { type: 'assert_element', target: { role: 'link', name: 'Start free trial' }, state: 'visible' }, { type: 'screenshot', label: 'landing' }] },
  { key: 'smoke-login', title: 'ログインしてダッシュボードが表示される', priority: 'p0', tags: ['smoke', 'auth'], expected: 'ダッシュボードに Welcome back が表示される', steps: [{ type: 'login_profile' }, { type: 'assert_url', url: '/dashboard' }, { type: 'assert_text', text: 'Welcome back' }] },
  { key: 'smoke-pricing', title: 'Pricing ページが表示される', priority: 'p2', tags: ['smoke'], expected: 'Pricing の見出しが表示される', steps: [{ type: 'navigate', url: '/pricing' }, { type: 'assert_text', text: 'Pricing' }] },
  { key: 'crit-login-error', title: 'ログイン失敗時にエラーが表示される', priority: 'p0', req: 'login-error', tags: ['auth'], expected: 'Invalid email or password が表示される', steps: [{ type: 'navigate', url: '/login' }, { type: 'fill', target: { label: 'Email' }, value: 'wrong@example.com' }, { type: 'fill', target: { label: 'Password' }, value: '{{secret:LOGIN_PASSWORD}}' }, { type: 'click', target: { role: 'button', name: 'Log in' } }, { type: 'assert_text', text: 'Invalid email or password' }] },
  { key: 'crit-signup-double', title: 'サインアップの二重送信防止と必須チェック', priority: 'p0', req: 'signup-guard', tags: ['form'], expected: '空送信でエラー、連打しても 1 件のみ作成', steps: [{ type: 'navigate', url: '/signup' }, { type: 'form_check', target: { css: '#signup-form' }, submitTarget: { css: '#signup-submit' }, expectErrorOnEmpty: true }, { type: 'fill', target: { label: 'Name' }, value: 'Test User' }, { type: 'fill', target: { label: 'Email' }, value: 'new-user@example.com' }, { type: 'fill', target: { label: 'Password' }, value: 'Passw0rd-xyz' }, { type: 'form_check', target: { css: '#signup-form' }, submitTarget: { css: '#signup-submit' }, expectDoubleSubmitGuard: true }] },
  { key: 'crit-dashboard-5xx', title: 'ダッシュボードで 5xx が発生しない', priority: 'p0', req: 'dashboard-api', tags: ['network'], expected: '/api/profile を含め 5xx がない', steps: [{ type: 'login_profile' }, { type: 'wait', ms: 1800 }, { type: 'assert_network', noStatusAtLeast: 500 }] },
  { key: 'crit-download', title: 'レポートのダウンロード (report.csv / text/csv)', priority: 'p1', req: 'download', tags: ['file'], expected: 'report.csv が text/csv で保存される', steps: [{ type: 'login_profile' }, { type: 'download', target: { css: '#export' }, expectFilename: 'report.csv', expectMime: 'text/csv' }] },
  { key: 'crit-console', title: 'サインアップ画面にコンソール例外がない', priority: 'p2', req: 'console', tags: ['console'], expected: 'console error / uncaught exception が 0 件', steps: [{ type: 'navigate', url: '/signup' }, { type: 'wait', ms: 300 }, { type: 'assert_console', maxErrors: 0 }] },
  { key: 'crit-links', title: 'トップページのリンク切れがない', priority: 'p1', req: 'links', tags: ['links'], expected: '同一オリジンのリンクがすべて 2xx/3xx', steps: [{ type: 'navigate', url: '/' }, { type: 'link_check', sameOriginOnly: true, maxLinks: 50 }] },
  { key: 'crit-upload-reject', title: 'アバターは画像以外を拒否する', priority: 'p2', req: 'upload', tags: ['file'], expected: 'Rejected と表示される', steps: [{ type: 'login_profile' }, { type: 'navigate', url: '/settings' }, { type: 'upload', target: { label: 'Avatar (PNG/JPEG)' }, fixture: 'notes.txt' }, { type: 'click', target: { css: '#avatar-submit' } }, { type: 'assert_text', target: { css: '#avatar-msg' }, text: 'Rejected' }] },
  { key: 'visual-landing', title: 'トップページの Visual baseline', priority: 'p1', req: 'landing-visual', tags: ['visual'], expected: '承認済み baseline と一致する', steps: [{ type: 'navigate', url: '/' }, { type: 'screenshot', label: 'landing', visualCheck: true }] },
  { key: 'visual-login', title: 'ログイン画面の Visual baseline', priority: 'p2', tags: ['visual'], expected: '承認済み baseline と一致する', steps: [{ type: 'navigate', url: '/login' }, { type: 'screenshot', label: 'login', visualCheck: true }] },
  { key: 'mobile-landing', title: 'トップページのスマホ表示 (CTA / 横スクロール)', priority: 'p1', req: 'mobile-cta', tags: ['mobile', 'responsive'], expected: 'CTA が画面内、横スクロールなし', steps: [{ type: 'navigate', url: '/' }, { type: 'responsive_check' }, { type: 'assert_no_horizontal_scroll' }] },
  { key: 'api-profile-contract', title: 'profile API の契約 (schema / 値 / レイテンシ)', priority: 'p0', req: 'api-contract', tags: ['api'], expected: 'schema 一致、email 一致、3 秒以内', steps: [{ type: 'api_request', method: 'POST', url: '/api/auth/login', body: { email: '{{secret:LOGIN_EMAIL}}', password: '{{secret:LOGIN_PASSWORD}}' }, expectStatus: 200, saveAs: 'login' }, { type: 'api_request', method: 'GET', url: '/api/profile', headers: { authorization: 'Bearer {{var:login.token}}' }, expectStatus: 200, expectSchema: PROFILE_SCHEMA, expectJsonPath: [{ path: 'email', equals: 'demo@example.com' }], maxLatencyMs: 3000 }] },
  { key: 'api-profile-latency', title: 'profile API のレイテンシ (performance smoke)', priority: 'p2', tags: ['api', 'performance'], expected: '800ms 以内に応答する', steps: [{ type: 'api_request', method: 'POST', url: '/api/auth/login', body: { email: '{{secret:LOGIN_EMAIL}}', password: '{{secret:LOGIN_PASSWORD}}' }, expectStatus: 200, saveAs: 'login' }, { type: 'api_request', method: 'GET', url: '/api/profile', headers: { authorization: 'Bearer {{var:login.token}}' }, maxLatencyMs: 800 }] },
  { key: 'a11y-settings', title: '設定画面のアクセシビリティ (axe WCAG 2.0 A/AA)', priority: 'p2', req: 'a11y', tags: ['accessibility'], expected: 'critical / serious な違反がない', steps: [{ type: 'login_profile' }, { type: 'navigate', url: '/settings' }, { type: 'accessibility_check', tags: ['wcag2a', 'wcag2aa'] }] },
];

export const SEED_SUITES: Array<{ name: string; kind: 'smoke' | 'critical' | 'visual' | 'mobile' | 'api' | 'accessibility'; description: string; scenarios: string[]; matrix: Record<string, unknown>; requiredForRelease?: boolean }> = [
  { name: 'Smoke', kind: 'smoke', description: 'デプロイ直後の最小確認（1〜2 分）', scenarios: ['smoke-landing', 'smoke-login', 'smoke-pricing'], matrix: { browsers: ['chromium'], viewports: [DESKTOP], retries: 1, video: 'on_failure', trace: 'on_failure' } },
  { name: 'Critical', kind: 'critical', description: 'リリース判定に必須。ログイン / フォーム / API / ダウンロード / リンク / コンソール', scenarios: ['smoke-login', 'crit-login-error', 'crit-signup-double', 'crit-dashboard-5xx', 'crit-download', 'crit-console', 'crit-links', 'crit-upload-reject'], matrix: { browsers: ['chromium'], viewports: [DESKTOP], retries: 1, video: 'on_failure', trace: 'on_failure' }, requiredForRelease: true },
  { name: 'Visual', kind: 'visual', description: '承認済み baseline との画像比較', scenarios: ['visual-landing', 'visual-login'], matrix: { browsers: ['chromium'], viewports: [DESKTOP], retries: 0, video: 'off', trace: 'on_failure' } },
  { name: 'Mobile', kind: 'mobile', description: 'iPhone / Android 相当の viewport で CTA・横スクロール・レイアウトを確認', scenarios: ['mobile-landing', 'smoke-landing'], matrix: { browsers: ['chromium'], viewports: [DESKTOP, IPHONE, ANDROID], retries: 0, video: 'on_failure', trace: 'on_failure' } },
  { name: 'API', kind: 'api', description: 'auth / profile API の契約とレイテンシ', scenarios: ['api-profile-contract', 'api-profile-latency'], matrix: { browsers: ['chromium'], viewports: [DESKTOP], retries: 0, video: 'off', trace: 'off' } },
  { name: 'Accessibility', kind: 'accessibility', description: 'axe による自動チェック（手動チェックリストと併用）', scenarios: ['a11y-settings'], matrix: { browsers: ['chromium'], viewports: [DESKTOP], retries: 0, video: 'off', trace: 'on_failure' } },
];

export async function seedSample(app: FastifyInstance, o: SeedOptions): Promise<SeedResult> {
  const email = (o.email ?? 'demo-admin@proofflow.local').toLowerCase(); const password = o.password ?? 'ProofFlow-Demo-2026';
  let cookie: string; let orgId: string; let userId: string; let credentials: SeedResult['credentials'] = null;
  const cookieOf = (res: { headers: Record<string, unknown> }) => { const sc = res.headers['set-cookie']; return (Array.isArray(sc) ? sc[0] : (sc as string)).split(';')[0]!; };
  if (o.account) ({ cookie, orgId, userId } = o.account);
  else {
    const su = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email, password, name: o.name ?? 'Demo Admin', organizationName: o.orgName ?? 'ProofFlow Demo' } });
    if (su.statusCode === 201) { cookie = cookieOf(su); orgId = su.json().data.organizationId; userId = su.json().data.userId; }
    else if (su.statusCode === 409) {
      const li = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      if (li.statusCode !== 200) throw new Error(`account ${email} exists but the password differs; set PROOFFLOW_SEED_PASSWORD`);
      cookie = cookieOf(li);
      const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
      orgId = me.json().data.organizations[0].id; userId = me.json().data.actor.userId;
    } else throw new Error('signup failed: ' + su.body);
    credentials = { email, password };
  }
  const H = { cookie };
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, extra: Record<string, string> = {}) => {
    const res = await app.inject({ method, url, headers: { ...H, ...extra }, payload: payload as never });
    if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
    return res.json().data;
  };
  const projectName = o.projectName ?? 'Sample SaaS';
  const existing = (await call('GET', `/api/v1/orgs/${orgId}/projects`)) as Array<{ name: string }>;
  if (existing.some((p) => p.name === projectName)) throw new Error(`project "${projectName}" already exists in this organization — the sample is already seeded`);

  const project = await call('POST', `/api/v1/orgs/${orgId}/projects`, { name: projectName, type: 'web_app', description: 'ProofFlow の動作確認用デモ。意図的なバグが仕込まれた Sample SaaS を対象にします。', tags: ['demo'], timezone: 'Asia/Tokyo' });
  const projectId = project.id as string; const P = `/api/v1/projects/${projectId}`;
  const env = await call('POST', `${P}/environments`, { name: 'Local (Sample SaaS)', kind: 'local', baseUrl: o.sampleUrl, allowPrivateNetwork: true, testDataPolicy: 'fixture', authProfile: { kind: 'password_form', loginUrl: '/login', usernameTarget: { label: 'Email' }, passwordTarget: { label: 'Password' }, submitTarget: { role: 'button', name: 'Log in' }, usernameSecretRef: 'LOGIN_EMAIL', passwordSecretRef: 'LOGIN_PASSWORD', successUrlContains: '/dashboard' }, maskSelectors: ['#welcome'] });
  const envId = env.id as string;
  await call('PATCH', P, { defaultEnvironmentId: envId });
  await call('PUT', `${P}/secrets`, { name: 'LOGIN_EMAIL', value: 'demo@example.com', description: 'Sample SaaS のテスト用アカウント（偽データ）' });
  await call('PUT', `${P}/secrets`, { name: 'LOGIN_PASSWORD', value: 'demo-pass-123', description: 'Sample SaaS のテスト用パスワード（偽データ）' });
  await call('PUT', `${P}/fixtures?name=avatar.png`, PNG_1x1, { 'content-type': 'image/png' });
  await call('PUT', `${P}/fixtures?name=notes.txt`, 'these are notes, not an image', { 'content-type': 'text/plain' });

  const requirements: Record<string, string> = {};
  for (const r of SEED_REQUIREMENTS) requirements[r.key] = (await call('POST', `${P}/requirements`, { title: r.title, priority: r.priority, status: 'approved', source: 'Sample SaaS 受入基準', acceptanceCriteria: r.ac.map((a) => ({ format: 'gwt', ...a })) })).id;
  const scenarios: Record<string, string> = {};
  for (const s of SEED_SCENARIOS) scenarios[s.key] = (await call('POST', `${P}/scenarios`, { title: s.title, priority: s.priority, steps: s.steps, expected: s.expected, tags: s.tags, requirementIds: s.req ? [requirements[s.req]!] : [], origin: 'manual' })).id;
  const suites: Record<string, string> = {};
  for (const su of SEED_SUITES) suites[su.name] = (await call('POST', `${P}/suites`, { name: su.name, kind: su.kind, description: su.description, matrix: su.matrix, scenarioIds: su.scenarios.map((k) => scenarios[k]!), requiredForRelease: !!su.requiredForRelease })).id;
  const manualCase = await call('POST', `${P}/manual-cases`, { title: 'iPhone 実機スモーク（ログイン → ダッシュボード → レポートダウンロード）', category: 'device', label: 'iPhone smoke', description: '自動テストでは代替できない実機確認。Safari で実施し、スクリーンショットを証跡として添付する。', steps: '1. Safari で Sample SaaS を開く\n2. demo アカウントでログイン\n3. ダッシュボードの表示を確認\n4. Download report を押して report.csv が保存されることを確認', expected: '各画面が崩れず、ダウンロードが完了する', requirementIds: [requirements['download']!, requirements['mobile-cta']!] });
  const schedule = await call('POST', `${P}/schedules`, { suiteId: suites['Critical'], environmentId: envId, cron: '0 2 * * *', timezone: 'Asia/Tokyo', enabled: false, label: '毎晩 2:00 Critical（有効化して利用）' });
  const rc = await call('POST', `${P}/releases`, { version: '1.2.0', commitSha: 'a1b2c3d', buildId: 'build-120', environmentId: envId, includedChanges: 'ログイン画面の再設計 / ダッシュボード profile API の変更 / トップページ CTA のスタイル調整 / レポート出力の見直し', requiredSuiteIds: [suites['Critical']!], requiredManualChecks: ['iPhone smoke'] });
  let runnerToken: string | null = null;
  if (o.createRunnerToken) runnerToken = (await call('POST', `/api/v1/orgs/${orgId}/tokens`, { name: 'local-runner', kind: 'runner' })).token;
  return { orgId, userId, cookie, projectId, envId, requirements, scenarios, suites, rcId: rc.id, manualCaseId: manualCase.id, scheduleId: schedule.id, runnerToken, credentials };
}

async function main() {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });
  const db = await openDb({ driver: cfg.dbDriver, url: cfg.databaseUrl, sqlitePath: cfg.sqlitePath });
  await migrate(db);
  const app = await buildApp({ cfg: { ...cfg, scheduler: { ...cfg.scheduler, enabled: false } }, db });
  await app.ready();
  try {
    const r = await seedSample(app, { sampleUrl: process.env.PROOFFLOW_SAMPLE_URL ?? 'http://127.0.0.1:4100', email: process.env.PROOFFLOW_SEED_EMAIL, password: process.env.PROOFFLOW_SEED_PASSWORD, createRunnerToken: true });
    console.log(`[seed] Sample SaaS project seeded: project=${r.projectId} env=${r.envId} rc=1.2.0 (${r.rcId})`);
    console.log(`[seed] suites: ${Object.keys(r.suites).join(', ')} · scenarios: ${Object.keys(r.scenarios).length} · requirements: ${Object.keys(r.requirements).length}`);
    if (r.credentials) console.log(`[seed] Web UI login: ${r.credentials.email} / ${r.credentials.password}  (change it after first login)`);
    if (r.runnerToken) console.log(`[seed] runner token (shown once): PROOFFLOW_RUNNER_TOKEN=${r.runnerToken}`);
    console.log('[seed] next: pnpm dev:sample (Sample SaaS on :4100) → pnpm dev:runner (with the token above) → open the UI and run the Critical suite for RC 1.2.0');
  } finally { await app.close(); await db.close(); }
}
if (process.argv[1] && /seed[\\/]sample\.(ts|js)$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
