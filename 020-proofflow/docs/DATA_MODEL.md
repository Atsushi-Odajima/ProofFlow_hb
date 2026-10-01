# DATA_MODEL.md — データモデル

DDL の正本は `packages/server/src/db/schema.ts`（migration `0001_init`、SQLite / PostgreSQL 共通）。ID はアプリ生成 ULID（時系列ソート可能）、boolean は INTEGER 0/1、時刻は ISO-8601 UTC TEXT、構造化データは `*_json` TEXT。

## テナント境界
`organizations` が tenant。tenant 配下の全テーブルは `org_id` を持ち、複合インデックスは `org_id` 先頭（例: `ix_runs_project_created(org_id, project_id, created_at)`）。API は `requireOrg` / `requireProject` で org を解決し、他 org の ID は 404 を返す。

```
organizations ─┬─ users (org_members: role)      api_tokens / invitations / runners / notification_channels
               ├─ workspaces ─ projects ─┬─ environments ─ secrets(環境別上書き) / domain_verifications / crawl_inventory
               │                         ├─ requirements ─ acceptance_criteria
               │                         │        └─ scenario_requirements ─ scenarios ─ scenario_versions
               │                         ├─ suites ─ suite_scenarios
               │                         ├─ test_data_profiles / fixtures / openapi_specs / test_impact_rules / ci_integrations
               │                         ├─ release_candidates ─ gate_evaluations / accepted_risks / evidence_reports
               │                         ├─ test_runs ─ run_jobs ─ test_results ─ result_attempts
               │                         │                        └─ artifacts（metadata; 実体は ArtifactStore）
               │                         ├─ visual_baselines / visual_comparisons / baseline_history / performance_baselines
               │                         ├─ failure_groups ─ defects ─ defect_links / defect_history
               │                         ├─ manual_cases ─ manual_case_requirements / manual_check_results / exploratory_sessions
               │                         └─ schedules
               ├─ notifications / notification_deliveries / ai_suggestions / ai_invocations / usage_counters / backups
               └─ audit_logs
```

