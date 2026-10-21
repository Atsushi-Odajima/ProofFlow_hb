# ProofFlow — 不具合から再テスト・受入判定まで

実ブラウザの試験結果と証跡を中心に、不具合・修正・再テスト・リリース判定を管理するセルフホスト型基盤です。

> **実装ブランチ：`claude/merge-errorrelay`**。この既定ブランチのREADMEは製品の案内です。以下のソース・資料リンクと起動手順は、実装ブランチを参照します。

## できること

- Playwright runner、assertion、画面・動画・trace等の証跡
- Defect、再テスト、Release Gate、Evidence Report
- 統合済みの外部不具合受付、機密情報の検出・マスキング候補

## 現在の範囲・制限

- AIは下書き・要約の補助です。期待値・証跡・合否・リリース承認をAIが自動的に確定する設計ではありません。
- 実機の外部受付、外部AI接続、運用先でのrunner分離と接続先の許可設定が必要です。

## 実装の見どころ

**構成：** TypeScript、Node.js、Playwright、React / Vite、SQLite / PostgreSQL、pnpm。

- [020-proofflow/packages](https://github.com/Atsushi-Odajima/ProofFlow_hb/tree/claude%2Fmerge-errorrelay/020-proofflow/packages)
- [020-proofflow/tests](https://github.com/Atsushi-Odajima/ProofFlow_hb/tree/claude%2Fmerge-errorrelay/020-proofflow/tests)
- [020-proofflow/docs](https://github.com/Atsushi-Odajima/ProofFlow_hb/tree/claude%2Fmerge-errorrelay/020-proofflow/docs)

## ローカルで試す

Node.js 22.13以上、pnpm 9以上、Playwright用ChromiumとOS依存ライブラリ。

実装ブランチを取得し、次のディレクトリで作業します。

```sh
git clone --branch claude/merge-errorrelay https://github.com/Atsushi-Odajima/ProofFlow_hb.git
cd ProofFlow_hb/020-proofflow
pnpm install
pnpm exec playwright install chromium
pnpm build
pnpm build:web
```

開発手順でサーバーとrunnerの接続・認証を設定し、pnpm dev:server / pnpm dev:runner / pnpm dev:web を別ターミナルで起動します。

環境設定・初期化の詳細：[セットアップ手順](https://github.com/Atsushi-Odajima/ProofFlow_hb/blob/claude%2Fmerge-errorrelay/020-proofflow/docs/DEVELOPMENT.md)。
WindowsでBash形式の補助スクリプトを使う場合は、WSL等の対応環境で実行してください。

## 検証方法

`020-proofflow/` の `package.json` に定義された主な確認コマンドです。DB・ブラウザ・外部ツールを要するものは、開発手順の事前設定が必要です。

```sh
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:e2e
pnpm run build
pnpm run build:web
```

試験の実施環境・結果・未実施項目は、下記の記録を参照してください。画面エミュレーションと実機確認、モックと外部サービスでの確認を区別しています。

## 資料

- [020-proofflow/docs/DEVELOPMENT.md](https://github.com/Atsushi-Odajima/ProofFlow_hb/blob/claude%2Fmerge-errorrelay/020-proofflow/docs/DEVELOPMENT.md)
- [020-proofflow/docs/NEXT_STEPS.txt](https://github.com/Atsushi-Odajima/ProofFlow_hb/blob/claude%2Fmerge-errorrelay/020-proofflow/docs/NEXT_STEPS.txt)
- [020-proofflow/README.md](https://github.com/Atsushi-Odajima/ProofFlow_hb/blob/claude%2Fmerge-errorrelay/020-proofflow/README.md)
- [020-proofflow/docs/TEST_REPORT.md](https://github.com/Atsushi-Odajima/ProofFlow_hb/blob/claude%2Fmerge-errorrelay/020-proofflow/docs/TEST_REPORT.md)
- [020-proofflow/docs/RELEASE_CHECKLIST.md](https://github.com/Atsushi-Odajima/ProofFlow_hb/blob/claude%2Fmerge-errorrelay/020-proofflow/docs/RELEASE_CHECKLIST.md)
- [020-proofflow/docs/DATA_MODEL.md](https://github.com/Atsushi-Odajima/ProofFlow_hb/blob/claude%2Fmerge-errorrelay/020-proofflow/docs/DATA_MODEL.md)
- [020-proofflow/docs/DECISIONS.md](https://github.com/Atsushi-Odajima/ProofFlow_hb/blob/claude%2Fmerge-errorrelay/020-proofflow/docs/DECISIONS.md)
- [020-proofflow/docs/SECURITY.md](https://github.com/Atsushi-Odajima/ProofFlow_hb/blob/claude%2Fmerge-errorrelay/020-proofflow/docs/SECURITY.md)
- [020-proofflow/docs/OPERATIONS.md](https://github.com/Atsushi-Odajima/ProofFlow_hb/blob/claude%2Fmerge-errorrelay/020-proofflow/docs/OPERATIONS.md)

## 制作・利用条件

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
ソース・同梱ライブラリ・フォント・モデル等の利用条件は、各ライセンスと第三者表記を参照してください。リポジトリの閲覧可能性と、再配布・商用利用の許諾は別です。
