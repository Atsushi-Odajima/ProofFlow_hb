# PROGRESS.md — 進捗（正）

更新: 2026-10-01（Phase 12 完了時点）

| Phase | 状態 | 検証 |
|---|---|---|
| 0 公式調査 / PoC / 技術構成 | 完了 | SOURCE_NOTES.md（遮断環境のため GitHub 上の公式ソース・npm を一次情報とした） |
| 1 Org/Workspace/Project/Env/RBAC/Secret | 完了 | tests/phase1（必須 1, 2, 3, 4, 38） |
| 2 Requirement/Scenario/Suite/AI Draft | 完了 | tests/phase2（必須 33 AI OFF、AI draft は mock provider） |
| 3 Runner / Browser matrix / Evidence / Trace / Realtime | 完了 | tests/phase3（必須 3, 4, 5, 6, 7, 19）。Chromium 141 のみ実行 |
| 4 Console / Network / Form / File / API | 完了 | tests/phase4（必須 8, 9, 15, 16, 17, 18） |
| 5 Visual / Responsive / A11y / Link / Crawl | 完了 | tests/phase5（必須 10, 11, 12, 13, 14） |
| 6 Failure fingerprint / Defect / Retest / Reopen / Flaky | 完了 | tests/phase6（必須 19, 20, 21, 22, 23, 31, 32） |
| 7 RC / Release Gate / Accepted Risk / Evidence Report | 完了 | tests/phase7（必須 24, 25, 26, 27） |
| 8 CLI / CI / MCP Plugin / AI coding 連携 / Test impact | 完了 | tests/phase8（必須 35、CLI exit codes、MCP stdio + HTTP） |
| 9 Manual device / Exploratory / Scheduling / Notifications | 完了 | tests/phase9（必須 36） |
| 10 Security / Domain verification / Privacy / Retention / Audit | 完了 | tests/phase10（必須 28, 29, 30, 37, 38） |
| 11 Backup/Restore / 負荷計測 / PC・iPhone・Android 検証 | 完了 | tests/phase11（必須 34、E2E-10）、tests/load（docs/load-results-sqlite.json）、tests/ui（docs/ui-verification/ 57 画面）。SQLite と PostgreSQL 16 の両方で phase1〜11 通過 |
| 12 docs / deploy / 販売前 check | 完了 | 開発資料 19 件、購入者資料 15 件、deploy/（Dockerfile ×2、docker-compose、GitHub Actions）、RELEASE_CHECKLIST.md。Docker build・実 AI API・ChatGPT connector・Firefox/WebKit・実機は人間確認待ち |

E2E-1〜10: tests/e2e/e2e.test.ts（結果は TEST_REPORT.md）。

## 実装済み機能（完成条件 1〜30 との対応）
1. Multi-tenant / RBAC — Organization 単位の tenant、6 role、全 API handler で authorize、クロステナント 404
2. Project / Environment / Secret — kind 別ポリシー、production destructive 既定 deny、AES-256-GCM Vault、`{{secret:NAME}}` 参照
3. Requirement / Acceptance Criteria — GWT / text、traceability API
4. Scenario / No-code / AI Draft — 28 種の typed step、版管理、AI draft は提案 → 人が適用
5. Browser runner — control / runner plane 分離、lease / heartbeat / visibility timeout、in-process でも別ホストでも動作
6. Chromium / Firefox / WebKit — matrix と runner capability 交渉は 3 ブラウザ対応。**実行検証は Chromium のみ**
7. Screenshot / Video / Trace — 失敗時既定、trace.zip は redaction 後に再パック
8. Console / Network evidence — 常時収集、assert で失敗化、ignore パターン
9. Visual Regression — pixelmatch、承認制 baseline、履歴、一括承認の確認
10. Responsive checks — overflow / CTA offscreen / tiny text / fixed overlap、evidence 付き
11. Accessibility — axe-core（WCAG 2.0 A/AA tag）、impact 別集計、Gate rule
12. Link / Form / Upload / Download — 同一オリジン link check、二重送信・必須チェック、fixture upload、ファイル名 / MIME
13. API test / contract — api_request（status / JSON schema / JSONPath / latency）、OpenAPI import と breaking 候補
14. Flaky detection — passed_after_retry を Passed に隠さない、flaky 候補一覧
15. Failure grouping — fingerprint（type / step / url / message 正規化）
16. Defect / Retest / Reopen — 状態遷移、再テスト run、同一 fingerprint 再発で Reopened
17. Manual Device Check — 手動ケース、結果（端末 / OS / ブラウザ / 証跡）、チェックリスト、探索セッション
18. Release Candidate / Gate — 7 種の決定論的ルール、READY / BLOCKED / READY_WITH_ACCEPTED_RISK、Suite ごとの最新 run
19. Accepted Risk — defect + reason + approver（人）+ review date + impact
20. Evidence Report / Traceability — HTML（PDF は Playwright がある場合）、checksum、免責文
21. Git / CI / CLI — proofflow run/status/gate/retest/impact/export/import/report、exit code、GitHub Actions 例
22. ChatGPT / Codex MCP Plugin — 11 tools、stdio / Streamable HTTP、Project 制限、destructive 拒否
23. AI Failure / Defect / Selector assist — 提案のみ、結果不変、適用は人（必須 31, 32）
24. Domain verification / abuse prevention — dns_txt / html_token / well_known / manual、低負荷モード
25. Artifact privacy / security — 署名 URL（15 分）、restricted、redaction、retention、SSRF policy
26. Audit — RBAC / Secret / Environment / Scenario / Baseline / Gate rule / Accepted Risk / Defect close / Export / Runner / Backup
27. Backup / Restore — JSON（schemaVersion / appVersion / checksum）、空環境復元 CLI、復元後 traceability 一致
28. Required E2E / security / load tests — 必須テスト 1〜38、E2E-1〜10、負荷計測
29. PC / iPhone / Android workflows — Web UI を 3 viewport で検証（エミュレーション）、Mobile suite、手動実機記録
30. 購入者資料 / 運用費 — docs/buyer 15 件、OPERATING_COSTS.md

## 未検証 / 既知の制約（正直に）
- Firefox / WebKit: ブラウザ本体を取得できず未実行（コードパスのみ）。
- iPhone / Android 実機: 未実施（Chromium のデバイスエミュレーションのみ）。
- OpenAI / Anthropic 実 API: 未呼び出し（型検査 + mock）。ChatGPT connector 接続: 未確認。
- Docker image build: 未実行（レジストリ到達不可）。
- S3 互換ストレージ: interface のみ。Email adapter: stub。OAuth 2.1（MCP）: 未同梱。
- 負荷: 単一ノード・SQLite / PostgreSQL で 10,000 Run まで計測。1 億 Result 規模は未計測。
