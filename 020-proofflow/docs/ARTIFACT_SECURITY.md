# ARTIFACT_SECURITY.md — Evidence の保護・privacy・retention

## Tenant 分離
- 全 artifact 行は `org_id` / `project_id` を持ち、storage key も `<org>/<project>/<run>/<id>`。
- 認証付き取得 `GET /api/v1/artifacts/:id/download` は `requireProject(..., 'artifact:read')` を通り、他 tenant からは 404。`restricted` は `artifact:read_restricted`（Tester 以上）が必要。
- 署名 URL `GET /artifacts/:id?exp&sig` は HMAC-SHA256(signing secret, id|exp)。既定 TTL 900 秒（`PROOFFLOW_ARTIFACT_URL_TTL_SEC`）。改ざん・期限切れは 403。runner の baseline / fixture 取得、レポート、UI プレビューに使用。

## Secret / PII redaction（runner 側で保存前に適用）
| evidence | 対策 |
|---|---|
| console / pageerror | secret 値の文字列置換 |
| network | URL の token/key/secret/password/auth/session/sig 系クエリをマスク、`authorization` / `cookie` / `set-cookie` / `x-api-key` / `x-auth-token` / `proxy-authorization` + 環境設定 `redactHeaders` を `[REDACTED]`、body は `captureBodies` opt-in 時のみ（10KB 上限、PII パターン置換） |
| DOM snapshot | secret 置換 + PII パターン（email / カード様数字 / JWT / API key 形式） |
| failure message / stack / steps | secret 置換 |
| trace.zip | `.trace` / `.network` / `.stacks` のテキストエントリと `resources/` を post-process で secret 置換、network header redaction。**trace 内のスクリーンショット画像はマスク不可** |
| screenshot | `maskSelectors`（環境 + step）で要素をマスク。password 型 input は元々表示されない |
| video | マスク不可。既定で失敗時のみ保持（`video: on_failure`） |

Secret 値は runner の lease 応答でのみ渡され、DB・audit・レポートには保存されない（Phase 1/3 テストで trace.zip 内まで検証）。

## Restricted artifact
`POST /api/v1/artifacts/:id/restrict { restricted }`（Tester 以上）。restricted は閲覧権限が上がり、**AI への送信対象から除外**（`ai_invocations.restricted_excluded` に件数記録）。

## AI への送信ポリシー
Organization 設定 `ai.enabled` と `ai.sendArtifacts` の両方が true の時だけ console / network / DOM の **抜粋**（redaction 済み、8–30KB）を送る。それ以外は結果 JSON（failure / summaries）のみ。Phase 6 テストで検証。

## Retention
| class | 既定 | 対象 |
|---|---|---|
| passed | 7 日 | 成功 result の screenshot / console / network |
| failed | 60 日 | 失敗 result の evidence（trace / video / DOM など） |
| release_evidence | 365 日 | Release 済み RC の Run、visual review に使った画像、defect に紐付いた evidence、Evidence Report |
| baseline | 無期限 | 承認済み visual baseline |
| manual | 365 日 | Manual check / exploratory の evidence |

`POST /api/v1/orgs/:id/retention/run` または scheduler が期限切れを soft-delete + storage 削除（batch 500）。`retention_jobs` に件数と解放バイト。**法務・コンプライアンス保管を保証する製品ではない**（必要なら Evidence Report と artifact を外部へエクスポートして保管する）。Storage 使用量は `GET /api/v1/orgs/:id/storage`。

## Object storage
初版はローカル FS（`PROOFFLOW_DATA_DIR/artifacts`）。`ArtifactStore` インターフェース（put / getStream / exists / stat / delete）を実装すれば S3 互換に差し替え可能（本環境で検証不可のため Pro 候補）。
