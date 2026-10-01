# SECURITY.md

## 脅威モデル（要約）
| 脅威 | 対策 |
|---|---|
| tenant 越境（他組織の Project / artifact / secret 閲覧） | 全テーブルに org_id、API は `requireOrg` / `requireProject` を必ず通る。他 tenant の id は 404。token は 1 組織に束縛、`projectIds` で更に制限可（必須テスト 1, 35） |
| 権限昇格 | role 階層（Viewer < Developer < Tester < QA Lead < Admin < Owner）。token の role は作成者以下。Owner の降格は最後の 1 人を保護。UI ではなく API で強制（必須テスト 2） |
| Secret 漏えい | AES-256-GCM（master key は環境変数）。定義は reference のみ。runner へは lease 応答でのみ渡し、evidence は保存前に置換、trace.zip も post-process。audit/report に値を書かない（必須テスト 4） |
| SSRF / 内部ネットワーク悪用 | `checkTargetUrl`: http(s) のみ、URL 内資格情報禁止、localhost / private / link-local / `.internal` / bare host を既定拒否。**169.254.0.0/16 と metadata ホストは local 環境でも常に拒否**。private は `kind=local` かつ runner `allowPrivateNetwork` の両方が true の時のみ。webhook / domain verification の fetch も同じポリシー（必須テスト 29） |
| 任意コード実行 | step は typed JSON のみ（`evaluate` / `exec` 系は存在しない）。runner は利用者入力をコードとして評価しない。fixture は名前解決（host path 不可）。download はファイル保存のみ、実行しない。実行ファイル fixture は拒否（必須テスト 30） |
| Production 破壊 | production は destructive policy 既定 deny、変更に明示確認、Run 作成時も `allowDestructive` + `run:trigger_destructive` が必要（必須テスト 3） |
| 第三者サイトへの濫用 | 未検証 domain は低負荷モード（concurrency 相当 priority ≤2、1 Run 50 job 上限）。domain verification（DNS TXT / HTML / well-known / manual）。負荷試験・pentest 機能は無い。rate limit（600 req/min/IP、`@fastify/rate-limit`） |
| CSRF | session cookie は `SameSite=Lax` + `HttpOnly`。状態変更リクエストは `Sec-Fetch-Site` / `Origin` を検査 |
| Artifact の無断閲覧 | 署名 URL（HMAC、既定 15 分）、restricted フラグ、retention による削除（必須テスト 7, 37） |
| AI による結果改ざん | AI は提案を保存するだけ。result / baseline / gate への書き込み経路なし。apply は人間 + 権限 + audit（必須テスト 31, 32） |
| Runner の乗っ取り | runner token は `pfr_` 種別、lease した job しか操作不可（他 runner の job は 403）。runner はコンテナで実行し、Playwright ブラウザは headless + sandbox（deploy/Dockerfile.runner） |
| DNS rebinding（MCP HTTP） | Origin allowlist、127.0.0.1 bind 既定、Bearer 必須 |

## 既知の制約 / 今後
- Runner 側の DNS 解決後 IP 検査（rebinding 完全対策）は未実装。private 到達は Environment + runner の二重 opt-in で制御。
- MFA bypass は実装しない。test 用アカウントや storage state を使う。
- Password policy は 10 文字以上のみ。SSO/SCIM は Pro 候補。
- S3 署名 URL / KMS は未実装（ローカル FS）。
- 脆弱性診断（第三者による penetration test）は未実施。販売前チェックリスト参照。

## 報告
セキュリティ問題は公開 issue ではなく販売者の連絡先へ。
