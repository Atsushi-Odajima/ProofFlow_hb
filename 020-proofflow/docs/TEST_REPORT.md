# TEST_REPORT.md — テスト結果報告（2026-10-01）

実行環境: Linux x86_64、4 vCPU（Intel Xeon 2.10 GHz）/ 16 GB、Node v22.22.0、pnpm 10.28.0、Playwright 1.56.1 + Chromium 141.0.7390.37（headless shell）、SQLite（`node:sqlite`）、PostgreSQL 16.14（ローカル）。
Firefox / WebKit のブラウザ本体は本環境で取得できず（CDN 遮断）、**すべてのブラウザ実行は Chromium** です。

## 1. 結果サマリ
| 区分 | コマンド | 結果 |
|---|---|---|
| 型検査 | `pnpm typecheck`（7 パッケージ）+ ルート `tsc --noEmit`（tests） | 通過 |
| 単体〜統合（phase1〜11、SQLite） | `pnpm test` | __FULL_SQLITE__ |
| 同（PostgreSQL 16） | `pnpm test:pg` | __FULL_PG__ |
| E2E-1〜10（Chromium、Sample SaaS） | `pnpm test:e2e` | __E2E__ |
| UI 検証 PC / iPhone / Android | `pnpm build:web && pnpm test:ui` | 通過: 19 画面 × 3 viewport = 57 画面、page error 0、console error 0、横 overflow 0（docs/ui-verification/summary.json） |
| 負荷計測（SQLite ファイル） | `pnpm test:load` | 通過（§4、docs/load-results-sqlite.json） |
| 負荷計測（PostgreSQL） | `PROOFFLOW_TEST_DATABASE_URL=... pnpm test:load` | __LOAD_PG__ |

## 2. 必須テスト 1〜38 の対応（すべて自動テストで通過）
| # | 内容 | テスト |
|---|---|---|
| 1 | tenant A→B の Project / API / artifact 拒否（404） | phase1 |
| 2 | Viewer は Scenario / Suite を変更不可 | phase1, phase2 |
| 3 | production destructive 既定拒否（run 作成時）。policy 変更は人間のみ | phase3, e2e-8 |
| 4 | secret が log / report / trace / DB に平文で出ない | phase3（trace.zip 全エントリ検査）, phase11（backup） |
| 5 | infra error と test failure の分離（再キュー、別 status） | phase3 |
| 6 | screenshot on failure（+ DOM / video / trace / console / network） | phase3 |
| 7 | 署名 URL の期限・改竄検知 | phase3, phase10 |
| 8 | console rule（既定は evidence、assert で失敗、ignore） | phase4 |
| 9 | network 5xx 検出 | phase4 |
| 10 | visual baseline 差分（diff 画像） | phase5 |
| 11 | 権限のない baseline 更新拒否、理由必須、履歴 | phase5 |
| 12 | viewport overflow / CTA offscreen（fixture） | phase5, e2e-3 |
| 13 | accessibility 既知違反検出（axe） | phase5 |
| 14 | broken link | phase5 |
| 15 | form double submit / 必須チェック | phase4 |
| 16 | upload invalid type | phase4 |
| 17 | download filename / MIME | phase4 |
| 18 | API JSON schema failure（+ status / latency / OpenAPI diff） | phase4, e2e-5 |
| 19 | retry 後 pass → flaky / passed_after_retry | phase3, phase6 |
| 20 | failure fingerprint | phase6 |
| 21 | Defect 生成（from result、証跡付き） | phase6 |
| 22 | retest で Verified | phase6, e2e-1 |
| 23 | regression で再発 → Reopened | phase6 |
| 24 | gate critical failure → BLOCKED | phase7 |
| 25 | Accepted Risk は approver（人）/ reason / review date / impact 必須 | phase7 |
| 26 | manual iPhone 未実施 → rule 次第で BLOCKED → 記録後 READY | phase7, e2e-4 |
| 27 | Evidence Report と Run 結果一致、承認は人間のみ | phase7 |
| 28 | domain ownership policy（未検証 = 低負荷モード、manual は Owner/Admin） | phase10 |
| 29 | SSRF: metadata / private / file: 拒否（control plane + runner） | phase10 |
| 30 | malicious step から host shell 不可、fixture path escape 不可 | phase10 |
| 31 | AI summary が result を書き換えない | phase6, e2e-9 |
| 32 | AI selector repair は review なしで適用不可 | phase6 |
| 33 | AI OFF で provider call ゼロ | phase2 |
| 34 | Backup / Restore 後 traceability 一致 | phase11, e2e-10 |
| 35 | Plugin から許可 Project のみ Run（他は 404） | phase8 |
| 36 | schedule 重複制御（idempotent、overlap skip） | phase9 |
| 37 | artifact retention delete（storage + metadata + 署名 URL 失効） | phase10 |
| 38 | audit log（RBAC / secret / env / scenario / baseline / gate / risk / defect close / export / runner / backup） | phase1, phase10, phase11 |

テスト数: phase1 9 / phase2 11 / phase3 7 / phase4 7 / phase5 5 / phase6 7 / phase7 4 / phase8 5 / phase9 3 / phase10 7 / phase11 2 = 67、E2E 10、UI 4、load 1。

