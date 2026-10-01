# SOURCE_NOTES.md — 実装時点の公式資料確認記録

確認日: **2026-10-01**（この開発セッションの実行日。環境の `date` と npm registry の dist-tags を基準）

## 0. 確認方法と制約（正直な記録）

- このコンテナの egress policy では `playwright.dev` / `modelcontextprotocol.io` / `developers.openai.com` / `platform.openai.com` / `docs.github.com` / Playwright ブラウザ CDN（`cdn.playwright.dev`, `playwright.download.prss.microsoft.com`）への接続が **403 で遮断** されていた（`$HTTPS_PROXY/__agentproxy/status` の `recentRelayFailures` に記録）。
- そのため一次資料は次の経路で確認した:
  1. **各プロジェクトの公式 GitHub リポジトリ上のドキュメントソース**（docs サイトはこれらから生成される）
  2. **npm registry の公式パッケージ本体**（型定義・README・CLI の `--help` 出力）
  3. 実測 PoC（本環境の Chromium）
- 「docs サイトの表示そのもの」を見たわけではない箇所は下記で明示する。販売前に人間が docs サイトで再確認すること（RELEASE_CHECKLIST.md に項目化）。

## 1. Playwright

| 項目 | 確認結果 | source |
|---|---|---|
| 最新版 | **1.63.0**（npm `latest`、2026-10-01） | `npm view playwright dist-tags` |
| 本環境で検証した版 | **1.56.1**（コンテナにプリインストールされた `playwright-core@1.56.1` と Chromium build 1194 に合わせた。CDN 遮断のため 1.63 用ブラウザを取得できない） | `/opt/node-tools/node_modules/playwright-core/package.json`, `browsers.json` |
| Chromium | 141.0.7390.37（1.56.1 の build 1194）で PoC 実測 | PoC 実行ログ |
| Firefox / WebKit | 1.56.1 では firefox build 1495 / webkit build 2215 が対応版。**本環境には未インストール**（`browserType.launch: Executable doesn't exist` を実測）。コードパスは実装するが本環境では未検証 | PoC 実行ログ |
| 1.63 の主な変更 | Test Locks、frame locators、`Locator.visible()`、trace に aria/screen snapshot、WebP screenshot。1.62: AbortSignal、`retryStrategy: 'isolated'`。1.61: video mode `'on-all-retries'` / `'retain-on-failure-and-retries'` 追加 | `github.com/microsoft/playwright/blob/main/docs/src/release-notes-js.md` |
| Trace API | `context.tracing.start({ screenshots, snapshots, sources, title })` / `tracing.stop({ path })`。trace は actions / network / console / DOM snapshots / metadata を含む。閲覧は `npx playwright show-trace trace.zip` または trace.playwright.dev（ブラウザ内処理、外部送信なし） | `docs/src/trace-viewer.md` |
| Video API | `browser.newContext({ recordVideo: { dir, size } })`。**video は context close 後に確定**。`page.video().path()` / `saveAs()` / `delete()` | `docs/src/videos.md` |
| Emulation | `devices[...]` レジストリ（'iPhone 15' 393x659, 'iPhone 13' 390x664, 'Pixel 7' 412x839 を 1.56.1 で実測）。`viewport`, `deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent`, `locale`, `timezoneId`, `colorScheme`, `geolocation`, `permissions`, `offline`, `javaScriptEnabled`。device descriptor は特定 platform を前提にする | `docs/src/emulation.md`, PoC |
| Browsers / install | `npx playwright install [browser] [--with-deps]`、`PLAYWRIGHT_BROWSERS_PATH`、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`、`PLAYWRIGHT_DOWNLOAD_HOST`（社内ミラー）。Chromium は headless shell と new headless の 2 系統 | `docs/src/browsers.md` |
| Visual comparison | `toHaveScreenshot` の `maxDiffPixels` / `maxDiffPixelRatio` / `threshold`(既定 0.2) / `mask` / `maskColor` / `fullPage` / `animations` / `caret` / `scale` / `clip` / `stylePath`。既定 comparator は pixelmatch。**OS/ブラウザ/ハードウェア/電源状態で描画が変わるため baseline は同一環境（Docker 推奨）で生成**。ProofFlow は Playwright Test runner ではなく library API を使うため、比較は `pixelmatch@7.2.0` + `pngjs@7.0.0` で自前実装（PoC で動作確認） | `docs/src/test-snapshots-js.md`, PoC |
| Accessibility | `@axe-core/playwright@4.13.0`（`AxeBuilder({page}).withTags([...]).include/exclude/disableRules().analyze()`）。**「自動テストで検出できるのは一部。多くは手動テストでしか見つからない」** と公式に明記 → Manual checklist 併設 | `docs/src/accessibility-testing-js.md`, PoC（violations: `html-has-lang:serious`, `label:critical` を検出） |
| Network / Console | `page.on('request'|'response'|'requestfailed'|'console'|'pageerror'|'websocket')`、`response.status()`、`request.failure()`、`request.timing()`、`page.route()` で mock/abort、HAR 記録 `recordHar { content, mode, urlFilter }` | `docs/src/network.md`, PoC |

PoC 実測値（1.56.1 / Chromium 141 / headless / 4 vCPU）: 起動 0.85s、goto 1.1s、fullPage screenshot ~139KB、trace.zip（screenshots+snapshots）542KB、iPhone13 viewport の webm video 80KB/約 12 秒、axe 解析 ~3s。

## 2. Model Context Protocol (MCP)

| 項目 | 確認結果 | source |
|---|---|---|
| 仕様バージョン一覧 | `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`, **`2026-07-28`**, `draft` | `github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs/specification` |
| TypeScript SDK | `@modelcontextprotocol/sdk@1.31.0`。`LATEST_PROTOCOL_VERSION = '2025-11-25'`、`SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`。**SDK 1.31 は 2026-07-28 版をまだ実装していない** | `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js` |
| SDK API | `McpServer.registerTool(name, {title, description, inputSchema, outputSchema, annotations}, cb)`（`tool()` は deprecated）。transports: `StdioServerTransport`, `StreamableHTTPServerTransport`（`sessionIdGenerator`, DNS rebinding protection オプション）, `SSEServerTransport`（後方互換のみ）。tool annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` | SDK `dist/esm/server/*.d.ts`, README |
| Transport 要件 (2025-11-25) | stdio: stdout は MCP メッセージのみ、ログは stderr。Streamable HTTP: 単一 endpoint で POST/GET、`Accept: application/json, text/event-stream`、`Mcp-Session-Id`、`MCP-Protocol-Version` header、DELETE で session 終了、期限切れ session は 404。**Origin header 検証（DNS rebinding 対策、403）**、ローカルは 127.0.0.1 bind、認証必須 | `docs/specification/2025-11-25/basic/transports.mdx` |
| 2026-07-28 の変更（SDK 未対応、設計上の留意） | initialize handshake 廃止（stateless, `_meta` に version/capabilities）、`Mcp-Session-Id` 廃止、`server/discover` RPC、`subscriptions/listen`、MRTR（`InputRequiredResult`）、Tasks の拡張化、SSE resumability 廃止、`resultType` 必須、OAuth で `iss` 検証（RFC 9207）、`CacheableResult`。HTTP+SSE は deprecated。ProofFlow の tool 設計は「状態を server-minted handle（runId 等）を引数で渡す」方式にして両版で成立させる | `docs/specification/2026-07-28/changelog.mdx` |
| MCP Apps 拡張 | `ui://` scheme、`text/html;profile=mcp-app`、host が sandboxed iframe で描画。安定版 spec 2026-01-26、SDK ^2.0.0。ChatGPT / Claude / VS Code 等が対応。ProofFlow 初版は text/structuredContent のみ（UI 拡張は Pro 候補） | `github.com/modelcontextprotocol/ext-apps` README |

