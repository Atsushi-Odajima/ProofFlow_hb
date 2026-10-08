# DEVELOPMENT.md — 開発者向けガイド

## 前提
- Node.js 22.13+（`node:sqlite` を使用。本開発では 22.22.0）、pnpm 10（`corepack enable`）。
- ブラウザ: `npx playwright install chromium`（Firefox / WebKit も使う場合は `firefox webkit` を追加）。本開発環境では Chromium 141 のみ検証済み（TEST_REPORT.md）。
- PostgreSQL 16（任意）: `PROOFFLOW_DB_DRIVER=postgres` の検証用。

## リポジトリ構成（pnpm workspace）
```
packages/shared      型・zod schema・RBAC・step 定義・URL policy・redaction（server / runner / cli / web が共有）。bugreport/ は ProofFlow 不具合報告・個人情報マスク（ブラウザでも動くので node:* を import しない。web は @proofflow/shared/bugreport を bundle）
packages/server      control plane: Fastify API、DB（SQLite / PostgreSQL）、services、runner protocol、Web UI 配信、scheduler、restore CLI、seed
packages/runner      runner plane: Playwright で typed step を実行、evidence 収集、redaction、trace 再パック
packages/cli         proofflow CLI（run/status/gate/retest/impact/export/import/report）と REST client（@proofflow/cli/api）
packages/mcp         ChatGPT / Codex / Claude Code 向け MCP server（stdio / Streamable HTTP）
packages/web         React + Vite PWA（control plane が dist を配信）
packages/sample-saas 意図的バグ入りのデモ対象アプリ
tests/               vitest（phase1〜11、bugreport、e2e、load、ui）
docs/                設計・運用・購入者向け資料
deploy/              Dockerfile / docker-compose / GitHub Actions 例
```

## よく使うコマンド
```bash
pnpm install
pnpm typecheck                      # 全パッケージ tsc --noEmit
pnpm build                          # 全パッケージ build（web は vite build）
pnpm test                           # 単体〜統合（Chromium 必須、約 70 秒）
pnpm test:pg                        # 同じテストを PostgreSQL 16 で（PROOFFLOW_TEST_DATABASE_URL）
pnpm test:e2e                       # E2E-1〜10
pnpm build:web && pnpm test:ui      # PC / iPhone / Android の UI 検証（docs/ui-verification/ にスクリーンショット）
pnpm test:load                      # 負荷計測（docs/load-results-<dialect>.json）
pnpm dev:server                     # http://127.0.0.1:8080（UI は pnpm build:web 後に同一ポートで配信、開発中は pnpm dev:web で :5173 + proxy）
pnpm dev:sample                     # Sample SaaS http://127.0.0.1:4100
pnpm seed:sample                    # デモ用 Project / Suite / RC 1.2.0 を投入（runner token を表示）
PROOFFLOW_RUNNER_TOKEN=pfr_... pnpm dev:runner
```

## 設計の要点（詳細は各ドキュメント）
- Control plane と runner plane は HTTP + runner token で分離（RUNNER_ARCHITECTURE.md）。runner は DB / Vault に触れない。
- テストは typed step の JSON（TEST_MODEL.md）。任意 JavaScript は実行しない。
- すべての API handler が `requireOrg` / `requireProject` を通る（RBAC は UI だけでは制御しない）。クロステナントは 404。
- Secret は `{{secret:NAME}}` 参照のみ保存。runner 側 Redactor が evidence から値を除去（ARTIFACT_SECURITY.md）。
- AI は提案（`ai_suggestions`）を保存するだけ。結果 / baseline / Expected / Gate を書き換えない（AI_ASSISTANCE.md）。
- Release Gate は決定論的ルール評価。承認は人間のみ（RELEASE_GATE.md）。

## DB
- `packages/server/src/db/schema.ts` の `MIGRATIONS` に SQL を追記（SQLite / PostgreSQL 両方で動く DDL のみ）。`SCHEMA_VERSION`（shared/index.ts）を上げる。
- 方言差: `?` プレースホルダ共通、boolean は 0/1、時刻は ISO 文字列、JSON は TEXT。`ON CONFLICT ... DO UPDATE` は両方で可。`LIMIT ?` も可。
- 新しいテーブルを足したら BackupService の `TABLES`（FK 順）にも追加する（tests/phase11 が復元を検証）。

## 新しい step type を追加する
1. `packages/shared/src/steps.ts` に zod schema を追加（必要なら `isStepPotentiallyDestructive` も）。
2. `packages/runner/src/steps.ts` の `executeStep` に実装（失敗は `StepFailure` の `type` を正しく分類）。
3. `packages/web/src/components/StepEditor.tsx` にフォームを追加。
4. `tests/phase4` または `phase5` にテストを追加（Sample SaaS にバグトグルを足す場合は `packages/sample-saas`）。
5. TEST_MODEL.md と `docs/buyer/` の該当資料を更新。

## テストの書き方
- `tests/helpers/app.ts`: in-memory SQLite の control plane（`PROOFFLOW_TEST_DATABASE_URL` で PostgreSQL）。
- `tests/helpers/pipeline.ts`: 実ポートで listen する control plane + Sample SaaS + in-process Chromium runner。
- `tests/helpers/demo.ts`: seed した Sample SaaS で RC 1.2.0 のデモフロー（E2E / UI 検証が共用）。
- テストは外部ネットワークを使わない。AI provider は `mock` か `none`。

## リリース手順
1. `pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build:web && pnpm test:ui`
2. `pnpm test:pg`（PostgreSQL が使える環境で）
3. `APP_VERSION`（shared/index.ts）、CHANGELOG、docs/PROGRESS.md を更新
4. RELEASE_CHECKLIST.md の人間確認項目を実施

## コーディング規約
- TypeScript strict、ESM（NodeNext）、`verbatimModuleSyntax`。
- 1 ファイル 1 責務。services は DB と audit を受け取る class。routes は parse → authorize → service。
- ログ / 監査 / AI 入力に secret や artifact 本文を入れない（`redactDeep`）。
- エラーは `HttpError`（context.ts）。想定外は 500 + requestId。
