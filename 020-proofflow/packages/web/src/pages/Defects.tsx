import { useState } from 'react';
import { get, post, patch, fmtDate, type Defect, type Run } from '../api.js';
import { Link, useRouter } from '../router.js';
import { useAsync, Badge, Drawer, Alert, Form } from '../components/ui.js';
import type { Session } from '../App.js';

const STATUSES = ['new', 'triaged', 'in_progress', 'ready_for_retest', 'verified', 'reopened', 'closed', 'wont_fix'];

export function DefectsPage({ s, projectId, defectId }: { s: Session; projectId: string; defectId?: string }) {
  const { navigate, path } = useRouter();
  const [status, setStatus] = useState('');
  const list = useAsync(() => get<Defect[]>(`/api/v1/projects/${projectId}/defects${status ? `?status=${status}` : ''}`), [projectId, status]);
  const groups = useAsync(() => get<Array<{ id: string; title: string; failureType: string; occurrenceCount: number; lastSeenAt: string; defectId: string | null; sampleResultId: string | null }>>(`/api/v1/projects/${projectId}/failure-groups?withoutDefect=true`), [projectId]);
  const flaky = useAsync(() => get<Array<{ scenarioId: string; browser: string; passedAfterRetry: number; transitions: number; failRate: number; sample: number }>>(`/api/v1/projects/${projectId}/flaky`), [projectId]);
  const canWrite = s.role !== 'viewer';
  return <>
    <header className="top"><h1>不具合（Defect）</h1>{canWrite && <Link className="btn" to={`/projects/${projectId}/defects?new=1`}>＋ 手動で登録</Link>}</header>
    <div className="row" style={{ marginBottom: 8 }}><select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状態で絞り込み"><option value="">すべての状態</option>{STATUSES.map((x) => <option key={x}>{x}</option>)}</select></div>
    <div className="table-wrap"><table><thead><tr><th>Key</th><th>タイトル</th><th>重要度</th><th>状態</th><th>ブラウザ</th><th>更新</th></tr></thead><tbody>
      {(list.data ?? []).map((d) => <tr key={d.id}><td><Link to={`/projects/${projectId}/defects/${d.id}`}>{d.key}</Link></td><td>{d.title}</td><td><Badge v={d.severity} /></td><td><Badge v={d.status} /></td><td className="small">{d.browser}</td><td className="small">{fmtDate(d.updatedAt)}</td></tr>)}
    </tbody></table></div>
    {groups.data && groups.data.length > 0 && <><h2>不具合票のない失敗グループ（同じ指紋の失敗）</h2><div className="table-wrap"><table><thead><tr><th>種類</th><th>内容</th><th>回数</th><th>最終</th><th></th></tr></thead><tbody>{groups.data.map((g) => <tr key={g.id}><td><Badge v={g.failureType} /></td><td className="small">{g.title}</td><td>{g.occurrenceCount}</td><td className="small">{fmtDate(g.lastSeenAt)}</td><td>{canWrite && g.sampleResultId && <button className="btn sm" onClick={async () => { const d = await post<{ id: string }>(`/api/v1/projects/${projectId}/defects/from-result`, { resultId: g.sampleResultId }); navigate(`/projects/${projectId}/defects/${d.id}`); }}>不具合票を作る</button>}</td></tr>)}</tbody></table></div></>}
    {flaky.data && flaky.data.length > 0 && <><h2>Flaky 候補</h2><div className="table-wrap"><table><thead><tr><th>シナリオ</th><th>ブラウザ</th><th>再試行で成功</th><th>結果の揺れ</th><th>失敗率</th><th>標本</th></tr></thead><tbody>{flaky.data.map((f, i) => <tr key={i}><td className="small">{f.scenarioId.slice(-8)}</td><td>{f.browser}</td><td>{f.passedAfterRetry}</td><td>{f.transitions}</td><td>{Math.round(f.failRate * 100)}%</td><td>{f.sample}</td></tr>)}</tbody></table></div></>}
    {defectId && <DefectDrawer projectId={projectId} id={defectId} canWrite={canWrite} role={s.role} onClose={() => { navigate(`/projects/${projectId}/defects`); list.reload(); }} />}
    {path.includes('new=1') && canWrite && <Drawer title="不具合を登録" onClose={() => navigate(`/projects/${projectId}/defects`)}><Form submitLabel="登録" onSubmit={async (v) => { const d = await post<{ id: string }>(`/api/v1/projects/${projectId}/defects`, { title: v.title, severity: v.severity, priority: v.priority, reproduction: v.reproduction, expected: v.expected, actual: v.actual }); navigate(`/projects/${projectId}/defects/${d.id}`); }}>
      <label>タイトル<input name="title" required /></label><div className="grid cols-2"><label>重要度<select name="severity" defaultValue="medium">{['critical', 'high', 'medium', 'low'].map((x) => <option key={x}>{x}</option>)}</select></label><label>優先度<select name="priority" defaultValue="p2">{['p0', 'p1', 'p2', 'p3'].map((x) => <option key={x}>{x}</option>)}</select></label></div><label>再現手順<textarea name="reproduction" /></label><label>期待<textarea name="expected" /></label><label>実際<textarea name="actual" /></label></Form></Drawer>}
  </>;
}

