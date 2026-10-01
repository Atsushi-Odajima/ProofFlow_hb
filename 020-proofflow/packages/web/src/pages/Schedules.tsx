import { get, post, patch, del, fmtDate, type Suite, type Environment, type Project } from '../api.js';
import { useAsync, Form, Badge, confirmAction } from '../components/ui.js';
import type { Session } from '../App.js';

export function SchedulesPage({ s, projectId }: { s: Session; projectId: string }) {
  const list = useAsync(() => get<Array<{ id: string; label: string | null; cron: string; timezone: string; enabled: boolean; priority: number; overlap_policy: string; next_run_at: string | null; last_fired_at: string | null; suite_id: string; environment_id: string }>>(`/api/v1/projects/${projectId}/schedules`), [projectId]);
  const suites = useAsync(() => get<Suite[]>(`/api/v1/projects/${projectId}/suites`), [projectId]);
  const proj = useAsync(() => get<Project & { environments: Environment[] }>(`/api/v1/projects/${projectId}`), [projectId]);
  const canWrite = ['owner', 'admin', 'qa_lead'].includes(s.role);
  return <>
    <header className="top"><h1>スケジュール（Nightly / Weekly / リリース前）</h1></header>
    <div className="table-wrap"><table><thead><tr><th>ラベル</th><th>cron</th><th>TZ</th><th>スイート</th><th>環境</th><th>次回</th><th>前回</th><th>重複時</th><th>有効</th><th></th></tr></thead><tbody>
      {(list.data ?? []).map((x) => <tr key={x.id}><td>{x.label}</td><td><code>{x.cron}</code></td><td className="small">{x.timezone}</td><td className="small">{suites.data?.find((su) => su.id === x.suite_id)?.name}</td><td className="small">{proj.data?.environments.find((e) => e.id === x.environment_id)?.name}</td><td className="small">{fmtDate(x.next_run_at)}</td><td className="small">{fmtDate(x.last_fired_at)}</td><td className="small">{x.overlap_policy === 'skip' ? 'スキップ' : 'キュー'}</td><td><Badge v={x.enabled ? 'active' : 'disabled'} /></td><td className="row">{canWrite && <><button className="btn sm" onClick={async () => { await patch(`/api/v1/projects/${projectId}/schedules/${x.id}`, { enabled: !x.enabled }); list.reload(); }}>{x.enabled ? '無効化' : '有効化'}</button><button className="btn sm danger" onClick={async () => { if (confirmAction('削除しますか？')) { await del(`/api/v1/projects/${projectId}/schedules/${x.id}`); list.reload(); } }}>削除</button></>}</td></tr>)}
    </tbody></table></div>
    {canWrite && proj.data && <div className="panel"><h3>スケジュールを追加</h3><Form submitLabel="追加" onSubmit={async (v) => { await post(`/api/v1/projects/${projectId}/schedules`, { suiteId: v.suiteId, environmentId: v.environmentId, cron: v.cron, timezone: v.timezone, priority: Number(v.priority), overlapPolicy: v.overlapPolicy, label: v.label || undefined, enabled: true }); list.reload(); }}>
      <div className="grid cols-3"><label>ラベル<input name="label" placeholder="Nightly Critical" /></label><label>cron（分 時 日 月 曜日）<input name="cron" required defaultValue="0 3 * * *" /></label><label>タイムゾーン<input name="timezone" defaultValue="Asia/Tokyo" /></label><label>スイート<select name="suiteId" required>{(suites.data ?? []).map((su) => <option key={su.id} value={su.id}>{su.name}</option>)}</select></label><label>環境<select name="environmentId" required>{proj.data.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label><label>優先度（0-9）<input name="priority" type="number" defaultValue={2} min={0} max={9} /></label><label>同じ Run が実行中なら<select name="overlapPolicy" defaultValue="skip"><option value="skip">スキップ（重複防止）</option><option value="queue">キューに追加</option></select></label></div>
      <p className="muted small">例: 毎晩 3 時 <code>0 3 * * *</code>、平日 9 時 <code>0 9 * * 1-5</code>、毎週月曜 <code>0 6 * * 1</code>。サーバー停止中に逃した分は 1 回にまとめて実行されます。</p>
    </Form></div>}
    <div className="panel"><h3>CI からの実行</h3><p className="small">GitHub Actions 等からは CLI を使います: <code>proofflow run --project {s.project?.slug ?? 'my-app'} --suite critical --env staging --wait</code>（<code>deploy/github-actions/proofflow.yml</code> 参照）。</p></div>
  </>;
}
