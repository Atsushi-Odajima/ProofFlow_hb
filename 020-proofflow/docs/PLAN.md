# PLAN.md — ProofFlow 開発計画（商品 #020）

## 製品の一行定義
WebサイトやWebアプリを、公開前・修正後に自動で操作して、画面崩れや動作不良を **証拠付き** で見つける品質チェックツール。
AIが「たぶん大丈夫」と判断する製品ではない。実行結果・assertion・evidence が中心。

## 中心フロー
Project → Environment → Requirement/Acceptance Criteria → Test Scenario → AI Scenario Draft → Browser/Viewport Matrix → Test Run → 実ブラウザ操作 → Screenshot/Video/Trace/Console/Network → Assertion → Visual Comparison → Accessibility/API Check → Failure 分類 → Defect → 修正 → Retest → Regression → Release Gate → Evidence Report → Release 判断。

## 技術構成（決定: DECISIONS.md 参照）
- 言語: TypeScript (ESM, Node >= 22.13)。pnpm workspaces monorepo。
- Control Plane: `packages/server` — Fastify 5 REST API + SSE、DB（SQLite 既定 / PostgreSQL 任意）、DB-backed job queue、Artifact store（ローカル FS + 署名 URL）、Secret Vault、AI plane、scheduler、notifications、backup/restore、evidence report。
- Runner Plane: `packages/runner` — Playwright library API。Control plane から job を lease → 実ブラウザ実行 → evidence upload。Control plane とはトークン認証の HTTP のみ（DB 直結なし）。
- AI Plane: `packages/server/src/ai` — Scenario draft / Failure summary / Defect draft / Selector repair 候補 / Test gap 候補。**結果の書き換え不可**（read-only な提案を保存するのみ）。
- Web UI: `packages/web` — React + Vite の PWA（PC / iPhone / Android ブラウザ）。
- CLI: `packages/cli` — `proofflow run|status|gate|retest|export`。
- MCP Plugin: `packages/mcp` — ChatGPT / Codex / Claude Code 向け MCP server（stdio + Streamable HTTP）。REST API の client として実装。
- Sample: `packages/sample-saas` — バグを seed した「Sample SaaS」。

## Phase 計画と状態
| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 公式技術調査、Playwright/runner/Plugin PoC、cost 試算基盤 | 完了 |
| 1 | Organization/Workspace/Project/Environment/RBAC/Secret | 完了 |
| 2 | Requirement/Scenario/No-code/Suite/AI Draft | 完了 |
| 3 | Runner、Browser matrix、Evidence、Trace、Realtime | 完了 |
| 4 | Console/Network/Form/File/API | 完了 |
| 5 | Visual/Responsive/Accessibility/Link | 完了 |
| 6 | Failure grouping、Defect、Retest、Flaky | 完了 |
| 7 | RC、Release Gate、Accepted Risk、Evidence Report | 完了 |
| 8 | Git/CI/CLI/MCP Plugin/AI coding integration | 完了 |
| 9 | Manual Device/Exploratory/Scheduling/Notifications | 完了 |
| 10 | Security/domain verification/privacy/retention/audit | 完了 |
| 11 | Backup/Restore、load/concurrency、PC/iPhone/Android verification | 完了（Firefox/WebKit・実機は未検証: TEST_REPORT.md） |
| 12 | docs、deploy、販売前 check | 完了（Docker build / 実 AI API / ChatGPT connector は人間確認待ち: RELEASE_CHECKLIST.md） |

状態の正は PROGRESS.md。未完成 Phase があれば「全体完成」とは報告しない。

## 今回実装しない（契約どおり）
native iOS/Android アプリ完全自動操作、penetration test、DDoS/load attack、credential stuffing、第三者 site scraping、AI による release 自動承認、AI による baseline 無断更新、OS 全機種実機 farm 自前構築、複雑な mobile native automation、production payment 実決済、完全 WCAG 保証、品質保証認証。

## Pro 版候補（初版では広げない）
Browser/device farm、native mobile automation、private network self-hosted runner の高度化、GitHub/GitLab/Bitbucket 深い連携、Jira/Linear、Slack/Teams、advanced performance、synthetic monitoring、test data service、enterprise SSO/SCIM、advanced compliance evidence、S3 互換 object storage adapter の本番検証、MCP Apps UI。
