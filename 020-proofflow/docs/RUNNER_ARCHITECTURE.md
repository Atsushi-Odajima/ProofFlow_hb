# RUNNER_ARCHITECTURE.md — Control Plane / Runner Plane 分離

## 全体像
```
 Web UI / CLI / MCP / CI ──HTTPS──▶ Control Plane (packages/server)
                                      ├─ DB (SQLite 既定 / PostgreSQL)
                                      ├─ Artifact store (local FS / S3 互換 adapter 予定)
                                      ├─ Secret Vault (AES-256-GCM)
                                      ├─ Queue (run_jobs テーブル, lease / visibility timeout)
                                      └─ Realtime (SSE: /api/v1/runs/:id/events)
                                           ▲ runner token (Bearer pfr_…)
 Runner Plane (packages/runner) ───────────┘  /runner/v1/{register,lease,heartbeat,artifacts,complete,fail}
   ├─ BrowserPool (Chromium / Firefox / WebKit, headless)
   ├─ JobExecutor: attempt loop (retries) → evidence → upload
   ├─ Step engine (typed steps only, no arbitrary JS)
   └─ Checks: visual (pixelmatch) / responsive / axe / links / perf / schema (ajv)
```

## プロトコル（runner token 必須、Organization 単位に束縛）
| Endpoint | 役割 |
|---|---|
| `POST /runner/v1/register` | runner 登録。capabilities（browsers, concurrency, playwright version）、`allowPrivateNetwork` |
| `POST /runner/v1/lease` | `browsers` に合う `queued` job を `max` 件まで lease（priority DESC, created ASC）。応答は **job payload**（scenario steps、環境、必要な secret 値のみ、fixture/baseline の署名 URL、options） |
| `POST /runner/v1/jobs/:id/heartbeat` | lease 延長（180s）と進捗。`cancelled: true` で runner は中断 |
| `PUT /runner/v1/jobs/:id/artifacts?kind=&label=&stepIndex=&attempt=` | evidence の streaming upload（octet-stream）。初期 retention class は `failed`、complete 時に outcome に応じて `passed` / `failed` へ |
| `POST /runner/v1/jobs/:id/complete` | result（status / outcome_detail / failure / steps / summaries / checks / attempts）を確定。fingerprint はサーバー側で計算 |
| `POST /runner/v1/jobs/:id/fail` | **インフラ障害**（ブラウザ起動失敗等）。`max_attempts` まで再キュー、超過で `infra_error` |

Lease 失効（runner クラッシュ）は control plane の sweeper（30s）が検知し再キュー → 上限超過で `infra_error`。test failure と runner error は status も失敗分類も別。

## Job payload の最小権限
- Secret は scenario steps と auth profile が参照する名前のみ解決して渡す。runner は値をメモリ保持し、evidence へ書く前に `Redactor` で文字列置換する。
- Fixture / baseline は短命署名 URL。runner は DB・Vault に直接アクセスしない。
- `allowPrivateNetwork` は Environment（kind=local のみ設定可）と runner の両方が true の時だけ有効。それ以外は payload 生成時に target policy で拒否。

## 実行モデル
1. `BrowserPool.get(browser)` — プロセス内で engine ごとに 1 ブラウザを再利用。起動失敗は `InfraError`。
2. attempt ごとに新しい `BrowserContext`（viewport / device descriptor / isMobile(Firefox 除く) / hasTouch / baseURL / auth profile）。
3. `context.tracing.start({screenshots, snapshots})`、video は policy が off でなければ録画開始（Playwright は事後録画できないため、失敗時のみ保持したい場合も録画し、成功時に削除）。
4. steps を順に実行。失敗で停止し残りは `skipped`。
5. 失敗時 evidence: full-page screenshot（mask selectors 適用）、DOM snapshot（PII 置換）、trace.zip（**post-process で secret/header redaction**）、video、console/network NDJSON。
6. retries > 0 なら再試行。最終 status: passed / flaky（passed_after_retry）/ failed。
7. `complete` 送信。

## タイムアウト
- step: 15s 既定（step の `timeoutMs` で上書き、navigate は最低 30s）
- job: 10 分
- lease: 180s（heartbeat 30s）

## セキュリティ境界
- runner は typed step のみ解釈する。`page.evaluate` を使うのは ProofFlow 自身の固定スクリプト（responsive / crawl / perf）だけで、利用者入力をコードとして評価しない。
- ダウンロードしたファイルは artifact として保存するだけで実行しない。fixture は実行ファイル拡張子 / MIME を拒否。
- Runner はコンテナ / 専用ユーザーで動かすこと（deploy/ の Dockerfile.runner 参照、Phase 12）。

## 既知の制約
- Firefox / WebKit は本開発環境にブラウザ本体が無く未検証（コードパスのみ、`isMobile` は Firefox 非対応）。
- WebKit emulation は iPhone 実機ではない（Manual Device Check で補完）。
- Video / trace 内のスクリーンショットは文字列マスクできない（mask selectors、password 型 input の利用を推奨。ARTIFACT_SECURITY.md）。
