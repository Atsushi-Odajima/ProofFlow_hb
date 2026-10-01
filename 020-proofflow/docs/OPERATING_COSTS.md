# OPERATING_COSTS.md — 運用コスト（試算方法と目安）

前提: ここに書く金額は 2026-10 時点の一般的な単価レンジを使った**試算方法の例**であり、価格保証ではありません。実際の請求はクラウド事業者 / AI 事業者の最新価格表で再計算してください（RELEASE_CHECKLIST.md の人間確認項目）。

## コスト要素
| 要素 | 何に比例するか | 目安（計測値 / 設計値） |
|---|---|---|
| Browser runner（CPU / RAM / 時間） | Run 数 × シナリオ数 × ブラウザ数 × viewport 数 × 平均実行時間 | Chromium 1 ジョブ ≈ 0.5〜1 vCPU、300〜700 MB RAM、Sample SaaS の 1 シナリオ 2〜8 秒（video / trace ON で +30〜60%） |
| Artifact storage | 失敗数 × (screenshot 50〜300 KB + DOM 50〜500 KB + console/network 10〜100 KB + trace 1〜10 MB + video 1〜10 MB) | 既定: passed は screenshot のみ 7 日、failed は全証跡 60 日、release evidence 365 日、baseline 無期限 |
| DB | Run / Result / Artifact メタデータ行数 | 1 Run（1 ジョブ）≈ 3〜5 KB。10,000 Run ≈ 40〜60 MB（SQLite 実測 10,000 Run + 10,000 Result + 700 artifact メタ ≈ 30 MB） |
| Queue | control plane 内（DB テーブル） | 追加費用なし（Redis 不要） |
| AI | 呼び出し回数 × トークン | 失敗要約 1 件 ≈ 2〜6K 入力 / 0.3〜1K 出力トークン、シナリオ下書き 1 回 ≈ 1〜3K / 1〜3K。既定 OFF |
| Email / Slack / Webhook | 通知数 | in-app / webhook / Slack は無料枠で足りる規模。email adapter は未同梱 |
| Backup | メタデータ JSON（小）+ artifact ストレージ（大） | JSON は DB の 1〜2 倍のサイズ。artifact は保持期間で決まる |

## 計測した制御プレーンの性能（docs/load-results-sqlite.json、4 vCPU / 16 GB、SQLite ファイル + WAL、2026-10-01）
| 規模（Project 内の Run 数） | Run 作成 p95 | runner lease+complete（4 runner 同時） | artifact upload（200 KB） | dashboard p95 | Run 一覧 (50 件) p95 |
|---|---|---|---|---|---|
| 100 | 2.7 ms（534 run/s） | 163 job/s | 10.9 MB/s | 1.9 ms | 2.1 ms |
| 1,000 | 1.9 ms（660 run/s） | 211 job/s | 9.2 MB/s | 9.4 ms | 1.6 ms |
| 10,000 | 1.8 ms（707 run/s） | 98 job/s（lease p95 95 ms） | 6 MB/s | 30 ms | 2.2 ms |

control plane は月 10,000 Run 規模でも 1 台（2 vCPU / 2 GB）で十分です。ボトルネックは常に **ブラウザ実行（runner）** と **動画 / trace のストレージ** です。

## 試算例（1 Run = Critical suite 8 シナリオ × Chromium × desktop、平均 5 秒/シナリオ、失敗率 10%）
計算式:
- runner 時間 = Run 数 × シナリオ数 × ブラウザ数 × viewport 数 × 平均秒 ÷ concurrency(2) ÷ 3600 → vCPU 時間
- ストレージ増分/月 = Run 数 × シナリオ数 × (passed 分 0.15 MB + 失敗率 × 失敗分 8 MB)。保持 60 日なので定常在庫 ≈ 2 か月分

| 月間 Run | runner 時間 / 月 | 推奨構成 | 証跡ストレージ（定常） | 概算月額 |
|---|---|---|---|---|
| 100 | 100×8×5 s ÷ 2 ≈ 0.6 h | 開発 PC または 2 vCPU VM 1 台（control plane 同居） | ≈ 0.1 GB × 2 か月 ≈ 0.2〜0.5 GB | VM 1 台（2 vCPU / 4 GB ≈ 1,500〜4,000 円）+ ストレージ数十円。**実質 VM 1 台分** |
| 1,000 | ≈ 5.6 h | control plane 2 vCPU + runner 2〜4 vCPU 1 台（常時 or 必要時起動） | ≈ 1〜2 GB × 2 か月 ≈ 2〜4 GB | VM 2 台（≈ 5,000〜12,000 円）+ ストレージ ≈ 100 円 + バックアップ ≈ 100 円 |
| 10,000 | ≈ 56 h | control plane 2 vCPU + PostgreSQL + runner 4 vCPU × 2〜3 台（自動起動停止推奨） | ≈ 10〜20 GB × 2 か月 ≈ 20〜40 GB | VM 3〜4 台（≈ 15,000〜40,000 円）+ オブジェクトストレージ ≈ 100〜300 円 + DB ≈ 2,000〜8,000 円 |

ブラウザ数 × viewport 数で線形に増えます。Firefox + WebKit + モバイル 2 種を全 Run で回すと runner 時間は 6〜9 倍になります。「Critical は Chromium desktop を毎回、フルマトリクスは nightly / RC 時のみ」が現実的です。

### 常時 video / trace は高コスト
`video: always` / `trace: always` は 1 シナリオあたり 2〜20 MB を**毎回**生成し、実行時間も 30〜60% 延びます。既定（`on_failure`）では成功時は screenshot と console / network の要約だけが残ります。月 10,000 Run × 8 シナリオで `always` にすると 160〜1,600 GB/月のストレージ増になり得ます。retention（`PROOFFLOW_RETENTION_*`）と `artifact:delete` 権限で管理してください。

## AI 費用（既定 OFF、`PROOFFLOW_AI_PROVIDER` で有効化）
| 機能 | 1 回あたりの目安 | 月 100 回 | 備考 |
|---|---|---|---|
| シナリオ下書き（6 件） | 入力 2K + 出力 2K トークン | 数十円〜数百円 | 要件文 + クロール inventory のみ送信 |
| 失敗要約 / Defect 下書き | 入力 4K + 出力 0.6K | 数十円〜数百円 | redaction 後の失敗情報・console 要約。`restricted` artifact は送らない |
| セレクタ修復提案 | 入力 3K + 出力 0.3K | 数円〜数十円 | DOM 抜粋は mask 後 |
単価はモデルにより 1 桁以上異なります。`ai_invocations`（トークン数 / 回数）で実績を見て、組織設定で月間上限を決めてください。

## usage quota 設計（初版は計測のみ、強制は Pro 候補）
- `usage_counters`（org × 月 × metric）: runs / artifact_bytes / ai_calls を集計。
- 未検証ドメインは低負荷モード（concurrency 1、crawl 不可、1 日の Run 数上限）で abuse を抑える（DOMAIN_VERIFICATION.md）。
- 上限超過時の挙動（警告 → 新規 Run 拒否）は `usage_counters` を読む 1 箇所（`RunService.create`）で実装できる設計。

## 節約の順序
1. video / trace を `on_failure` のまま運用する。
2. 保持期間を短くする（passed 7 日、failed 30〜60 日）。
3. Critical だけを毎回、フルマトリクスは nightly。
4. runner はスポット / 必要時起動（lease ベースなので止めても queue は失われない）。
5. AI は失敗要約だけに限定し、月上限を決める。
