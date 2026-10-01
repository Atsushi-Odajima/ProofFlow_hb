# OPERATIONS.md — 運用

## プロセス構成
| プロセス | コマンド | 役割 |
|---|---|---|
| control plane | `pnpm --filter @proofflow/server start`（`node packages/server/dist/main.js`） | API / UI 配信 / queue / scheduler / retention / SSE |
| runner | `pnpm --filter @proofflow/runner start` | Playwright 実行（`PROOFFLOW_RUNNER_TOKEN` 必須、複数台可） |
| mcp（任意） | `pnpm --filter @proofflow/mcp start -- --http` | ChatGPT 等向け HTTP endpoint |
| sample-saas（任意） | `pnpm --filter @proofflow/sample-saas start` | デモ対象 |

`deploy/docker-compose.yml`（control plane + PostgreSQL + runner、`deploy/Dockerfile.server` / `Dockerfile.runner`）参照。本開発環境ではレジストリに到達できず image build は未実行（RELEASE_CHECKLIST.md）。

## 環境変数
`.env.example` を参照。必須: `PROOFFLOW_MASTER_KEY`（32 bytes base64）、`PROOFFLOW_SIGNING_SECRET`、`PROOFFLOW_PUBLIC_URL`。未設定時は `data/` に自動生成（開発用）。

## バックグラウンド処理（control plane 内、`PROOFFLOW_SCHEDULER=0` で停止）
- lease sweeper（30s）: 失効 lease の再キュー / infra_error
- schedule tick（30s）: cron 発火（idempotent）
- retention（6h）: 期限切れ artifact 削除

## 監視ポイント
- `GET /api/v1/health`
- `GET /api/v1/orgs/:id/runners`（last_heartbeat_at、offline）
- `GET /api/v1/orgs/:id/storage`、`retention_jobs`
- `GET /api/v1/orgs/:id/notification-deliveries`（failed）
- `ai_invocations`（status=error）

## バックアップ
BACKUP_RESTORE.md: `GET /api/v1/orgs/:id/backup` で metadata JSON（schemaVersion / appVersion / checksum、Owner/Admin、監査あり）。復元は `node packages/server/dist/restore.js backup.json`（空環境のみ）。巨大 artifact（video / trace）は `PROOFFLOW_DATA_DIR/artifacts` のストレージをファイルシステム / オブジェクトストレージ側でバックアップする（別戦略）。

## 通知 adapter
- in-app: 常時。
- webhook: 任意 HTTPS endpoint（SSRF ポリシー適用）。
- slack: Incoming Webhook URL（`https://hooks.slack.com/...`）。
- email: 初版は未同梱（`EmailAdapter` を SMTP / SES 等で実装して `notify.register()`）。

## スケール
- SQLite は単一 control plane 向け。複数インスタンス / 大規模は PostgreSQL（`PROOFFLOW_DB_DRIVER=postgres`、`PROOFFLOW_DATABASE_URL`）。
- Runner は水平に増やせる（lease ベース）。1 runner あたり concurrency 2 を目安（OPERATING_COSTS.md）。
