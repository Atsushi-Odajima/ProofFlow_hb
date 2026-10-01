import { useState } from 'react';
import { get, post, patch, del, type Suite, type Scenario } from '../api.js';
import { useRouter } from '../router.js';
import { useAsync, Form, Badge, Drawer, confirmAction } from '../components/ui.js';
import type { Session } from '../App.js';

const PRESET_VIEWPORTS = [{ width: 1280, height: 800, name: 'desktop' }, { width: 1024, height: 768, name: 'tablet' }, { width: 390, height: 664, name: 'iphone13', isMobile: true, hasTouch: true }, { width: 412, height: 839, name: 'pixel7', isMobile: true, hasTouch: true }];

export function SuitesPage({ s, projectId }: { s: Session; projectId: string }) {
  const { navigate } = useRouter();
  const suites = useAsync(() => get<Suite[]>(`/api/v1/projects/${projectId}/suites`), [projectId]);
  const scenarios = useAsync(() => get<Scenario[]>(`/api/v1/projects/${projectId}/scenarios`), [projectId]);
  const [open, setOpen] = useState<Suite | null>(null);
  const canWrite = s.role !== 'viewer';
  return <>
    <header className="top"><h1>スイート（Smoke / Critical / Visual / Mobile / API…）</h1></header>
    <div className="table-wrap"><table><thead><tr><th>名前</th><th>種類</th><th>シナリオ</th><th>ブラウザ</th><th>画面</th><th>リリース必須</th><th></th></tr></thead><tbody>
      {(suites.data ?? []).map((su) => <tr key={su.id}><td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(su); }}>{su.name}</a></td><td><Badge v={su.kind} /></td><td>{su.scenarioIds.length}</td><td>{su.matrix.browsers.join(', ')}</td><td>{su.matrix.viewports.map((v) => v.name ?? `${v.width}x${v.height}`).join(', ')}</td><td>{su.requiredForRelease ? '✓' : ''}</td><td><button className="btn sm primary" onClick={() => navigate(`/projects/${projectId}/runs?new=1&suite=${su.id}`)}>▶ 実行</button></td></tr>)}
    </tbody></table></div>
    {canWrite && <div className="panel"><h3>スイートを追加</h3><Form submitLabel="作成" onSubmit={async (v) => { const vps = PRESET_VIEWPORTS.filter((p) => v[`vp_${p.name}`] === 'on'); await post(`/api/v1/projects/${projectId}/suites`, { name: v.name, kind: v.kind, requiredForRelease: v.required === 'on', matrix: { browsers: ['chromium', 'firefox', 'webkit'].filter((b) => v[`b_${b}`] === 'on'), viewports: vps.length ? vps : [PRESET_VIEWPORTS[0]], retries: Number(v.retries || 1), video: v.video, trace: 'on_failure' }, scenarioIds: (scenarios.data ?? []).filter((sc) => v[`sc_${sc.id}`] === 'on').map((sc) => sc.id) }); suites.reload(); }}>
      <label>名前<input name="name" required placeholder="Critical" /></label>
      <label>種類<select name="kind" defaultValue="critical">{['smoke', 'critical', 'full_regression', 'visual', 'accessibility', 'api', 'mobile', 'custom'].map((k) => <option key={k}>{k}</option>)}</select></label>
      <div className="inline"><b className="small">ブラウザ</b><label className="inline"><input type="checkbox" name="b_chromium" defaultChecked style={{ width: 'auto' }} /> Chromium</label><label className="inline"><input type="checkbox" name="b_firefox" style={{ width: 'auto' }} /> Firefox</label><label className="inline"><input type="checkbox" name="b_webkit" style={{ width: 'auto' }} /> WebKit（iPhone 実機の代替ではありません）</label></div>
      <div className="inline"><b className="small">画面サイズ</b>{PRESET_VIEWPORTS.map((p) => <label key={p.name} className="inline"><input type="checkbox" name={`vp_${p.name}`} defaultChecked={p.name === 'desktop'} style={{ width: 'auto' }} /> {p.name} {p.width}×{p.height}</label>)}</div>
      <div className="inline"><label className="inline">再試行 <input type="number" name="retries" defaultValue={1} min={0} max={3} style={{ width: 70 }} /></label><label className="inline">動画 <select name="video" defaultValue="on_failure"><option value="off">なし</option><option value="on_failure">失敗時のみ</option><option value="on_retry">再試行/失敗時</option><option value="always">常に（コスト大）</option></select></label><label className="inline"><input type="checkbox" name="required" style={{ width: 'auto' }} /> リリースゲートで必須</label></div>
      <div><b className="small">シナリオ</b><div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 8 }}>{(scenarios.data ?? []).map((sc) => <label key={sc.id} className="inline" style={{ display: 'flex' }}><input type="checkbox" name={`sc_${sc.id}`} style={{ width: 'auto' }} /> {sc.key} {sc.title}</label>)}</div></div>
    </Form></div>}
    {open && <Drawer title={open.name} onClose={() => setOpen(null)}>
      <dl className="kv"><dt>種類</dt><dd>{open.kind}</dd><dt>ブラウザ</dt><dd>{open.matrix.browsers.join(', ')}</dd><dt>画面</dt><dd>{open.matrix.viewports.map((v) => `${v.name ?? ''} ${v.width}×${v.height}`).join(', ')}</dd><dt>再試行</dt><dd>{open.matrix.retries}</dd><dt>動画 / trace</dt><dd>{open.matrix.video} / {open.matrix.trace}</dd></dl>
      <h3>シナリオ</h3>
      {canWrite ? <div style={{ maxHeight: 300, overflow: 'auto' }}>{(scenarios.data ?? []).map((sc) => <label key={sc.id} className="inline" style={{ display: 'flex' }}><input type="checkbox" defaultChecked={open.scenarioIds.includes(sc.id)} onChange={async (e) => { const ids = e.target.checked ? [...open.scenarioIds, sc.id] : open.scenarioIds.filter((x) => x !== sc.id); const u = await patch<Suite>(`/api/v1/projects/${projectId}/suites/${open.id}`, { scenarioIds: ids }); setOpen(u); suites.reload(); }} /> {sc.key} {sc.title}</label>)}</div> : <ul>{open.scenarioIds.map((id) => <li key={id}>{scenarios.data?.find((x) => x.id === id)?.title ?? id}</li>)}</ul>}
      {canWrite && <div className="row" style={{ marginTop: 12 }}><button className="btn danger" onClick={async () => { if (confirmAction('スイートを削除しますか？')) { await del(`/api/v1/projects/${projectId}/suites/${open.id}`); setOpen(null); suites.reload(); } }}>削除</button></div>}
    </Drawer>}
  </>;
}