## 3. OpenAI ChatGPT / Codex

| 項目 | 確認結果 | source |
|---|---|---|
| ChatGPT Apps (Apps SDK) | MCP server を Streamable HTTP（例では `/mcp`、SSE 互換もあり）で公開し、ChatGPT の **developer mode** で connector として追加。tool は `content` + `structuredContent` + `_meta`（例: `openai/outputTemplate` で widget 紐付け）。認証例は **OAuth 2.1**。公開はローカルを ngrok 等で HTTPS 露出 | `github.com/openai/openai-apps-sdk-examples`（公式サンプル, README） |
| developers.openai.com の Apps SDK ページ | **遮断のため未閲覧**。サンプル repo の記述と MCP 仕様で代替。販売前に人間が確認すること | — |
| Codex CLI | `@openai/codex@0.159.3` を npm から取得し実行して確認: `codex mcp add <NAME> --url <URL> [--bearer-token-env-var ENV]`（streamable HTTP）、`codex mcp add <NAME> [--env K=V] -- <COMMAND>...`（stdio）、`codex mcp list/get/remove/login/logout`、OAuth オプション（`--oauth-client-id`, `--oauth-client-registration auto|cimd|dcr`, `--oauth-resource`）。設定は `~/.codex/config.toml` の `[mcp_servers.<name>]` | `codex mcp --help`, `codex mcp add --help`（実行出力） |
| Codex docs/config.md | GitHub 上のファイルは developers.openai.com へのリンク中心で MCP 詳細を含まず（遮断のため本文未閲覧） | `github.com/openai/codex/blob/main/docs/config.md` |

