# AI_ASSISTANCE.md — AI plane の役割と境界

## 原則
1. AI は **提案（suggestion）** を作るだけ。test result / baseline / Expected / gate を書き換える API 経路は存在しない。
2. 全ての AI 出力は zod スキーマで検証してから保存（不正出力は 502 `ai_invalid_output`）。
3. `PROOFFLOW_AI_PROVIDER=none`（既定）または Organization 設定 `ai.enabled=false`（既定）の場合、provider への HTTP 呼び出しは一切発生しない（テストで呼び出し回数 0 を検証）。
4. Artifact 抜粋は `ai.sendArtifacts=true` かつ非 restricted のものだけ、redaction 済みで送る。
5. 「適用（apply）」は人間の明示操作 + 権限（`ai:apply` = QA Lead 以上）+ audit。適用後も再実行が必要で、失敗 result は失敗のまま。

## 機能
| feature | 入力 | 出力 | apply |
|---|---|---|---|
| scenario_draft | 依頼文、Requirement + AC、target URL | 複数 draft（steps / expected / expectedSource / priority / tags）+ gaps | draft scenario（status=draft, origin=ai_draft）作成。`expectedSource=unspecified` の Expected は null のまま（勝手に決めない） |
| failure_summary | failure / steps / summaries / 抜粋 | 何が失敗 / step / browser / request / 再現ヒント / root cause（confirmed / evidence_suggests / possible / unknown） | なし（閲覧のみ） |
| defect_draft | 同上 + scenario expected | title / severity / priority / reproduction / expected / actual | 通常の defect 作成経路（`fromAiSuggestionId` 記録） |
| selector_repair | 失敗 step の target、DOM 抜粋 | locator 候補（confidence / reason） | scenario の step target を更新（新 version、changeReason に suggestion id とレビュー者）。result は不変、rerun 必須 |
| test_gap | requirements / scenarios / inventory | gap 候補 | なし（候補のみ。gate の必須 suite を省略しない） |
| exploratory_notes | charter / notes | summary / findings / candidate defects | なし |

## Provider
- `anthropic`: 公式 SDK `@anthropic-ai/sdk`、既定 model `claude-opus-5-5`、構造化出力（`output_config.format` JSON schema）、server-side refusal fallbacks（`fallbacks: "default"`）。
- `openai`: 公式 SDK `openai`、Responses API + JSON schema text format、既定 model は `PROOFFLOW_AI_MODEL` で指定（公式 docs で現行 model 名を確認）。
- `mock`: テスト / デモ用の決定論的 provider。
- **注意**: anthropic / openai provider は型検査済みだが、本開発環境では API キー無し・課金なしのため **実 API に対して未検証**。販売前に人間が実キーで 1 回ずつ確認すること（RELEASE_CHECKLIST.md）。

## コスト記録
`ai_invocations`（feature / provider / model / tokens / duration / status / restricted_excluded / artifacts_redacted）。`GET /api/v1/orgs/:id/ai/usage`。OPERATING_COSTS.md に試算。

## 制約
- AI は Release 承認者・baseline 承認者になれない（人間のみ、API で強制）。
- Root cause は証拠に基づく confidence を必ず付ける。「たぶん大丈夫」は出力形式に存在しない。
