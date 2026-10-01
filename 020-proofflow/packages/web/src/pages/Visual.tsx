import { useState } from 'react';
import { get, post, fmtDate } from '../api.js';
import { Link } from '../router.js';
import { useAsync, Badge, Alert, Tabs } from '../components/ui.js';
import type { Session } from '../App.js';

interface Cmp { id: string; runId: string; stepKey: string; browser: string; viewportKey: string; status: string; diffPixels: number | null; diffRatio: number | null; baselineArtifactId: string | null; currentArtifactId: string; diffArtifactId: string | null; reviewedBy: string | null; reviewNote: string | null; createdAt: string; }

export function VisualPage({ s, projectId }: { s: Session; projectId: string }) {
  const [tab, setTab] = useState('pending');
  const cmps = useAsync(() => get<Cmp[]>(`/api/v1/projects/${projectId}/visual/comparisons?limit=200`), [projectId]);
  const hist = useAsync(() => get<Array<{ id: string; action: string; reason: string | null; actor_id: string | null; actor_kind: string; created_at: string; run_id: string | null }>>(`/api/v1/projects/${projectId}/baselines/history?kind=visual`), [projectId]);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const canApprove = ['owner', 'admin', 'qa_lead'].includes(s.role);
  const list = (cmps.data ?? []).filter((c) => tab === 'pending' ? c.status === 'diff' || c.status === 'new_baseline_needed' : tab === 'all' ? true : c.status === tab);
  const img = (id: string | null) => id ? `/api/v1/artifacts/${id}/download` : null;
  return <>
    <header className="top"><h1>Visual Regression レビュー</h1></header>
    <Alert kind="info">baseline の更新は QA Lead 以上の人間だけが、理由を添えて行います（AI は更新しません）。同じブラウザ・画面サイズの runner 環境で baseline を作ってください。</Alert>
    <Tabs tabs={[['pending', '確認待ち'], ['approved', '承認済み'], ['match', '一致'], ['rejected', '却下'], ['all', 'すべて'], ['history', '更新履歴']]} active={tab} onChange={setTab} />
    {tab === 'history' ? <div className="table-wrap"><table><thead><tr><th>日時</th><th>操作</th><th>理由</th><th>実行者</th><th>Run</th></tr></thead><tbody>{(hist.data ?? []).map((h) => <tr key={h.id}><td className="small">{fmtDate(h.created_at)}</td><td><Badge v={h.action} /></td><td>{h.reason}</td><td className="small">{h.actor_kind} {h.actor_id?.slice(-6)}</td><td className="small">{h.run_id && <Link to={`/projects/${projectId}/runs/${h.run_id}`}>{h.run_id.slice(-8)}</Link>}</td></tr>)}</tbody></table></div> : <>
      {canApprove && tab === 'pending' && list.length > 0 && <div className="panel row"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="承認理由（必須。例: ボタン余白の意図した変更 PR #42）" style={{ flex: 1, minWidth: 220, padding: 8, border: '1px solid var(--line)', borderRadius: 8 }} /><span className="muted small">各比較の「承認」で新しい baseline になります</span></div>}
      {msg && <Alert kind="ok">{msg}</Alert>}
      {list.length === 0 && <p className="muted">該当する比較はありません。</p>}
      {list.map((c) => <div key={c.id} className="panel evidence"><div className="row"><Badge v={c.status} /><b>{c.stepKey}</b><span className="chip">{c.browser}</span><span className="chip">{c.viewportKey}</span>{c.diffRatio !== null && <span className="muted small">差分 {(c.diffRatio * 100).toFixed(2)}% ({c.diffPixels} px)</span>}<Link className="small" to={`/projects/${projectId}/runs/${c.runId}`}>Run</Link><span className="muted small">{fmtDate(c.createdAt)}</span>{c.reviewNote && <span className="muted small">— {c.reviewNote}</span>}</div>
        <div className="cmp" style={{ marginTop: 8 }}><div><div className="small muted">Expected（baseline）</div>{img(c.baselineArtifactId) ? <img src={img(c.baselineArtifactId)!} alt="baseline" loading="lazy" /> : <p className="muted small">baseline なし（初回）</p>}</div><div><div className="small muted">Actual（今回）</div><img src={img(c.currentArtifactId)!} alt="current" loading="lazy" /></div>{c.diffArtifactId && <div><div className="small muted">Diff</div><img src={img(c.diffArtifactId)!} alt="diff" loading="lazy" /></div>}</div>
        {canApprove && (c.status === 'diff' || c.status === 'new_baseline_needed') && <div className="row" style={{ marginTop: 8 }}><button className="btn primary sm" disabled={reason.trim().length < 3} onClick={async () => { await post(`/api/v1/projects/${projectId}/visual/approve`, { comparisonIds: [c.id], reason }); setMsg(`${c.stepKey} を baseline として承認しました`); cmps.reload(); hist.reload(); }}>✓ 意図した変更として承認（baseline 更新）</button><button className="btn sm danger" onClick={async () => { const note = window.prompt('却下理由'); if (!note) return; await post(`/api/v1/projects/${projectId}/visual/comparisons/${c.id}/reject`, { note }); cmps.reload(); }}>✗ 却下（不具合として扱う）</button></div>}
      </div>)}
    </>}
  </>;
}