## 4. GitHub Actions / CI

| 項目 | 確認結果 | source |
|---|---|---|
| Secrets | Libsodium sealed box で暗号化。ログの自動 redaction は **保証されない**（変形・結合された値、構造化データ JSON/XML は redaction されにくい）。`::add-mask::` で実行時値をマスク。**fork からの `pull_request` には secrets が渡らない** | `github.com/github/docs/blob/main/content/actions/concepts/security/secrets.md` |
| Workflow syntax | `on: push / pull_request / schedule(cron) / workflow_dispatch`、`runs-on`、`${{ secrets.NAME }}`（`if:` で直接参照不可）、`continue-on-error`、`timeout-minutes`、`github.sha` / `github.ref` / `github.head_ref` / `github.run_id` / `github.event.pull_request.number` | `content/actions/reference/workflows-and-actions/workflow-syntax.md` |
| actions/checkout | README の推奨タグ **v7**（`fetch-depth` 既定 1） | `github.com/actions/checkout` README |
| actions/setup-node | README の推奨タグ **v7**、`node-version: 24` 例、`cache: 'pnpm'` 等 | `github.com/actions/setup-node` README |

## 5. その他ライブラリ（npm `latest`, 2026-10-01）

fastify 5.12.5 / zod 4.6.5 / vitest 5.0.3 / typescript 7.0.2（**本製品は 5.9.3 を使用**: 7.x はネイティブ実装の新系統で周辺ツール互換を未検証） / react 19.3.0 / vite 8.3.1 / pixelmatch 7.2.0 / pngjs 7.0.0 / jszip 3.10.2 / pg 8.23.1 / @axe-core/playwright 4.13.0 / commander 15.0.0 / openai 7.25.0 / @anthropic-ai/sdk 0.131.0。

AI provider は公式 SDK（`@anthropic-ai/sdk` 0.131.0 / `openai` 7.25.0）を使用。AI OFF（`PROOFFLOW_AI_PROVIDER=none`）時は provider オブジェクト自体を生成しないため呼び出しゼロ（tests/phase2 で検証）。実 API 呼び出しは課金のため未実施（型検査 + mock provider）。

## 6. 本環境の実測基盤

- Node v22.22.0（`node:sqlite` 利用可）、pnpm 10.28.0、PostgreSQL 16.14（ローカル cluster を起動可能）、Redis 7.0.15（未使用）、Docker CLI あり / daemon なし。
- 4 vCPU / 15 GiB RAM。

## 7. 販売前に人間が再確認すべき項目

1. playwright.dev の最新 release notes と、購入者が使う Playwright 版（`npx playwright install` の対象）。
2. developers.openai.com の Apps SDK / Codex MCP ページ（遮断により未閲覧）。
3. modelcontextprotocol.io の最新仕様（2026-07-28 以降の SDK 対応状況）。
4. docs.github.com の Actions secrets / syntax ページの最新表示。

## 8. Phase 11 / 12 で追加した一次情報（2026-10-01）

- PostgreSQL 16.14（本環境のローカル cluster、`psql` で確認）: `pnpm test:pg` で phase1〜11 を実行（TEST_REPORT.md）。接続文字列の `options=-c search_path=...` は `pg-connection-string`（pg 8.23.1 同梱）の実装で確認。
- Playwright Docker image タグ `mcr.microsoft.com/playwright:v1.56.1-noble`（deploy/Dockerfile.runner）: Playwright の公式イメージ命名規則（`v<version>-<ubuntu codename>`）に従う。playwright.dev は遮断のため未閲覧。販売前に `docker pull` で存在を確認すること（RELEASE_CHECKLIST.md A）。
- `node:sqlite` の `DatabaseSync`（Node 22.22.0）は ExperimentalWarning を出すが動作に問題なし（Node 22.13 以降で利用可）。
- 負荷計測は `tests/load/load.test.ts`（自作、外部ツール不使用）。結果 `docs/load-results-sqlite.json`。
- UI 検証は Playwright 1.56.1 の Chromium 141 のデバイスエミュレーション（iPhone 15 相当 390×844 @3x、Pixel 8 相当 412×915 @2.625x）。実機ではない。
