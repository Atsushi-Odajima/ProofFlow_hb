# DECISIONS.md — 設計判断記録（ADR 形式・追記式）

## D-001 Playwright library API を runner の中核にする（Playwright Test runner は使わない）
- 理由: ProofFlow は No-code の typed step をサーバー側データとして保持し、runner がそれを解釈する。Playwright Test の spec ファイル生成方式は「任意 JavaScript を一般利用者に提供しない」要件と相性が悪い。
- 影響: Visual 比較・retry・trace の制御を自前で実装（pixelmatch, 自前 retry ループ, `context.tracing`）。
- 検証版: 1.56.1（環境制約。SOURCE_NOTES.md §1）。

## D-002 DB は SQLite（`node:sqlite`）既定、PostgreSQL 任意。薄い SQL ラッパーを使用
- 理由: 購入者（個人〜小規模チーム）が 5 分で起動できること。`node:sqlite` はネイティブ依存ゼロ。PostgreSQL は Organization 1,000 / Run 10M 規模の設計検証と将来のスケール先。
- 方式: `?` プレースホルダの共通 SQL、boolean は INTEGER 0/1、時刻は ISO-8601 UTC TEXT、JSON は TEXT。ID はアプリ生成 ULID（時系列ソート可能、分散生成可能）。
- 却下案: ORM（Kysely/Drizzle）— 二方言サポートの型定義コストが高く、カスタム dialect の検証負荷が大きい。
- 制約: SQLite は単一 writer。トランザクションは AsyncMutex で直列化。マルチインスタンス運用は PostgreSQL 前提。

## D-003 Control Plane と Runner Plane の分離（HTTP + runner token）
- Runner は DB/Secret Vault に直接触れない。`POST /runner/v1/lease` で job と、その job に必要な secret 値だけを受け取る。
- Artifact は runner → control plane へ `PUT /runner/v1/artifacts`（octet-stream）で upload。
- Runner は別ホスト / コンテナで動作可能。Private network の対象は self-hosted runner で到達させる（control plane からの SSRF を避ける）。

## D-004 Queue は DB テーブル（lease / heartbeat / visibility timeout）
- Redis/BullMQ を初版で必須にしない。`run_jobs` テーブルで `lease_until` を用いた at-least-once 配布。PostgreSQL では `FOR UPDATE SKIP LOCKED`。
- Lease 失効 → 再キュー（上限回数）→ 超過で `infra_error`。test failure と runner error は別 status。

## D-005 Artifact は object storage 抽象 + ローカル FS 実装 + HMAC 署名 URL
- `ArtifactStore` インターフェース（put/get/delete/stat）。初版はローカル FS。署名 URL は `/artifacts/signed/:id?exp=&sig=` で有効期限付き。S3 互換 adapter は interface のみ定義し Pro 候補（本環境で検証不能なため実装を「完成」と主張しない）。
- Retention class: passed（短い） / failed / release_evidence（長い） / baseline（無期限）。

## D-006 AI plane は「提案を保存する」だけ。結果・baseline・Expected を書き換えない
- AI 出力は `ai_suggestions`（kind: scenario_draft / failure_summary / defect_draft / selector_repair / test_gap）に保存。人間が review → apply。apply 時は通常の権限チェック + audit。
- `PROOFFLOW_AI_PROVIDER=none` の時、provider HTTP 呼び出しはゼロ（テストで呼び出し回数を計測）。
- Artifact を AI に送る前に redaction policy を適用。`restricted` artifact は AI 対象外。

## D-007 認証: email+password（scrypt）セッション cookie / API token（sha256 hash 保存）
- Token 種別: personal / service(CI, MCP) / runner。Role は Organization membership で決定。service token は作成者の role 以下に制限。
- 全 API handler が `authorize()` を通る（UI だけの制御にしない）。

## D-008 Secret Vault: AES-256-GCM、master key は環境変数、値は reference 経由でのみ利用
- 定義には `{{secret:NAME}}` のみ保存。runner へは lease 応答で値を渡し、runner は evidence（console/network/trace/DOM/log）から値を文字列置換でマスク。
- Trace zip は post-process（jszip）で `.trace` / `.network` / `.stacks` のテキストエントリから secret を除去し、`authorization` / `cookie` / `set-cookie` header を redact。

## D-009 Target URL policy（SSRF 対策）
- Environment の baseURL / 各 step の URL を runner 実行前に control plane と runner の両方で検査。既定で deny: `localhost`, `127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`（metadata）, `fc00::/7`, `.internal`。
- Local 環境（`kind=local`）は self-hosted runner で `allowPrivateNetwork=true` を明示した場合のみ許可（開発者の自分の PC での利用を想定）。

