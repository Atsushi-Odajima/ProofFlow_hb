import { useState } from 'react';
import { get, post, fmtDate, type Release, type Suite, type Environment, type Project, type Defect } from '../api.js';
import { Link, useRouter } from '../router.js';
import { useAsync, Badge, Alert, Form, Drawer } from '../components/ui.js';
import type { Session } from '../App.js';

export function ReleasesPage({ s, projectId, rcId }: { s: Session; projectId: string; rcId?: string }) {
  const { navigate } = useRouter();
  const list = useAsync(() => get<Release[]>(`/api/v1/projects/${projectId}/releases`), [projectId]);
  const proj = useAsync(() => get<Project & { environments: Environment[] }>(`/api/v1/projects/${projectId}`), [projectId]);
  const suites = useAsync(() => get<Suite[]>(`/api/v1/projects/${projectId}/suites`), [projectId]);
  const canWrite = !['viewer', 'developer'].includes(s.role);
  return <>
    <header className="top"><h1>リリース候補と Release Gate</h1></header>
    <div className="table-wrap"><table><thead><tr><th>版</th><th>状態</th><th>Gate</th><th>commit</th><th>環境</th><th>作成</th></tr></thead><tbody>
      {(list.data ?? []).map((r) => <tr key={r.id}><td><Link to={`/projects/${projectId}/releases/${r.id}`}>{r.version}</Link></td><td><Badge v={r.status} /></td><td><Badge v={r.lastGateResult ?? 'unevaluated'} /></td><td className="small"><code>{r.commitSha?.slice(0, 8)}</code></td><td className="small">{proj.data?.environments.find((e) => e.id === r.environmentId)?.name}</td><td className="small">{fmtDate(r.createdAt)}</td></tr>)}
    </tbody></table></div>
    {canWrite && proj.data && <div className="panel"><h3>リリース候補を作成</h3><Form submitLabel="作成" onSubmit={async (v) => { const r = await post<Release>(`/api/v1/projects/${projectId}/releases`, { version: v.version, commitSha: v.commitSha || undefined, buildId: v.buildId || undefined, environmentId: v.environmentId, includedChanges: v.includedChanges || undefined, requiredManualChecks: v.manual ? v.manual.split(',').map((x) => x.trim()).filter(Boolean) : [] }); list.reload(); navigate(`/projects/${projectId}/releases/${r.id}`); }}>
      <div className="grid cols-3"><label>バージョン<input name="version" required placeholder="1.2.0" /></label><label>commit SHA<input name="commitSha" /></label><label>build ID<input name="buildId" /></label></div>
      <label>環境<select name="environmentId" defaultValue={proj.data.defaultEnvironmentId ?? ''}>{proj.data.environments.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.kind})</option>)}</select></label>
      <label>含まれる変更<textarea name="includedChanges" /></label>
      <label>必須の手動チェック（ラベル、カンマ区切り。例: iPhone smoke, Android smoke）<input name="manual" placeholder="iPhone smoke" /></label>
      <p className="muted small">必須スイート: {(suites.data ?? []).filter((x) => x.requiredForRelease).map((x) => x.name).join(', ') || 'なし（スイートの「リリースゲートで必須」を有効にしてください）'}</p>
    </Form></div>}
    {rcId && <ReleaseDrawer projectId={projectId} rcId={rcId} role={s.role} onClose={() => { navigate(`/projects/${projectId}/releases`); list.reload(); }} />}
  </>;
}

