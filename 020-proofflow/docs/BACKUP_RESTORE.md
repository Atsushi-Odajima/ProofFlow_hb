# BACKUP_RESTORE.md — バックアップと復元

## 何をバックアップするか（3 層）
| 層 | 内容 | 方法 | 頻度の目安 |
|---|---|---|---|
| 1. メタデータ | Organization / Project / Environment / Secret（暗号化済み）/ Requirement / Scenario / Suite / Run・Result・Artifact の**メタデータ** / Visual baseline・比較 / Defect / ProofFlow 不具合報告（bug_reports・bug_report_intakes・bug_report_attachments、マスク済み）/ Release Candidate / Gate 評価 / Accepted Risk / Manual check / Exploratory / Schedule / Notification / AI suggestion / Audit log | `GET /api/v1/orgs/:orgId/backup`（JSON、Owner/Admin、監査記録あり）。UI: 設定 → バックアップ | 毎日（cron） |
| 2. Artifact 実体 | screenshot / video / trace / DOM / console / network / diff / report / fixture のファイル本体 | `PROOFFLOW_DATA_DIR/artifacts` と `PROOFFLOW_DATA_DIR/fixtures` をファイルシステム / オブジェクトストレージ側でバックアップ（rsync、スナップショット、S3 バージョニング等） | 毎日（増分） |
| 3. 鍵 | `PROOFFLOW_MASTER_KEY`（Secret Vault）、`PROOFFLOW_SIGNING_SECRET`（署名 URL / cookie） | シークレットマネージャ等に別保管。**鍵がないと Secret は復号できない** | 変更時 |

巨大になりやすいのは 2 層目（video / trace）。メタデータ JSON と分離しているのは、1 層目を小さく頻繁に、2 層目をストレージ機能で安価に取るためです。保持期間（`PROOFFLOW_RETENTION_*`）で 2 層目の総量を制御します（ARTIFACT_SECURITY.md）。

## バックアップ JSON の形式
```json
{
  "format": "proofflow-backup",
  "schemaVersion": 2,
  "appVersion": "0.1.0",
  "exportedAt": "2026-10-01T12:00:00.000Z",
  "organization": { "id": "...", "slug": "...", "name": "..." },
  "counts": { "projects": 1, "test_runs": 12, "...": 0 },
  "checksum": "<sha256 of the canonical tables payload>",
  "excludes": ["artifact binaries (PROOFFLOW_DATA_DIR/artifacts, /fixtures)", "login sessions", "global retention jobs"],
  "tables": { "organizations": [...], "users": [...], "...": [...] }
}
```
- `schemaVersion` は DB スキーマの版（`SCHEMA_VERSION`）。サーバーより新しい版の JSON は復元を拒否します（先にサーバーを更新）。
- `checksum` はテーブル payload の正規化 JSON（テーブル順固定・キー順ソート）に対する SHA-256。1 バイトでも改変されると `checksum mismatch` で拒否されます。
- `users` は組織メンバーのみ（パスワードハッシュを含む）。`api_tokens` はハッシュのみ（トークン本文は含まれない）。`sessions` は含みません。
- `secrets.ciphertext` は AES-256-GCM の暗号文のまま。平文は JSON のどこにも現れません（tests/phase11 で検証）。
- 取得は `backup.export` として監査ログに記録され、`backups` テーブルに checksum / サイズが残ります。

バックアップ JSON 自体が機密（パスワードハッシュ・暗号化 Secret・テスト履歴）です。暗号化ストレージに保存し、アクセスを制限してください。

## 復元（空の環境へ）
復元は **CLI のみ**（API からは実行できません）。復元先は「同じ Organization / 同じユーザーが存在しない」空の環境である必要があります。既存テナントへのマージ、他テナントへの影響はありません。

```bash
# 1. 新しいサーバーに同じ鍵を設定する（必須: PROOFFLOW_MASTER_KEY、推奨: PROOFFLOW_SIGNING_SECRET）
export PROOFFLOW_DATA_DIR=/var/lib/proofflow PROOFFLOW_MASTER_KEY=... PROOFFLOW_SIGNING_SECRET=...
# 2. 検証のみ（DB には書き込まない）
node packages/server/dist/restore.js backup.json --dry-run
# 3. 復元（migration は自動適用）
node packages/server/dist/restore.js backup.json
# 4. Artifact 実体をストレージバックアップから同じ場所へ戻す
rsync -a backup/artifacts/ $PROOFFLOW_DATA_DIR/artifacts/
rsync -a backup/fixtures/  $PROOFFLOW_DATA_DIR/fixtures/
# 5. サーバーを起動し、元のアカウント / パスワードでログインできること、Run 詳細から証跡が開けることを確認
```
終了コード: 0 成功 / 1 ファイル破損・形式不正 / 4 引数不正 / 5 復元先が空でない。

復元後は監査ログ末尾に `backup.restore`（元の `exportedAt` / checksum 付き）が 1 件追加されます。

### 復元前に API で検証する
`POST /api/v1/orgs/:orgId/backup/verify`（Owner/Admin）に JSON を送ると、構造・checksum を検証し、「この環境に復元可能か（conflicts）」を返します。復元は行いません。

## 検証済みの保証（tests/phase11/backup-restore.test.ts）
- Requirement → Scenario → Run / Result → Defect → Release Candidate / Gate 評価 / Manual check の traceability が復元前後で完全一致（必須テスト 34 / E2E-10）。
- 同じメール / パスワードでログイン可能、Secret は同じ master key で復号可能、Artifact ディレクトリを戻せば証跡ダウンロード可能、Gate を再評価しても同じ判定。
- 改変 JSON は checksum で拒否、2 回目の復元は「空でない」として拒否、Developer 以下は export 不可。
- SQLite / PostgreSQL 16 の両方で通過。

## スキーマ版
- schemaVersion 2（migration `0002_bug_reports`）。schemaVersion 1 の backup も復元可能（不具合報告テーブルが無いだけ）。

## 既知の制約
- JSON は一括生成（1 Organization あたり数十万 Run 規模まで想定。それ以上は PostgreSQL の `pg_dump` 併用を推奨）。
- 復元先 DB 方言は問いません（SQLite → PostgreSQL も可）が、`BIGINT` 列は文字列として JSON 化される場合があり、復元時に数値へ変換されます。
- 復元は「空の環境」限定。部分復元（Project 単位）は Pro 候補。Project 定義だけなら `proofflow export/import`（definitions）を使ってください。
