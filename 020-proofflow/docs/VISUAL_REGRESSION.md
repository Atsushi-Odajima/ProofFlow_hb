# VISUAL_REGRESSION.md

## 仕組み
- `screenshot` step に `visualCheck: true` を付けると、runner が同一 scenario / step label / browser / viewport の **active baseline** を署名 URL で取得し、`pixelmatch`（threshold 0.2、`maxDiffRatio` 既定 0.1%）で比較する。
- 結果は `visual_comparisons`（status: `match` / `diff` / `new_baseline_needed` / `approved` / `rejected`）。`diff` は scenario failure（type `visual`）になり、Expected / Actual / Diff の 3 画像が artifact として残る。
- baseline が無い初回は失敗にせず `new_baseline_needed` として review 待ちになる。

## False positive 対策
- baseline は **同じ browser / viewport / 環境種別** でのみ比較する（キーに browser と viewport を含む）。OS・GPU・フォントの差で描画が変わるため、baseline は本番 runner と同じ環境（Docker 推奨）で作る（Playwright 公式の注意と同じ）。
- `animations: 'disabled'`、caret 非表示、`maskSelectors`（環境設定 + step 設定）で動的要素をマスク。
- 比較 threshold は step 単位で `maxDiffRatio` を調整可能。

## Baseline governance
- 承認は `baseline:update` 権限（QA Lead 以上）の **人間** のみ。`reason` 必須。11 件以上の一括承認は `confirmBulk=true` が必要。
- 更新は `visual_baselines`（旧 baseline は `superseded`）と `baseline_history`（誰が / いつ / なぜ / from → to / run / RC）に記録、audit にも残る。
- AI は baseline を更新できない（API 経路が無い）。AI coding agent 用 token も `baseline:update` を持つ role でなければ拒否される。
- Release Gate の `visual_approved` は未 review の diff が残っていれば BLOCKED。

## Responsive regression（heuristic + evidence）
`responsive_check` step: horizontal overflow、要素のはみ出し、CTA（button / link で登録・購入・開始系の文言）の画面外、tiny tap target、text clipping、fixed header と見出しの重なり、dialog の viewport 超過。`error` 判定で失敗、`warning` は evidence のみ。full-page screenshot を必ず添付。AI Vision は使わない（assertion と区別するため）。

## 制約
- 1px 単位のレンダリング差は環境依存。baseline 環境を固定する運用が前提。
- video / trace 内の画像はマスクできない（ARTIFACT_SECURITY.md）。