function ReleaseDrawer({ projectId, rcId, role, onClose }: { projectId: string; rcId: string; role: string; onClose: () => void }) {
  const rc = useAsync(() => get<Release>(`/api/v1/projects/${projectId}/releases/${rcId}`), [rcId]);
  const defects = useAsync(() => get<Defect[]>(`/api/v1/projects/${projectId}/defects`), [projectId]);
  const [msg, setMsg] = useState<string | null>(null); const [risk, setRisk] = useState(false);
  const r = rc.data; if (!r) return null;
  const canApprove = ['owner', 'admin', 'qa_lead'].includes(role);
  const ev = r.evaluations?.[0];
  return <Drawer title={`リリース候補 ${r.version}`} onClose={onClose}>
    <div className="row"><Badge v={r.status} /><span className="muted small">commit {r.commitSha ?? '—'} · build {r.buildId ?? '—'}</span></div>
    {msg && <Alert kind="info">{msg}</Alert>}
    <div className="row" style={{ margin: '10px 0' }}><button className="btn" onClick={async () => { const e = await post<{ result: string }>(`/api/v1/projects/${projectId}/releases/${rcId}/evaluate`); setMsg(`Gate: ${e.result}`); rc.reload(); }}>Gate を評価</button>{canApprove && r.status !== 'released' && <button className="btn primary" onClick={async () => { if (!window.confirm('リリースを承認しますか？（人間の判断として記録されます）')) return; try { const x = await post<{ gate: string }>(`/api/v1/projects/${projectId}/releases/${rcId}/release`, { note: window.prompt('メモ（任意）') ?? undefined }); setMsg(`承認しました（gate ${x.gate}）`); rc.reload(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } }}>✅ リリースを承認（人間）</button>}{canApprove && <button className="btn" onClick={() => setRisk(true)}>Accepted Risk を登録</button>}<button className="btn" onClick={async () => { const rep = await post<{ artifactId: string }>(`/api/v1/projects/${projectId}/releases/${rcId}/report`, { format: 'html' }); window.open(`/api/v1/artifacts/${rep.artifactId}/download`, '_blank'); rc.reload(); }}>📄 Evidence Report（HTML）</button><a className="btn" href={`/api/v1/projects/${projectId}/releases/${rcId}/report-preview`} target="_blank" rel="noreferrer">プレビュー</a></div>
    <h3>Gate 結果 {ev && <Badge v={ev.result} />}</h3>
    {ev ? <ul>{ev.rules.map((x, i) => <li key={i}>{x.pass ? '✅' : '❌'} {x.message}</li>)}</ul> : <p className="muted">未評価。「Gate を評価」を押してください。</p>}
    {ev && <p className="muted small">評価: {fmtDate(ev.createdAt)} by {ev.evaluatedByKind}。AI は評価の入力にも承認者にもなりません。</p>}
    <h3>この候補に紐付く Run</h3><ul className="small">{(r.runs ?? []).map((x) => <li key={x.id}><Link to={`/projects/${projectId}/runs/${x.id}`}>{x.id.slice(-8)}</Link> <Badge v={x.status} /> {fmtDate(x.completed_at)}</li>)}{(r.runs ?? []).length === 0 && <li className="muted">なし — テスト実行時に「リリース候補」を指定するか CLI の --release を使ってください</li>}</ul>
    <h3>Accepted Risk</h3>{(r.acceptedRisks ?? []).length ? <ul className="small">{(r.acceptedRisks ?? []).map((x, i) => <li key={i}>{String(x.defect_key)} {String(x.defect_title)} — {String(x.reason)}（影響: {String(x.impact)}、承認: {String(x.approver_name ?? x.approver_user_id)}、見直し: {String(x.review_date)}）</li>)}</ul> : <p className="muted small">なし</p>}
    {risk && <div className="panel"><Form submitLabel="登録" onSubmit={async (v) => { await post(`/api/v1/projects/${projectId}/releases/${rcId}/accepted-risks`, { defectId: v.defectId, reason: v.reason, reviewDate: v.reviewDate, impact: v.impact }); setRisk(false); rc.reload(); }}>
      <label>不具合<select name="defectId" required>{(defects.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.key} {d.title} ({d.severity}, {d.status})</option>)}</select></label>
      <label>理由（必須）<textarea name="reason" required /></label><label>影響<input name="impact" required /></label><label>見直し日<input name="reviewDate" type="date" required /></label>
    </Form></div>}
    <h3>Evidence Report</h3><ul className="small">{(r.reports ?? []).map((x) => <li key={x.id}><a href={`/api/v1/artifacts/${x.artifactId}/download`}>{x.format} {fmtDate(x.generatedAt)}</a> <code>{x.checksum.slice(0, 12)}</code></li>)}</ul>
    <p className="muted small">レポートはテスト実行結果の記録であり、品質保証証明書ではありません。</p>
  </Drawer>;
}