## D-010 Domain verification
- Public target は DNS TXT (`proofflow-verify=<token>`) / HTML token (`<meta name="proofflow-verify">` または `/.well-known/proofflow-verify.txt`) / manual（Owner による組織内承認）。未検証 domain は「低負荷モード（concurrency 1、crawl 不可、1 日の Run 数上限）」。

## D-011 Visual baseline governance
- baseline 更新は `baseline:update` 権限（QA Lead 以上）を持つ人間のみ。履歴（誰が/いつ/なぜ/どの run/RC）を必ず残す。一括更新（> 10 件）は確認フラグ必須。AI 自動承認なし。

## D-012 Release Gate は決定論的ルール評価
- Rule の入力は DB 上の実結果（Run/Result/Defect/Manual check/Visual review/A11y）。AI は入力にならない。結果 READY / BLOCKED / READY_WITH_ACCEPTED_RISK。Accepted Risk は defect + reason + approver + review date + impact 必須。
- 承認者は人間（Owner/Admin/QA Lead）。AI は承認者になれない。

## D-013 Flaky の扱い
- 結果 status とは別に `outcome_detail` を持つ: `passed_first_try` / `passed_after_retry` / `failed_after_retries`。`passed_after_retry` は集計で Passed に隠さず Flaky として表示。

## D-014 MCP Plugin は REST API client として実装
- stdio（Codex / Claude Code / ローカル）と Streamable HTTP（ChatGPT connector / リモート）。認証は API token（header）。ChatGPT developer mode 向けに OAuth 2.1 を Phase 8 で検討（未実装なら MCP_PLUGIN.md に明記）。
- Plugin 経由でも Project/Environment の authorization を通す。第三者 URL のテストは domain policy で拒否。

## D-015 TypeScript 5.9.3 を使用（7.x は未採用）
- 理由: 7.0 はネイティブ実装の新系統。vitest / vite plugin との互換を本セッションで検証する余裕がないため安定版を採用。

## D-016 Workspace は Organization 内の論理グループ
- Role は Organization 単位。Workspace は Project のグルーピング（表示・権限委譲の将来拡張点）。tenant 分離の単位は Organization。

## D-017 Backup は Organization 単位の JSON（schemaVersion / appVersion / checksum）、復元は空環境限定の CLI
- 理由: 購入者が cron + 1 本の HTTP 呼び出しで取れること。artifact 実体は別層（ストレージ機能）で取る方が安価で確実。
- 復元を API にしない理由: tenant 境界を越える操作（users テーブル等）で、DB 直結の運用者だけが行うべきもの。既存 org / user が 1 つでもあれば拒否（マージしない）。
- checksum はテーブル順固定・キー順ソートの正規化 JSON に対する SHA-256。改変検知のみ（署名ではない）。

## D-018 Release Gate の集計対象は「Suite ごとの最新完了 Run」
- 以前は RC に紐づく全 Run を合算していたため、修正後に再実行しても古い Run の a11y 違反 / infra error が残り続けて永久に BLOCKED になった（Phase 11 のデモで発覚）。
- 現在: `suite_pass_rate` / `accessibility_max` / `no_infra_errors` は Suite ごとに最新の完了 Run だけを見る。Suite のない ad-hoc Run は個別に数える。`visual_approved` は RC に紐づく全 Run の未レビュー比較を見る（レビューは消えないため）。

## D-019 production の destructive policy 変更は人間のセッション限定
- `environment:write` + `run:trigger_destructive` に加え、actor が user（cookie session）であることを要求。API / service / MCP token からは 403 `human_required`（E2E-8 で検証）。
- 理由: AI エージェントが本番破壊テストを自分で解禁できないようにする。

## D-020 maskSelectors はスクリーンショットだけでなく DOM・失敗メッセージ・console/network にも適用
- 失敗時に masked 要素の現在のテキスト / value を Redactor に登録し、failure（message / expected / actual / stack / locator）、step 記録、console / network の NDJSON、DOM スナップショットから `[masked]` に置換する（E2E-9 で検証）。
- 理由: `assert_text` の `actual` にページ本文が入り、AI 要約の入力（`ai_suggestions.input_summary`）に PII が流れることが分かったため。video と trace 内スクリーンショットは引き続きマスク不可（既定で失敗時のみ保持）。

## D-021 UI 検証は Chromium のデバイスエミュレーション、実機は人間の確認項目
- `tests/ui` は PC 1440×900 / iPhone 15 相当 / Pixel 8 相当で全ページを撮影し、page error・console error・横 overflow を機械判定。実機 Safari / Chrome の確認は RELEASE_CHECKLIST.md に残す。
