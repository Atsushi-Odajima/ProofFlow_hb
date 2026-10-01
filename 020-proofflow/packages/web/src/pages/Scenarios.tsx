import { useState } from 'react';
import { get, post, patch, del, type Scenario, type Requirement, type Suite } from '../api.js';
import { useQuery, useRouter } from '../router.js';
import { useAsync, Badge, Drawer, Alert, confirmAction } from '../components/ui.js';
import { StepEditor, type Step } from '../components/StepEditor.js';
import type { Session } from '../App.js';

export function ScenariosPage({ s, projectId }: { s: Session; projectId: string }) {
  const q = useQuery(); const { navigate } = useRouter();
  const list = useAsync(() => get<Scenario[]>(`/api/v1/projects/${projectId}/scenarios`), [projectId]);
  const reqs = useAsync(() => get<Requirement[]>(`/api/v1/projects/${projectId}/requirements`), [projectId]);
  const [editing, setEditing] = useState<Partial<Scenario> | null>(q.get('new') || q.get('req') ? { title: '', steps: [{ type: 'navigate', url: '/' }], priority: 'p1', requirementIds: q.get('req') ? [q.get('req')!] : [] } : null);
  const [ai, setAi] = useState<{ id: string; drafts: Array<{ title: string; steps: Step[]; expected: string | null; expectedSource: string; priority: string; rationale?: string }> } | null>(null);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const canWrite = s.role !== 'viewer';
  const save = async (sc: Partial<Scenario>, reason?: string) => {
    const body = { title: sc.title, description: sc.description, steps: sc.steps, expected: sc.expected ?? undefined, priority: sc.priority ?? 'p2', tags: sc.tags ?? [], requirementIds: sc.requirementIds ?? [], changeReason: reason };
    if (sc.id) await patch(`/api/v1/projects/${projectId}/scenarios/${sc.id}`, body); else await post(`/api/v1/projects/${projectId}/scenarios`, body);
    setEditing(null); list.reload();
  };
  return <>
    <header className="top"><h1>テストシナリオ</h1>{canWrite && <div className="row"><button className="btn" onClick={async () => { const prompt = window.prompt('何をテストしますか？（例: 会員登録をテスト）'); if (!prompt) return; setAiErr(null); try { const r = await post<{ id: string; output: { drafts: never[] } }>(`/api/v1/projects/${projectId}/ai/scenario-draft`, { prompt, count: 6 }); setAi({ id: r.id, drafts: r.output.drafts }); } catch (e) { setAiErr(e instanceof Error ? e.message : String(e)); } }}>✨ AI に下書きを頼む</button><button className="btn primary" onClick={() => setEditing({ title: '', steps: [{ type: 'navigate', url: '/' }], priority: 'p1', requirementIds: [] })}>＋ 新規シナリオ</button></div>}</header>
    {aiErr && <Alert kind="warn">{aiErr}（組織設定で AI を有効にしてください。AI は提案のみで、期待値を勝手に決めません）</Alert>}
    <div className="table-wrap"><table><thead><tr><th>Key</th><th>タイトル</th><th>優先度</th><th>ステップ</th><th>v</th><th>状態</th><th>要件</th><th></th></tr></thead><tbody>
      {(list.data ?? []).map((sc) => <tr key={sc.id}><td><a href="#" onClick={(e) => { e.preventDefault(); setEditing(sc); }}>{sc.key}</a></td><td>{sc.title}{sc.destructive && <span className="chip" title="破壊的（書き込み）操作を含む">破壊的</span>}{sc.origin === 'ai_draft' && <span className="chip">AI 下書き</span>}</td><td><Badge v={sc.priority} /></td><td>{sc.steps.length}</td><td>{sc.version}</td><td><Badge v={sc.status} /></td><td>{sc.requirementIds.length}</td><td className="row"><button className="btn sm" onClick={() => navigate(`/projects/${projectId}/runs?new=1&scenario=${sc.id}`)}>▶ 実行</button></td></tr>)}
    </tbody></table></div>
    {list.data?.length === 0 && <p className="muted">まだシナリオがありません。「新規シナリオ」か「AI に下書きを頼む」から始めてください。</p>}
    {editing && <ScenarioEditor sc={editing} reqs={reqs.data ?? []} onClose={() => setEditing(null)} onSave={save} canWrite={canWrite} projectId={projectId} onDelete={async () => { if (editing.id && confirmAction('このシナリオを削除/アーカイブしますか？')) { await del(`/api/v1/projects/${projectId}/scenarios/${editing.id}`); setEditing(null); list.reload(); } }} />}
    {ai && <Drawer title="AI 下書き（提案）" onClose={() => setAi(null)}>
      <Alert kind="info">仕様に無い期待値は「要確認」のままです。採用する下書きを選んで作成してください（status は draft になります）。</Alert>
      {ai.drafts.map((d, i) => <div key={i} className="panel"><div className="row"><b>{d.title}</b><Badge v={d.priority} /><span className="chip">{d.steps.length} steps</span>{d.expectedSource === 'unspecified' ? <span className="badge warning">期待値 要確認</span> : <span className="muted">期待: {d.expected}</span>}</div>{d.rationale && <p className="muted small">{d.rationale}</p>}<button className="btn sm" onClick={async () => { await post(`/api/v1/projects/${projectId}/ai/suggestions/${ai.id}/apply`, { indexes: [i] }); list.reload(); }}>この下書きを採用</button></div>)}
      <button className="btn primary" onClick={async () => { await post(`/api/v1/projects/${projectId}/ai/suggestions/${ai.id}/apply`, {}); setAi(null); list.reload(); }}>すべて採用（draft として作成）</button>
    </Drawer>}
  </>;
}