## 主要エンティティ
| テーブル | 役割 | 重要な列 / 制約 |
|---|---|---|
| `users` | 人。email UNIQUE、scrypt hash | グローバル（複数 org に所属可） |
| `org_members` | org × user の role | PK (org_id, user_id)。role は owner/admin/qa_lead/tester/developer/viewer |
| `api_tokens` | personal / service / runner / mcp token | `token_hash`（sha256）のみ保存、`project_ids_json` で service token を Project 限定 |
| `projects` | Project | (org_id, slug) 一意、`seq_counters_json` で REQ-/SC-/DEF- 連番 |
| `environments` | Environment | `kind` local/preview/staging/production、`destructive_policy`、`auth_profile_json`、`allow_private_network`、mask / ignore パターン |
| `secrets` | Vault | `ciphertext`（AES-256-GCM `v1.k1.<iv>.<tag>.<ct>`）、`environment_id` NULL = Project 共通 |
| `requirements` / `acceptance_criteria` | 要件と受入基準（GWT / text） | priority p0–p3、status draft→approved→implemented→verified |
| `scenarios` / `scenario_versions` | typed step の JSON と版 | `steps_json`、`expected`、`destructive`、`origin`（manual/ai_draft/import/crawl）。更新で version +1 |
| `suites` / `suite_scenarios` | Suite（matrix 付き） | `matrix_json`（browsers / viewports / retries / video / trace）、`required_for_release` |
| `test_runs` | Run | `status` queued→running→passed/failed/flaky/infra_error/cancelled、`counts_json`、`browser_versions_json`、`idempotency_key` UNIQUE(org_id)、`release_candidate_id`、`parent_run_id`、`retest_defect_id` |
| `run_jobs` | Queue（scenario × browser × viewport） | `status` queued/leased/done/failed、`lease_until`、`attempt` / `max_attempts`、`ix_jobs_queue(status, priority, available_at)` |
| `test_results` | 結果（job ごと） | `status` + `outcome_detail`（passed_first_try / passed_after_retry / failed_after_retries …）、`failure_json`、`fingerprint`、`steps_json`、`checks_json`、`metrics_json` |
| `result_attempts` | 試行ごとの記録 | retry の証跡（flaky 判定の根拠） |
| `artifacts` | 証跡メタデータ | `kind` screenshot/video/trace/dom/console/network/diff/report/har…、`storage_key`、`sha256`、`restricted`、`retention_class`、`expires_at`、`ix_artifacts_expiry` |
| `visual_baselines` / `visual_comparisons` / `baseline_history` | Visual regression | baseline は (project, scenario, step_key, browser, viewport_key) で一意。比較 status new_baseline_needed/match/diff/approved/rejected。履歴に actor / reason / from→to |
| `failure_groups` | fingerprint ごとの集約 | (project_id, fingerprint) UNIQUE、`occurrence_count`、`defect_id` |
| `defects` / `defect_links` / `defect_history` | 不具合 | status new→open→in_progress→ready_for_retest→verified/reopened→closed、links（result / scenario / requirement / failure_group / run） |
| `release_candidates` / `gate_evaluations` / `accepted_risks` / `evidence_reports` | RC と Gate | `gate_rules_json`、評価結果 READY / BLOCKED / READY_WITH_ACCEPTED_RISK、risk は approver_user_id 必須、report は artifact + checksum |
| `manual_cases` / `manual_check_results` / `exploratory_sessions` | 手動テスト | device / os_version / browser / tester / artifact_ids |
| `schedules` | cron | `timezone`、`overlap_policy` skip/queue、`next_run_at` |
| `notifications` / `notification_channels` / `notification_deliveries` | 通知 | `dedupe_key` + `ix_notifications_dedupe` で嵐抑制 |
| `ai_suggestions` / `ai_invocations` | AI 提案と使用量 | suggestion は status pending/applied/rejected、`applied_by`。invocation に tokens / redaction 回数 |
| `audit_logs` | 監査 | actor_kind/actor_id/action/target/before_json/after_json/ip。secret / artifact 本文は入れない |
| `usage_counters` | 月次使用量 | PK (org_id, period, metric) |
| `backups` | バックアップ記録 | schema_version / app_version / checksum / restored_at |

## 規模設計（負荷目標の意識、保証値ではない）
- 全 tenant テーブルの主要クエリは `org_id`（＋ project_id）先頭の複合インデックスで絞る。Run 一覧は `(org_id, project_id, created_at)`、結果集約は `(org_id, project_id, status, created_at)`、fingerprint 検索は `(org_id, fingerprint)`。
- ID は ULID なので `ORDER BY id DESC` が時系列降順になり、カーソルページング（`id < ?`）が追加インデックスなしで効く。
- Artifact 本体は DB に置かない（ArtifactStore。初版はローカル FS、S3 互換は interface のみ）。
- Queue は DB テーブル。PostgreSQL では `FOR UPDATE SKIP LOCKED` 相当のロックで複数 control plane を許容する設計（本検証は単一インスタンス）。
- 実測（4 vCPU、SQLite ファイル、10,000 Run）: run 作成 p95 1.8 ms、dashboard p95 30 ms、run 一覧 p95 2.2 ms（docs/load-results-sqlite.json、TEST_REPORT.md）。1 億 Result 規模は未計測であり広告しない。

## 変更手順
1. `schema.ts` に migration を追加（`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` のみ。両方言で動く DDL）。
2. `SCHEMA_VERSION` を上げる。古い backup の復元可否（`schemaVersion <= SCHEMA_VERSION`）を確認。
3. `services/backup.ts` の `TABLES` に追加（FK 順）。
4. `tests/phase11` と該当 phase のテストを更新。
