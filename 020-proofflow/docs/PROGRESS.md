# PROGRESS.md — 進捗（正）

更新: 2026-10-01

| Phase | 状態 | 備考 |
|---|---|---|
| 0 公式調査 / PoC / 技術構成 | 完了 | SOURCE_NOTES.md、Chromium PoC 実測、monorepo scaffold、PLAN/DECISIONS |
| 1 Org/Workspace/Project/Env/RBAC/Secret | 完了 | 必須テスト 1,2,3(環境ポリシー),4(vault),38(基盤) 通過 (tests/phase1) |
| 2 Requirement/Scenario/Suite/AI Draft | 進行中 | |
| 3 | 未着手 | |
| 4 | 未着手 | |
| 5 | 未着手 | |
| 6 | 未着手 | |
| 7 | 未着手 | |
| 8 | 未着手 | |
| 9 | 未着手 | |
| 10 | 未着手 | |
| 11 | 未着手 | |
| 12 | 未着手 | |

## 実装済み機能
- Phase 1: signup/login/session cookie、API token (personal/service/runner/mcp)、Organization/Member/Workspace、Project/Environment（target URL policy、production destructive 既定 deny）、Secret Vault（AES-256-GCM、reference 利用）、Audit log

## 未検証 / 既知の制約
- Firefox / WebKit は本環境にブラウザ本体がなく未検証（コードパスのみ）。
