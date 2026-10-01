# TEST_MODEL.md — Requirement / Scenario / Suite / Run / Result モデル

## 階層と traceability
```
Requirement (REQ-n) ──┬── Acceptance Criteria (Given/When/Then or text)
                      ├── Scenario (SCN-n, versioned)  ──▶ Suite (Smoke/Critical/Full/Visual/Accessibility/API/Mobile/Custom)
                      └── Manual Case (MC-n)                  │
                                                              ▼
Test Run (runId, env, matrix, commit/branch/PR/build) ──▶ Job (scenario × browser × viewport) ──▶ Result
        ──▶ Failure fingerprint ──▶ Failure group ──▶ Defect (DEF-n) ──▶ Retest run ──▶ Verified / Reopened
        ──▶ Release Candidate ──▶ Gate evaluation ──▶ Evidence Report
```
`GET /api/v1/projects/:id/requirements/:reqId/traceability` が Requirement → Scenario → 最新 Result → Defect → Manual Case を返す。

## Scenario
- `steps` は typed JSON（`@proofflow/shared` の `StepSchema`）。**任意 JavaScript step は存在しない**。
- `version` は steps / expected の変更で +1。`scenario_versions` に全履歴（誰が / 理由）。title のみの変更は version を上げない。
- `destructive` は api_request の非 GET などから自動判定（手動上書き可）。Production や policy=deny 環境では実行拒否。
- `origin`: manual / ai_draft / import / crawl。AI draft は `status=draft` で作成され Expected が仕様に無ければ null。

### Step 一覧
navigate, click, fill, select, check, press, hover, upload(fixture), download(expectFilename/expectMime), wait, assert_text, assert_url, assert_element, assert_value, assert_title, assert_no_horizontal_scroll, assert_console(maxErrors, ignorePatterns), assert_network(noStatusAtLeast, urlPattern, maxDurationMs), api_request(method, url, headers, body, expectStatus, expectSchema, expectJsonPath, maxLatencyMs, saveAs), screenshot(label, fullPage, visualCheck, maskSelectors, maxDiffRatio), responsive_check, accessibility_check(tags, failOn, disableRules), link_check, form_check(expectErrorOnEmpty, expectDoubleSubmitGuard), perf_check, set_viewport, login_profile, crawl_inventory。

値の参照: `{{secret:NAME}}`（Vault）、`{{data:KEY}}`（test data profile）、`{{var:NAME.path}}`（api_request の saveAs）。

## Run / Job / Result
- Run status: `queued → running → passed | failed | flaky | infra_error | cancelled`。優先順位 failed > infra_error > flaky > passed。
- Job は scenario × browser × viewport。`attempt / max_attempts`（インフラ再試行）。
- Result: `status` + `outcome_detail`（passed_first_try / passed_after_retry / failed_first_try / failed_after_retries / infra_error / not_run）。**passed_after_retry は status=flaky** として集計に出す。
- `failure_json`: type（assertion / navigation / timeout / locator_not_found / network / console / visual / responsive / accessibility / api_contract / api_status / link / form / upload / download / performance / script_error / infra / policy）、message、stepIndex、stepType、url、locator、status、ruleId、expected、actual。
- `fingerprint`: type + stepType + stepIndex + locator + ruleId + status + 正規化 message + path から sha256（先頭 24 文字）。
- `checks_json`: visual / responsive / accessibility / links / api / form / downloads / console / network / performance / crawl の構造化結果。
- `metrics_json`: TTFB / DOMContentLoaded / load / LCP / transfer bytes / resource count（粗い regression 用、負荷試験ではない）。

## Flaky
retry で pass したものは Passed に隠さず `flaky` と `passed_after_retry` で可視化する。Flaky 候補の一覧は failure_groups / 直近結果から算出（Phase 6）。

## Suite
kind（smoke / critical / full_regression / visual / accessibility / api / mobile / custom）、matrix（browsers × viewports、retries、video / trace policy）、`requiredForRelease`。
