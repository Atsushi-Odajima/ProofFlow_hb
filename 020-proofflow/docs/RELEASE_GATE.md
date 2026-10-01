# RELEASE_GATE.md — Release Candidate / Gate / Accepted Risk / Evidence Report

## Release Candidate (RC)
`POST /api/v1/projects/:id/releases` — version、commit SHA、build ID、environment、included changes、required suites（省略時は `requiredForRelease=true` の Suite）、required manual checks（label 配列）、gate rules（省略時は既定ルール）。
Run は `releaseCandidateId` を付けて作成すると RC に紐付く（UI / CLI `proofflow run --release 1.2.0` / MCP）。

## Gate rules（決定論的。入力は DB 上の実結果のみ。AI は入力にならない）
| rule | 判定 |
|---|---|
| `suite_pass_rate {suiteId, minRate=1, treatFlakyAsFail=true}` | RC に紐付く当該 Suite の **最新完了 Run** の pass 率。Run が無ければ BLOCK。flaky は既定で失敗扱い。infra_error は常に失敗扱い |
| `open_defects_max {severity, max=0, allowAcceptedRisk}` | project 内の open（new/triaged/in_progress/ready_for_retest/reopened）defect 数。`allowAcceptedRisk=true` の時だけ Accepted Risk 済み defect を除外（critical は既定で除外不可） |
| `visual_approved` | RC の Run に属する visual comparison に `diff` / `new_baseline_needed` が残っていれば BLOCK |
| `manual_check_required {label, device?, category?}` | RC に紐付く Manual Check の最新結果が `pass` でなければ BLOCK（未実施も BLOCK） |
| `accessibility_max {impact, max=0}` | RC の Run の axe 結果の合計 |
| `no_infra_errors` | RC の Run に infra_error があれば BLOCK（再実行を促す） |

既定ルール: 必須 Suite ごとに 100%、critical open 0（risk 不可）、high open 0（risk 可）、visual approved、manual check（指定分）、a11y critical 0、infra error 0。

## 結果
- `READY` — 全ルール pass、Accepted Risk 非使用
- `READY_WITH_ACCEPTED_RISK` — 全ルール pass、ただし Accepted Risk により通過したルールあり
- `BLOCKED` — 1 つ以上失敗

評価のたびに `gate_evaluations` に rules / evidence / evaluator を保存。RC の status は draft → blocked / ready / ready_with_accepted_risk → released。

## Accepted Risk
`POST .../accepted-risks { defectId, reason, reviewDate(ISO), impact }`。承認者は **人間のユーザー**（session または personal token）。service token / runner / system / AI は不可（403）。`release:accept_risk` 権限（QA Lead 以上）。履歴は audit に残る。revoke 可。

## Release 判断
`POST .../release` は `release:approve` 権限の **人間** のみ。直前に gate を再評価し、BLOCKED なら 409。released 後は RC 不変（gate rule 変更不可）、Run artifact の retention は `release_evidence` に延長。

## Evidence Report
`POST .../report { format: html | pdf }` → artifact（retention `release_evidence`）+ `evidence_reports`（summary / checksum）。内容: Project、Version、Environment、Run date、Browser matrix、Passed/Failed、Defects、Visual evidence、Manual device checks、Accepted risks、Approver、Gate 結果。
冒頭に「テスト実行結果の記録であり、品質保証証明書・認証・保証書ではない」旨を明記。PDF は Playwright（Chromium）が control plane で利用可能な場合のみ（無ければ 400 `pdf_unavailable`、HTML を使う）。

## Dashboard
`GET /api/v1/projects/:id/dashboard` — Today（runs / failed / flaky / new defects / ready for retest / blocked releases）、Quality（critical requirement coverage、browser coverage 30d、mobile checks、visual pending、a11y findings、open defects by severity）。**単一の AI スコアは出さない**。
