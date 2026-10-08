# ProofFlow — Web サイト・アプリ品質検証／受入テスト基盤（商品 #020）

公開前に、壊れているところを全部見つける。実ブラウザ（Playwright）で動かした結果・assertion・証跡（screenshot / video / trace / console / network）を中心に、Defect → 修正 → 再テスト → Release Gate → Evidence Report までを 1 本の流れで扱う自己ホスト型の基盤です。AI は提案（下書き・要約）だけを行い、結果・baseline・期待値を書き換えず、リリースを承認しません。

- 購入者向け: `docs/buyer/はじめに.txt` → `5分で最初のテスト.txt`（利用者・テスターからの不具合報告は `不具合報告を受け付ける.txt`）
- 開発者向け: `docs/DEVELOPMENT.md`、設計は `docs/PLAN.md` / `docs/DECISIONS.md` / `docs/DATA_MODEL.md` ほか
- 状態: `docs/PROGRESS.md`、テスト結果: `docs/TEST_REPORT.md`、販売前確認: `docs/RELEASE_CHECKLIST.md`

## クイックスタート
```bash
pnpm install && npx playwright install chromium && pnpm build
pnpm dev:server          # http://127.0.0.1:8080 (API + Web UI)
pnpm dev:sample          # デモ対象 Sample SaaS http://127.0.0.1:4100
pnpm seed:sample         # デモ Project / Suite / RC 1.2.0（ログイン情報と runner token を表示）
PROOFFLOW_RUNNER_TOKEN=pfr_... PROOFFLOW_RUNNER_ALLOW_PRIVATE=1 pnpm dev:runner
```

## 構成
| パッケージ | 役割 |
|---|---|
| `packages/server` | control plane（Fastify、SQLite / PostgreSQL、queue、scheduler、Web UI 配信、backup / restore、seed） |
| `packages/runner` | runner plane（Playwright、evidence、redaction） |
| `packages/web` | React PWA |
| `packages/cli` | `proofflow run / status / gate / retest / impact / export / import / report` |
| `packages/mcp` | ChatGPT / Codex / Claude Code 向け MCP server（12 tools） |
| `packages/shared` | schema / RBAC / step 定義 / URL policy / redaction |
| `packages/sample-saas` | 意図的バグ入りデモ対象 |
| `tests` | phase1〜11、bugreport（ProofFlow 不具合報告）、e2e、ui、load |
| `deploy` | Dockerfile / docker-compose / GitHub Actions 例 |

## テスト
```bash
pnpm typecheck && pnpm test            # 単体〜統合（Chromium）
pnpm test:pg                           # PostgreSQL 16 で同じテスト
pnpm test:e2e                          # E2E-1 … E2E-10
pnpm build:web && pnpm test:ui         # PC / iPhone / Android の UI 検証（docs/ui-verification/）
pnpm test:load                         # 負荷計測（docs/load-results-*.json）
```
