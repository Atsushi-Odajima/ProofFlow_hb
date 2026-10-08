# BUG_REPORT_INTAKE.md — ProofFlow 不具合報告 / ProofFlow 個人情報マスク

商品 #019 ErrorRelay（AIエラー報告アシスタント）の報告スキーマ・privacy scanner・レポート生成を ProofFlow に統合した機能。判断の記録は DECISIONS.md D-022。

## 流れ
```
報告者（Web 画面 / 外部受付フォーム / REST / MCP）
  ├─ PUT  …/attachments?fileName=   画像: EXIF・tEXt 等を除去 / テキスト: スキャン + マスク → artifacts（kind screenshot | attachment）+ bug_report_attachments（未使用）
  ├─ POST …/preview                  マスク後の内容・findings（原文なし）・ja/en Markdown・品質チェック・類似 Defect（内部のみ）
  └─ POST …/bug-reports              idempotencyKey → sanitizeReport → BR-n を挿入（status processing）→ 添付を確保 → Defect 作成（または既存 Defect に追加）
                                      → defect_links(bug_report, release_candidate) → status defect_created / attached_to_defect → audit bug_report.submit
```
失敗時は bug_reports 行を削除し添付の確保を戻すので、同じ key で再送できる。

## API
| メソッド / パス | 権限 | 内容 |
|---|---|---|
| `GET /api/v1/projects/:id/bug-reports` | defect:read | 一覧（defectKey 付き） |
| `POST /api/v1/projects/:id/bug-reports/preview` | defect:read | マスク後プレビュー + 類似 Defect |
| `PUT /api/v1/projects/:id/bug-reports/attachments?fileName=` | defect:write | 添付（PNG / JPEG / text/plain / text/csv / application/json、10 MB） |
| `POST /api/v1/projects/:id/bug-reports` | defect:write | 送信（201、同じ key の再送は 200 + `replayed: true`） |
| `GET /api/v1/projects/:id/bug-reports/:rid`、`…/report?lang=ja|en` | defect:read | 詳細、Markdown |
| `GET/POST /api/v1/projects/:id/bug-intakes`、`DELETE …/:iid` | defect:read / project:write | 外部受付フォームの一覧・作成（token は 1 回だけ表示）・無効化 |
| `GET /api/v1/intake/:iid`、`POST …/preview`、`PUT …/attachments`、`POST …/bug-reports` | header `x-proofflow-intake-token` | 外部受付（ログイン不要）。応答は受付番号のみ |

## ProofFlow 個人情報マスク（`packages/shared/src/bugreport/`）
- scanner.ts / redact.ts / exif.ts は ErrorRelay core の移植（SCANNER_VERSION 1.0.0）。検出: email, phone, api_key（sk- / ghp_ / github_pat_ / AKIA / xox* / AIza / sk-ant- / key=value）, access_token, jwt, session_token, password, otp, credit_card（Luhn）, account_id, file_path_username, ip_address, postal_address, person_name, url_with_token。
- placeholder は `[REDACTED_<CATEGORY>_<n>]`（部分マスクなし）。findings は API / DB に原文を持たない（field / category / severity / hint のみ）。
- `ALWAYS_REDACT`（api_key, access_token, session_token, jwt, password, otp, credit_card, url_with_token）は報告者が「残す」を選んでもマスク。
- 対象: 件名・説明・期待・実際・各手順・エラー文・報告者名・補足・環境値（発生ページ URL 等）・添付ファイル名・テキスト添付。保存直前に `containsAnyOriginal` で漏れを再検査。
- 画像の中身（顔・QR・会話・顧客データ・氏名）は検出しない → `IMAGE_MANUAL_CHECKLIST` を画面に表示。

## ブラウザで同じライブラリを使う
`@proofflow/shared/bugreport`（node:* を import しない）を Web が bundle し、送信前のマスク後プレビューをブラウザ内で計算する。サーバーは同じ関数を再適用する（表示と保存が一致し、API 直叩きでもマスクされる）。

## テスト
tests/bugreport/privacy.test.ts（ErrorRelay privacy.test の移植 + 報告全体のマスク）、report.test.ts（report / timestamp テストの移植）、intake.test.ts（統合: Defect 作成・証跡・冪等・権限・tenant・外部受付・上限・backup / restore）、mcp.test.ts。SQLite / PostgreSQL の両方で実行。
