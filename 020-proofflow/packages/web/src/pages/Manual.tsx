import { useState } from 'react';
import { api, get, post, put, patch, fmtDate, type Release } from '../api.js';
import { useAsync, Badge, Form, Tabs, Alert } from '../components/ui.js';
import type { Session } from '../App.js';

export function ManualPage({ s, projectId }: { s: Session; projectId: string }) {
  const [tab, setTab] = useState('checks');
  const checks = useAsync(() => get<Array<{ id: string; label: string | null; device: string; os_version: string | null; browser: string | null; tester_user_id: string; performed_at: string; result: string; notes: string | null; artifactIds: string[]; release_candidate_id: string | null }>>(`/api/v1/projects/${projectId}/manual-checks`), [projectId]);
  const cases = useAsync(() => get<Array<{ id: string; key: string; title: string; category: string; label: string | null }>>(`/api/v1/projects/${projectId}/manual-cases`), [projectId]);
  const releases = useAsync(() => get<Release[]>(`/api/v1/projects/${projectId}/releases`), [projectId]);
  const sessions = useAsync(() => get<Array<{ id: string; charter: string; status: string; started_at: string; duration_min: number | null; notes: string | null; defectIds: string[] }>>(`/api/v1/projects/${projectId}/exploratory`), [projectId]);
  const checklist = useAsync(() => get<{ accessibility: string[]; device: string[] }>(`/api/v1/manual/checklist`), []);
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const canWrite = s.role !== 'viewer';
  return <>
    <header className="top"><h1>手動テスト・実機確認・探索的テスト</h1></header>
    <Alert kind="info">WebKit や画面サイズのエミュレーションは実機 iPhone / Android の代わりになりません。実機・Bluetooth・カメラ・通知・決済・メール・人の目による判断はここに記録します。自動化率 100% は目的ではありません。</Alert>
    <Tabs tabs={[['checks', '実機チェック結果'], ['cases', '手動ケース'], ['exploratory', '探索的テスト'], ['checklist', 'チェックリスト']]} active={tab} onChange={setTab} />
    {tab === 'checks' && <>
      <div className="table-wrap"><table><thead><tr><th>ラベル</th><th>端末</th><th>OS / ブラウザ</th><th>結果</th><th>実施</th><th>メモ</th><th>証拠</th></tr></thead><tbody>{(checks.data ?? []).map((c) => <tr key={c.id}><td>{c.label}</td><td>{c.device}</td><td className="small">{c.os_version} {c.browser}</td><td><Badge v={c.result} /></td><td className="small">{fmtDate(c.performed_at)}</td><td className="small">{c.notes}</td><td>{c.artifactIds.map((a) => <a key={a} href={`/api/v1/artifacts/${a}/download`} target="_blank" rel="noreferrer" className="chip">📎</a>)}</td></tr>)}</tbody></table></div>
      {canWrite && <div className="panel"><h3>実機チェックを記録</h3>
        <label className="small muted">証拠（写真 / 画面録画 / PDF）<input type="file" multiple onChange={async (e) => { const ids: string[] = []; for (const f of Array.from(e.target.files ?? [])) { const a = await api<{ id: string }>('PUT', `/api/v1/projects/${projectId}/manual-evidence?label=${encodeURIComponent(f.name)}`, undefined, { contentType: f.type || 'application/octet-stream', data: f }); ids.push(a.id); } setEvidenceIds((p) => [...p, ...ids]); }} /> {evidenceIds.length > 0 && <span className="chip">{evidenceIds.length} 件添付</span>}</label>
        <Form submitLabel="記録" onSubmit={async (v) => { await post(`/api/v1/projects/${projectId}/manual-checks`, { label: v.label, device: v.device, osVersion: v.osVersion || undefined, browser: v.browser || undefined, result: v.result, notes: v.notes || undefined, releaseCandidateId: v.releaseCandidateId || undefined, manualCaseId: v.manualCaseId || undefined, artifactIds: evidenceIds }); setEvidenceIds([]); checks.reload(); }}>
          <div className="grid cols-3"><label>ラベル（Gate ルールと一致させる）<input name="label" required placeholder="iPhone smoke" /></label><label>端末<input name="device" required placeholder="iPhone 15" /></label><label>OS バージョン<input name="osVersion" placeholder="iOS 19.1" /></label><label>ブラウザ<input name="browser" placeholder="Safari" /></label><label>結果<select name="result" defaultValue="pass"><option value="pass">pass</option><option value="fail">fail</option><option value="blocked">blocked</option><option value="not_run">not_run</option></select></label><label>リリース候補<select name="releaseCandidateId" defaultValue=""><option value="">—</option>{(releases.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.version}</option>)}</select></label><label>手動ケース<select name="manualCaseId" defaultValue=""><option value="">—</option>{(cases.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.key} {c.title}</option>)}</select></label></div>
          <label>メモ<textarea name="notes" placeholder="確認した内容、気づいたこと" /></label>
        </Form></div>}
    </>}
    {tab === 'cases' && <>
      <div className="table-wrap"><table><thead><tr><th>Key</th><th>タイトル</th><th>カテゴリ</th><th>ラベル</th></tr></thead><tbody>{(cases.data ?? []).map((c) => <tr key={c.id}><td>{c.key}</td><td>{c.title}</td><td><Badge v={c.category} /></td><td>{c.label}</td></tr>)}</tbody></table></div>
      {canWrite && <div className="panel"><h3>手動ケースを追加</h3><Form submitLabel="追加" onSubmit={async (v) => { await post(`/api/v1/projects/${projectId}/manual-cases`, { title: v.title, category: v.category, label: v.label || undefined, steps: v.steps || undefined, expected: v.expected || undefined }); cases.reload(); }}>
        <label>タイトル<input name="title" required placeholder="iPhone 実機でログインから購入まで" /></label><div className="grid cols-2"><label>カテゴリ<select name="category" defaultValue="device">{['device', 'bluetooth', 'camera', 'push_notification', 'native_share', 'payment_sandbox', 'email_delivery', 'visual_judgment', 'accessibility_manual', 'other'].map((c) => <option key={c}>{c}</option>)}</select></label><label>ラベル（Gate ルール用）<input name="label" placeholder="iPhone smoke" /></label></div><label>手順<textarea name="steps" /></label><label>期待<textarea name="expected" /></label></Form></div>}
    </>}
    {tab === 'exploratory' && <>
      {(sessions.data ?? []).map((x) => <div key={x.id} className="panel"><div className="row"><b>{x.charter}</b><Badge v={x.status} /><span className="muted small">{fmtDate(x.started_at)} · {x.duration_min ?? '?'} 分 · 不具合 {x.defectIds.length}</span>{canWrite && x.status === 'open' && <button className="btn sm right" onClick={async () => { const notes = window.prompt('セッションのメモ（終了）', x.notes ?? ''); if (notes === null) return; await patch(`/api/v1/projects/${projectId}/exploratory/${x.id}`, { notes, endedAt: new Date().toISOString(), status: 'closed' }); sessions.reload(); }}>終了してメモを保存</button>}</div>{x.notes && <pre style={{ maxHeight: 160 }}>{x.notes}</pre>}</div>)}
      {canWrite && <div className="panel"><h3>探索的テストを開始</h3><Form submitLabel="開始" onSubmit={async (v) => { await post(`/api/v1/projects/${projectId}/exploratory`, { charter: v.charter, durationMin: v.durationMin ? Number(v.durationMin) : undefined, notes: v.notes || undefined }); sessions.reload(); }}><label>チャーター（何を、どの観点で探るか）<input name="charter" required placeholder="新しい決済フローを、入力ミスと中断の観点で 30 分" /></label><div className="grid cols-2"><label>予定時間（分）<input name="durationMin" type="number" /></label></div><label>メモ<textarea name="notes" /></label></Form></div>}
    </>}
    {tab === 'checklist' && checklist.data && <div className="grid cols-2"><div className="panel"><h3>アクセシビリティ（自動検査では見つからない項目）</h3><ul>{checklist.data.accessibility.map((x, i) => <li key={i}>{x}</li>)}</ul></div><div className="panel"><h3>実機・デバイス機能</h3><ul>{checklist.data.device.map((x, i) => <li key={i}>{x}</li>)}</ul></div></div>}
  </>;
}
