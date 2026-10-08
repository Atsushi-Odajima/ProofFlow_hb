# MCP_PLUGIN.md — ChatGPT / Codex / Claude Code 向け ProofFlow Plugin

## 構成
`packages/mcp` は MCP server（`@modelcontextprotocol/sdk@1.31.0`、protocol 2025-11-25 系）。REST API の **client** として実装し、認可は control plane が ProofFlow token で行う。Plugin は DB / Vault に触れない。

| Transport | 用途 | 起動 |
|---|---|---|
| stdio | Codex CLI、Claude Code、ローカル Agent | `PROOFFLOW_URL=... PROOFFLOW_TOKEN=pfm_... proofflow-mcp` |
| Streamable HTTP | ChatGPT connector（developer mode）、リモート | `proofflow-mcp --http`（`PROOFFLOW_MCP_PORT` 既定 8787、`/mcp`）。Bearer token 必須。`PROOFFLOW_MCP_ALLOWED_ORIGINS` で Origin 検証（DNS rebinding 対策）。`PROOFFLOW_MCP_ALLOW_URL_TOKEN=1` で `?token=` を許可（ヘッダを送れないホスト向け、推奨しない） |

HTTP モードは **stateless**（リクエストごとに McpServer を生成、`Mcp-Session-Id` 不使用）。2026-07-28 版仕様のステートレス方向とも整合する。

## Token
Organization → Tokens で `kind: mcp`（または service）の token を作成。`projectIds` で対象 Project を制限できる。Plugin 経由でも **許可 Project 以外は 404**（必須テスト 35）。role は作成者以下。baseline 更新や release 承認を Plugin から行わせたくない場合は tester / developer role の token を使う。

## Tools（12）
| tool | 内容 | annotations |
|---|---|---|
| create_project | Project（+ 最初の Environment）作成 | write |
| analyze_test_target | 登録済み Environment の policy / suites / scenario 数 / crawl inventory / 警告（production、未検証 domain） | readOnly |
| draft_acceptance_tests | AI scenario draft（org で AI 有効時のみ、提案のみ） | write |
| create_test_scenario | typed steps で scenario 作成（任意 JS 不可、`StepSchema` 検証） | write |
| run_test_suite | Suite / scenarioIds を Environment で実行。**production × destructive は confirmDestructive 無しで拒否**、environment policy が deny なら確認があっても拒否。`wait` で完了まで polling | write |
| get_test_run | status / counts / 失敗と evidence artifact id | readOnly |
| summarize_failures | 証拠ベースの grouping。`useAi` で AI 要約（結果は不変） | readOnly |
| create_defect_from_failure | 失敗 result から Defect 作成 | write |
| retest_defect | retest run（pass で Verified、fail で Reopened） | write |
| get_release_gate | gate 評価（READY / BLOCKED / READY_WITH_ACCEPTED_RISK）。**承認はしない** | readOnly |
| prepare_release_evidence | Evidence Report 生成（artifact id） | write |
| submit_bug_report | ProofFlow 不具合報告: エラー報告（件名 / 実際 / 期待 / 手順 / エラー文）を Defect として登録。保存前に ProofFlow 個人情報マスク、`idempotencyKey` で冪等。添付は不可（Web / REST を使用） | write（idempotent） |

例: 「この staging URL、release 前に確認して」→ `analyze_test_target` で Project/Environment と許可 Suite を提示 → destructive の有無を確認 → `run_test_suite` → `summarize_failures` → `get_release_gate`。第三者 URL は tool 引数に存在しない（登録済み Environment のみ）。

## Codex CLI（`codex mcp add --help` で確認、0.159.3）
```
codex mcp add proofflow --env PROOFFLOW_URL=https://proofflow.example.com --env PROOFFLOW_TOKEN=pfm_xxx -- proofflow-mcp
# または streamable HTTP:
codex mcp add proofflow --url https://proofflow.example.com:8787/mcp --bearer-token-env-var PROOFFLOW_TOKEN
```
`~/.codex/config.toml` の `[mcp_servers.proofflow]` に保存される。

## Claude Code
```
claude mcp add proofflow -e PROOFFLOW_URL=... -e PROOFFLOW_TOKEN=... -- proofflow-mcp
```

## ChatGPT（developer mode connector）
HTTPS で到達できる URL に `proofflow-mcp --http` を公開（reverse proxy で TLS）。connector 追加時の認証は **OAuth** または **なし**。初版は OAuth 2.1 Authorization Server を同梱していないため、ChatGPT から使う場合は (a) `PROOFFLOW_MCP_ALLOW_URL_TOKEN=1` + token 入り URL（URL がログに残り得るため低セキュリティ。token は projectIds 制限 + 短い有効期限で発行）または (b) 前段のゲートウェイで OAuth → Bearer 変換、を選ぶ。OAuth 2.1 対応は Pro 候補（RELEASE_CHECKLIST に明記）。Apps SDK の UI widget（MCP Apps `ui://`）は未対応（text / structuredContent のみ）。

## 制約・注意
- developers.openai.com は本開発環境から閲覧不可だったため、ChatGPT connector の最新手順は販売前に人間が確認する（SOURCE_NOTES.md §3）。
- Plugin は AI の release 承認・baseline 更新を行えない（API 経路なし）。
- 負荷試験・penetration test 用 tool は無い。
