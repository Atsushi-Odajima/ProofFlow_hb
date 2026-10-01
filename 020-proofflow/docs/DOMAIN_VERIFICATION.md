# DOMAIN_VERIFICATION.md — 対象ドメインの所有確認と濫用防止

## なぜ必要か
ProofFlow は実ブラウザで対象サイトを操作する。第三者サイトへの scraping / credential stuffing / 負荷に使われないよう、**public target は所有・管理権限の確認が無い限り低負荷モード**で動く。

## 方式
| method | 手順 | 検証 |
|---|---|---|
| `dns_txt` | `hostname`（または `_proofflow.hostname`）に TXT `proofflow-verify=<token>` | `dns.resolveTxt` |
| `html_token` | トップページ `<head>` に `<meta name="proofflow-verify" content="<token>">` | GET `https://host/` を取得して検索（SSRF ポリシー適用、redirect 追従なし） |
| `well_known` | `https://host/.well-known/proofflow-verify.txt` に token | GET |
| `manual` | 組織の **Owner / Admin** が人間として所有を attest | audit に記録 |

Preview URL（Vercel / Netlify などの一時 URL）は `html_token` / `well_known` をビルドに組み込むか、組織内 `manual` を使う。`localhost` は `kind=local` 環境 + self-hosted runner のため検証対象外。

## 未検証 domain の制限（低負荷モード）
- Run priority は 2 以下に丸める（検証済みは最大 9）。
- 1 Run の job 数 50 まで（scenario × browser × viewport）。
- crawl は環境 origin 内のみ（検証有無に関わらず）。
- 将来: 1 日あたりの Run 回数上限（`usage_counters`）を設定可能にする。

## 検証後
hostname が一致する Environment の `domain_verified=1`。token の再発行は `POST /domains` で上書き（status pending に戻る）。

## 権限
開始・検証: `domain:verify`（QA Lead 以上）。`manual` の検証のみ Owner / Admin。