function DefectDrawer({ projectId, id, canWrite, role, onClose }: { projectId: string; id: string; canWrite: boolean; role: string; onClose: () => void }) {
  const d = useAsync(() => get<Defect>(`/api/v1/projects/${projectId}/defects/${id}`), [id]);
  const [msg, setMsg] = useState<string | null>(null);
  const x = d.data; if (!x) return null;
  const canClose = ['owner', 'admin', 'qa_lead'].includes(role);
  return <Drawer title={`${x.key} ${x.title}`} onClose={onClose}>
    <div className="row"><Badge v={x.severity} /><Badge v={x.status} /><span className="muted small">{x.browser}</span></div>
    {msg && <Alert kind="info">{msg}</Alert>}
    {canWrite && <div className="row" style={{ margin: '10px 0' }}>
      <select defaultValue="" onChange={async (e) => { const v = e.target.value; if (!v) return; try { await patch(`/api/v1/projects/${projectId}/defects/${id}`, { status: v, note: window.prompt('メモ（任意）') ?? undefined }); d.reload(); setMsg(null); } catch (er) { setMsg(er instanceof Error ? er.message : String(er)); } e.target.value = ''; }} aria-label="状態を変更"><option value="">状態を変更…</option>{STATUSES.filter((st) => st !== 'verified' && (canClose || (st !== 'closed' && st !== 'wont_fix'))).map((st) => <option key={st} value={st}>{st}</option>)}</select>
      <button className="btn primary sm" onClick={async () => { try { const r = await post<Run>(`/api/v1/projects/${projectId}/defects/${id}/retest`, {}); setMsg(`再テスト Run をキューに入れました（${r.id.slice(-8)}）。合格すると自動で Verified、失敗なら Reopened になります。`); d.reload(); } catch (er) { setMsg(er instanceof Error ? er.message : String(er)); } }}>🔁 再テストを実行（修正後）</button>
    </div>}
    <dl className="kv"><dt>期待</dt><dd>{x.expected}</dd><dt>実際</dt><dd>{x.actual}</dd><dt>再現手順</dt><dd><pre style={{ maxHeight: 200 }}>{x.reproduction}</pre></dd><dt>紐付け</dt><dd>{x.links?.map((l) => <span key={l.type + l.id} className="chip">{l.type}: {l.id.slice(-8)}</span>)}</dd></dl>
    <h3>証拠</h3><div className="evidence">{(x.artifacts ?? []).filter((a) => a.kind === 'screenshot' || a.kind === 'diff').map((a) => <a key={a.id} href={`/api/v1/artifacts/${a.id}/download`} target="_blank" rel="noreferrer"><img src={`/api/v1/artifacts/${a.id}/download`} alt={a.kind} loading="lazy" style={{ maxWidth: 320, marginRight: 8 }} /></a>)}<div className="row">{(x.artifacts ?? []).filter((a) => a.kind === 'trace' || a.kind === 'video' || a.kind === 'dom').map((a) => <a key={a.id} className="btn sm" href={`/api/v1/artifacts/${a.id}/download`}>⬇ {a.kind}</a>)}</div></div>
    <h3>履歴</h3><ul className="small">{(x.history ?? []).map((h, i) => <li key={i}>{fmtDate(h.created_at)} {h.from_status ?? '—'} → <b>{h.to_status}</b> ({h.actor_kind}) {h.note}{h.run_id && <> · <Link to={`/projects/${projectId}/runs/${h.run_id}`}>run</Link></>}</li>)}</ul>
  </Drawer>;
}
