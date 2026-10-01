import { useState } from 'react';
import { get, post, patch, type Requirement } from '../api.js';
import { Link } from '../router.js';
import { useAsync, Form, Badge, Drawer } from '../components/ui.js';
import type { Session } from '../App.js';

export function RequirementsPage({ s, projectId }: { s: Session; projectId: string }) {
  const list = useAsync(() => get<Requirement[]>(`/api/v1/projects/${projectId}/requirements`), [projectId]);
  const [open, setOpen] = useState<Requirement | null>(null);
  const trace = useAsync(() => open ? get<{ scenarios: Array<{ scenario: { id: string; key: string; title: string }; latestResults: Array<{ status: string; run_id: string; completed_at: string | null }>; defects: Array<{ key: string; status: string; severity: string }> }>; manualCases: Array<{ key: string; title: string }> }>(`/api/v1/projects/${projectId}/requirements/${open.id}/traceability`) : Promise.resolve(null), [open?.id]);
  const canWrite = !['viewer', 'developer'].includes(s.role);
  return <>
    <header className="top"><h1>要件 / 受入条件</h1></header>
    <div className="table-wrap"><table><thead><tr><th>Key</th><th>タイトル</th><th>優先度</th><th>状態</th><th>シナリオ</th></tr></thead><tbody>
      {(list.data ?? []).map((r) => <tr key={r.id}><td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(r); }}>{r.key}</a></td><td>{r.title}</td><td><Badge v={r.priority} /></td><td><Badge v={r.status} /></td><td>{r.scenarioIds.length}</td></tr>)}
    </tbody></table></div>
    {canWrite && <div className="panel"><h3>要件を追加</h3><Form submitLabel="追加" onSubmit={async (v) => { await post(`/api/v1/projects/${projectId}/requirements`, { title: v.title, description: v.description, priority: v.priority, status: 'draft', acceptanceCriteria: v.given || v.when || v.then ? [{ format: 'gwt', given: v.given, when: v.when, then: v.then }] : [] }); list.reload(); }}>
      <label>タイトル<input name="title" required placeholder="例: ユーザーはメールとパスワードでログインできる" /></label>
      <label>説明<textarea name="description" /></label>
      <label>優先度<select name="priority" defaultValue="p1"><option value="p0">p0（最重要）</option><option value="p1">p1</option><option value="p2">p2</option><option value="p3">p3</option></select></label>
      <div className="grid cols-3"><label>Given<input name="given" placeholder="登録済みユーザーが" /></label><label>When<input name="when" placeholder="正しい資格情報でログインすると" /></label><label>Then<input name="then" placeholder="ダッシュボードが表示される" /></label></div>
    </Form></div>}
    {open && <Drawer title={`${open.key} ${open.title}`} onClose={() => setOpen(null)}>
      <p>{open.description}</p>
      <h3>受入条件</h3>{open.acceptanceCriteria.length ? open.acceptanceCriteria.map((a, i) => <div key={i} className="panel">{a.format === 'gwt' ? <><b>Given</b> {a.given}<br /><b>When</b> {a.when}<br /><b>Then</b> {a.then}</> : a.text}</div>) : <p className="muted">未登録</p>}
      {canWrite && <div className="row"><select defaultValue={open.status} onChange={async (e) => { await patch(`/api/v1/projects/${projectId}/requirements/${open.id}`, { status: e.target.value }); list.reload(); }}>{['draft', 'approved', 'implemented', 'verified', 'deprecated'].map((x) => <option key={x}>{x}</option>)}</select><span className="muted">状態</span></div>}
      <h3>トレーサビリティ（要件 → シナリオ → 最新結果 → 不具合）</h3>
      {trace.data ? <>{trace.data.scenarios.map((x) => <div key={x.scenario.id} className="panel"><b>{x.scenario.key}</b> {x.scenario.title} <div className="row" style={{ marginTop: 6 }}>{x.latestResults.slice(0, 5).map((r, i) => <Link key={i} to={`/projects/${projectId}/runs/${r.run_id}`}><Badge v={r.status} /></Link>)}{x.defects.map((d) => <span key={d.key} className="chip">{d.key} <Badge v={d.status} /></span>)}</div></div>)}{trace.data.manualCases.length > 0 && <p className="muted">手動ケース: {trace.data.manualCases.map((m) => m.key).join(', ')}</p>}{trace.data.scenarios.length === 0 && <p className="muted">この要件に紐付くシナリオはまだありません。<Link to={`/projects/${projectId}/scenarios?req=${open.id}`}>シナリオを作成</Link></p>}</> : <p className="muted">読み込み中…</p>}
    </Drawer>}
  </>;
}