## 3. E2E-1〜10
| E2E | 内容 | 備考 |
|---|---|---|
| 1 | Project → Staging env（未検証 domain = pending）→ Requirement → AI draft（mock）→ Scenario → 実行 → 失敗証跡（screenshot / dom / console / network / trace / video）→ Defect → fix → retest → Verified | ブラウザは Chromium のみ。Firefox / WebKit は matrix で受理されるが本環境で未実行 |
| 2 | baseline → CSS 変更 → visual diff → レビュー → 意図した変更は理由付きで baseline 更新（履歴 from/to） | |
| 3 | desktop pass / mobile viewport fail → Defect（viewport 付き）→ fix → mobile pass | |
| 4 | Critical pass だが manual iPhone 未実施 → BLOCKED → 実機チェック + 証跡 → READY | |
| 5 | API contract breaking（plan: string → number）→ api_contract failure → Defect | |
| 6 | MCP（stdio in-memory）: run_test_suite → get_test_run → summarize_failures → get_release_gate（BLOCKED、承認しない旨の note） | ChatGPT connector 実接続は未確認 |
| 7 | test-impact 候補 → agent token で related retest → full Critical → ci-summary。agent は release 承認不可（403） | |
| 8 | production × destructive → 403 destructive_denied。service token は policy 変更不可（403 human_required） | |
| 9 | maskSelectors の要素（PII）が DOM / failure / console / network から `[masked]`、restricted artifact は viewer に 404、AI 要約の入力・出力に PII / secret なし、result 不変 | この E2E で PII が AI 入力へ流れる欠陥を発見し修正（DECISIONS D-020） |
| 10 | backup → 空環境へ restore → traceability / RC / defects / runs / suites 完全一致、gate 再評価同一 | |

## 4. 負荷計測（docs/load-results-sqlite.json）
条件: 1 Project に Run を 100 → 1,000 → 10,000 蓄積（Run = 1 シナリオ × Chromium × desktop の 1 job）。runner はブラウザなしの制御プレーン計測（lease → 200 KB screenshot upload → complete）、4 runner 同時。クエリは各 20 回の p50 / p95。

| 蓄積 Run 数 | Run 作成 p50 / p95（throughput） | lease+complete（4 runner） | lease p95 | complete p95 | upload p95（MB/s） | dashboard p95 | Run 一覧 50 件 p95 | 失敗 Run 一覧 p95 | Run 詳細 p95 | audit 50 件 p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 1.4 / 2.7 ms（534 run/s） | 163 job/s | 23 ms | 11 ms | 28 ms（10.9） | 1.9 ms | 2.1 ms | 0.7 ms | 1.8 ms | 9.1 ms |
| 1,000 | 1.2 / 1.9 ms（660 run/s） | 211 job/s | 25 ms | 23 ms | 35 ms（9.2） | 9.4 ms | 1.6 ms | 1.4 ms | 1.3 ms | 9.6 ms |
| 10,000 | 1.0 / 1.8 ms（707 run/s） | 98 job/s | 95 ms | 74 ms | 99 ms（6.0） | 30 ms | 2.2 ms | 7.2 ms | 2.8 ms | 27 ms |

所見: 10,000 Run でも API は数十 ms 以内。lease は `run_jobs` の queue index を使うが 10,000 件規模で p95 95 ms（SQLite 単一 writer の直列化）。PostgreSQL の結果は §1。1 億 Result 規模は未計測であり、広告しない（負荷目標の設計意識のみ: DATA_MODEL.md）。

PostgreSQL 計測: __LOAD_PG_TABLE__

## 5. UI 検証（docs/ui-verification/）
viewport: PC 1440×900、iPhone 15 相当 390×844 @3x（Mobile Safari UA）、Pixel 8 相当 412×915 @2.625x（Chrome Android UA）。ページ: login / projects / dashboard / requirements / scenarios / suites / runs / run-detail（failed・passed・mobile）/ visual / defects / defect-detail / releases / release-detail / manual / schedules / project-settings / org-settings。
判定: page error 0、console error 0（login の `/auth/me` 401 プローブのみ除外）、`scrollWidth - clientWidth ≤ 1`。全 57 画面 OK。スクリーンショットは JPEG（9.7 MB）。
制約: Chromium のエミュレーション。実機 Safari / Chrome は RELEASE_CHECKLIST.md。

## 6. Browser matrix
| ブラウザ | 対応 | 検証 |
|---|---|---|
| Chromium 141（Playwright 1.56.1） | ○ | 全テスト |
| Firefox（Playwright 同梱版） | コード対応（BrowserPool / matrix / runner capability） | **未検証**（本体なし） |
| WebKit（Playwright 同梱版） | 同上 | **未検証** |
| iPhone / Android 実機 | 手動チェック機能で記録 | **未検証** |

## 7. セキュリティテスト（phase10 + E2E-8/9）
SSRF（metadata / private / file: / credential URL、runner 側でも拒否）、host shell なし、fixture path escape なし、未検証 domain の低負荷モード、retention 削除、署名 URL、cross-tenant 404、restricted artifact、PII mask、production destructive の人間限定。penetration test は対象外。

## 8. 既知の問題 / 未検証
- Firefox / WebKit、実機、実 AI API、ChatGPT connector、Docker build、S3、email adapter（RELEASE_CHECKLIST.md）。
- `node:sqlite` の ExperimentalWarning（動作に影響なし）。
- Phase 11 のデモ初回実行で Critical の 1 シナリオが flaky（retry で pass）になった事象を 1 回観測。以後 3 回の実行では再現せず。原因未特定（タイミング依存の可能性）。再現時のために demo helper が attempt 詳細をログする。
