# RELEASE_CHECKLIST.md — 販売前に人間が確認すること

本セッション（AI 開発）で**できなかった / しなかった**ことを中心に、販売者が自分で確認する項目です。チェック済みでないものは「未検証」として販売資料に書いてください。

## A. 本セッションで検証できなかった項目（必ず人間が実施）
- [ ] **Firefox / WebKit での実行**: 本環境にはブラウザ本体がなく（CDN 到達不可）Chromium 141 のみ検証。`npx playwright install firefox webkit` 後に `pnpm test`（matrix に firefox / webkit を含むテストを追加して実行）。Firefox / WebKit 固有の挙動（ダウンロード、video、trace）を手で確認する。
- [ ] **実機（iPhone / Android）**: 本セッションの「iPhone / Android 検証」は Chromium の viewport エミュレーション（docs/ui-verification/）。Safari / Chrome for Android で Web UI（PWA インストール含む）と Sample SaaS を実機で開き、Manual Device Check に証跡を残す。
- [ ] **AI provider の実呼び出し**: OpenAI / Anthropic provider は型検査とモック応答のみ。API キーを設定し `PROOFFLOW_AI_PROVIDER=openai|anthropic` で「シナリオ下書き」「失敗要約」「セレクタ修復提案」を 1 回ずつ実行し、JSON schema 出力が通ること、料金が想定内であることを確認（課金が発生するため本セッションでは未実施）。
- [ ] **ChatGPT connector（Streamable HTTP MCP）**: `pnpm --filter @proofflow/mcp start -- --http` を HTTPS 公開 URL に置き、ChatGPT の developer mode / connector 設定から接続して 12 ツールが列挙・実行できることを確認（公開 URL とアカウントが必要なため未実施）。Codex / Claude Code の stdio 接続は in-process テストで検証済み。
- [ ] **公式ドキュメントの再確認**: 開発環境から playwright.dev / platform.openai.com / docs.github.com へ直接到達できず、GitHub 上の公式ソース・npm パッケージを一次情報とした（SOURCE_NOTES.md §0）。公開前にブラウザで最新版（Playwright の最新安定版、MCP spec の最新版、GitHub Actions の最新アクション版）を確認し、SOURCE_NOTES.md の日付を更新する。
- [ ] **Docker イメージのビルド**: `deploy/Dockerfile.*` と `docker-compose.yml` は本環境（レジストリ到達不可）で `docker build` を実行できていない。`docker compose -f deploy/docker-compose.yml build` を実行し、起動 → ログイン → Sample SaaS の Critical suite が通ることを確認。
- [ ] **S3 互換ストレージ**: 初版はローカル FS のみ。S3 adapter は interface のみ（Pro 候補）。
- [ ] **メール通知**: adapter は stub。SMTP / SES 等を接続する場合は実装が必要（OPERATIONS.md）。
- [ ] **TLS / リバースプロキシ**: `PROOFFLOW_PUBLIC_URL=https://...` + `PROOFFLOW_TRUST_PROXY=1` で cookie Secure / CSRF の origin 判定が正しく働くことを実環境で確認。

## B. セキュリティ（出荷前）
- [ ] `PROOFFLOW_MASTER_KEY` / `PROOFFLOW_SIGNING_SECRET` を本番用に生成し、`data/` の自動生成鍵を使っていないこと。
- [ ] `PROOFFLOW_ALLOW_PRIVATE_TARGETS` が本番で `0`（未設定）であること。
- [ ] 初期ユーザーのパスワード変更、不要な runner / service token の失効（設定 → API トークン）。
- [ ] `pnpm audit`（本環境では npm レジストリの advisory 取得を未実施）。
- [ ] 公開 URL に対して SSRF（必須テスト 29）、クロステナント（必須テスト 1）、署名 URL 期限（必須テスト 7）を手で再確認。

## C. 販売資料の整合
- [ ] 「品質保証証明書 / 認証 / WCAG 準拠保証」と読める表現がないこと（Evidence Report の免責文を残す）。
- [ ] 「1 億 Result 対応」などの未計測スケールを広告しない（TEST_REPORT.md の実測値のみ）。
- [ ] 「今回実装しない」一覧（PLAN.md）と Pro 候補を資料に反映。
- [ ] 価格表（AI / クラウド）の日付を OPERATING_COSTS.md に記載し直す。
- [ ] 購入者資料 15 件（docs/buyer/）のコマンド・画面名が最新ビルドと一致。

## D. 動作確認（購入者と同じ手順）
- [ ] `pnpm install && pnpm build && pnpm dev:server`、別ターミナルで `pnpm dev:sample`、`pnpm seed:sample`、`pnpm dev:runner`。
- [ ] UI で Critical suite を RC 1.2.0 に対して実行 → BLOCKED → Sample SaaS のバグを OFF（`POST /__sample/bugs`）→ 再テスト → iPhone 手動チェック登録 → READY → Evidence Report 出力。
- [ ] `proofflow run --wait` / `proofflow gate` の終了コードが CI で期待どおり（0 / 1 / 5）。
- [ ] バックアップ取得 → 別ディレクトリへ `restore.js` → ログイン・証跡表示。

## E. 本セッションで実施済み（参考）
- `pnpm typecheck`、`pnpm test`（phase1〜11、SQLite / PostgreSQL 16）、`pnpm test:e2e`、`pnpm test:ui`（Chromium、PC / iPhone / Android viewport）、`pnpm test:load` の結果は TEST_REPORT.md。