function ScenarioEditor({ sc, reqs, onClose, onSave, onDelete, canWrite, projectId }: { sc: Partial<Scenario>; reqs: Requirement[]; onClose: () => void; onSave: (s: Partial<Scenario>, reason?: string) => Promise<void>; onDelete: () => Promise<void>; canWrite: boolean; projectId: string }) {
  const [draft, setDraft] = useState<Partial<Scenario>>({ ...sc, steps: (sc.steps ?? []) as Step[] });
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const versions = useAsync(() => sc.id ? get<Array<{ version: number; changeReason: string | null; createdAt: string; changedBy: string | null }>>(`/api/v1/projects/${projectId}/scenarios/${sc.id}/versions`) : Promise.resolve([]), [sc.id]);
  const suites = useAsync(() => get<Suite[]>(`/api/v1/projects/${projectId}/suites`), [projectId]);
  return <Drawer title={sc.id ? `${sc.key} を編集（v${sc.version}）` : '新規シナリオ'} onClose={onClose}>
    <div style={{ display: 'grid', gap: 10 }}>
      <label className="muted small">タイトル<input value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} readOnly={!canWrite} style={{ width: '100%', padding: 8, border: '1px solid var(--line)', borderRadius: 8 }} /></label>
      <div className="grid cols-2"><label className="muted small">優先度<select value={draft.priority ?? 'p2'} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} disabled={!canWrite} style={{ width: '100%', padding: 8 }}>{['p0', 'p1', 'p2', 'p3'].map((p) => <option key={p}>{p}</option>)}</select></label>
      <label className="muted small">要件<select multiple value={draft.requirementIds ?? []} onChange={(e) => setDraft({ ...draft, requirementIds: Array.from(e.target.selectedOptions).map((o) => o.value) })} disabled={!canWrite} style={{ width: '100%', minHeight: 60 }}>{reqs.map((r) => <option key={r.id} value={r.id}>{r.key} {r.title}</option>)}</select></label></div>
      <label className="muted small">期待する結果（仕様から。AI は決めません）<textarea value={draft.expected ?? ''} onChange={(e) => setDraft({ ...draft, expected: e.target.value })} readOnly={!canWrite} style={{ width: '100%', minHeight: 50, padding: 8, border: '1px solid var(--line)', borderRadius: 8 }} /></label>
      <h3>ステップ（開く → 操作 → 確認）</h3>
      <StepEditor steps={(draft.steps ?? []) as Step[]} onChange={(st) => setDraft({ ...draft, steps: st })} readOnly={!canWrite} />
      {sc.id && <label className="muted small">変更理由（履歴に残ります）<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例: 仕様変更 #12 に対応" style={{ width: '100%', padding: 8, border: '1px solid var(--line)', borderRadius: 8 }} /></label>}
      {err && <Alert kind="error">{err}</Alert>}
      {canWrite && <div className="row"><button className="btn primary" onClick={async () => { setErr(null); try { await onSave(draft, reason || undefined); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } }}>保存</button>{sc.id && <button className="btn danger" onClick={onDelete}>削除</button>}{sc.id && suites.data && suites.data.length > 0 && <select defaultValue="" onChange={async (e) => { const su = suites.data!.find((x) => x.id === e.target.value); if (!su) return; await patch(`/api/v1/projects/${projectId}/suites/${su.id}`, { scenarioIds: [...new Set([...su.scenarioIds, sc.id!])] }); alert(`スイート「${su.name}」に追加しました`); }}><option value="">スイートに追加…</option>{suites.data.map((su) => <option key={su.id} value={su.id}>{su.name}</option>)}</select>}</div>}
      {versions.data && versions.data.length > 0 && <><h3>変更履歴</h3><ul className="small">{versions.data.map((v) => <li key={v.version}>v{v.version} — {v.changeReason ?? '（理由なし）'} <span className="muted">{v.createdAt.slice(0, 16)}</span></li>)}</ul></>}
    </div>
  </Drawer>;
}
