import { useEffect, useState } from 'react';
import { get, post, fmtDate, fmtBytes, type Run, type RunDetail, type Result, type Suite, type Scenario, type Environment, type Project, type Artifact } from '../api.js';
import { Link, useQuery, useRouter } from '../router.js';
import { useAsync, Badge, Drawer, Alert, Form } from '../components/ui.js';
import type { Session } from '../App.js';

export function RunsPage({ s, projectId }: { s: Session; projectId: string }) {
  const q = useQuery(); const { navigate } = useRouter();
  const runs = useAsync(() => get<Run[]>(`/api/v1/projects/${projectId}/runs?limit=100`), [projectId]);
  const suites = useAsync(() => get<Suite[]>(`/api/v1/projects/${projectId}/suites`), [projectId]);
  const scenarios = useAsync(() => get<Scenario[]>(`/api/v1/projects/${projectId}/scenarios`), [projectId]);
  const proj = useAsync(() => get<Project & { environments: Environment[] }>(`/api/v1/projects/${projectId}`), [projectId]);
  const [newOpen, setNewOpen] = useState(q.get('new') === '1');
  const canRun = s.role !== 'viewer';
  return <>
    <header className="top"><h1>テスト実行</h1>{canRun && <button className="btn primary" onClick={() => setNewOpen(true)}>▶ 新しい実行</button>}</header>
    <div className="table-wrap"><table><thead><tr><th>状態</th><th>内容</th><th>環境</th><th>結果</th><th>トリガー</th><th>commit</th><th>開始</th></tr></thead><tbody>
      {(runs.data ?? []).map((r) => <tr key={r.id}><td><Badge v={r.status} /></td><td><Link to={`/projects/${projectId}/runs/${r.id}`}>{r.label ?? (r.suiteId ? suites.data?.find((x) => x.id === r.suiteId)?.name ?? 'suite' : 'シナリオ')}</Link> <span className="muted small">{r.kind}</span></td><td className="small">{proj.data?.environments.find((e) => e.id === r.environmentId)?.name ?? ''}</td><td className="small">✓{r.counts.passed ?? 0} ⚠{(r.counts.flaky ?? 0) + (r.counts.passedAfterRetry ?? 0)} ✗{r.counts.failed ?? 0} 🛠{r.counts.infraError ?? 0} / {r.counts.total ?? 0}</td><td className="small">{r.trigger}</td><td className="small"><code>{r.commitSha?.slice(0, 8) ?? ''}</code> {r.branch ?? ''}</td><td className="small">{fmtDate(r.createdAt)}</td></tr>)}
    </tbody></table></div>
    {runs.data?.length === 0 && <p className="muted">まだ実行がありません。</p>}
    {newOpen && proj.data && <Drawer title="テストを実行" onClose={() => setNewOpen(false)}>
      <Alert kind="info">production 環境では破壊的（書き込み）シナリオは実行されません。runner が起動していることを確認してください（組織設定 → Runner）。</Alert>
      <Form submitLabel="キューに入れる" onSubmit={async (v) => { const body: Record<string, unknown> = { environmentId: v.environmentId, trigger: 'manual', commitSha: v.commitSha || undefined, label: v.label || undefined }; if (v.suiteId) body.suiteId = v.suiteId; else body.scenarioIds = [v.scenarioId]; if (v.mobile === 'on') body.matrix = { browsers: ['chromium'], viewports: [{ width: 1280, height: 800, name: 'desktop' }, { width: 390, height: 664, name: 'iphone13', isMobile: true, hasTouch: true }], retries: 1, video: 'on_failure', trace: 'on_failure' }; const run = await post<Run>(`/api/v1/projects/${projectId}/runs`, body); navigate(`/projects/${projectId}/runs/${run.id}`); }}>
        <label>環境<select name="environmentId" defaultValue={proj.data.defaultEnvironmentId ?? proj.data.environments[0]?.id} required>{proj.data.environments.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.kind})</option>)}</select></label>
        <label>スイート<select name="suiteId" defaultValue={q.get('suite') ?? ''}><option value="">（単一シナリオ）</option>{(suites.data ?? []).map((su) => <option key={su.id} value={su.id}>{su.name} ({su.scenarioIds.length})</option>)}</select></label>
        <label>シナリオ（スイート未選択時）<select name="scenarioId" defaultValue={q.get('scenario') ?? ''}><option value="">—</option>{(scenarios.data ?? []).map((sc) => <option key={sc.id} value={sc.id}>{sc.key} {sc.title}</option>)}</select></label>
        <label className="inline"><input type="checkbox" name="mobile" style={{ width: 'auto' }} /> PC + iPhone 相当画面で実行（単一シナリオ時）</label>
        <label>ラベル（任意）<input name="label" /></label>
        <label>commit SHA（任意）<input name="commitSha" /></label>
      </Form>
    </Drawer>}
  </>;
}

export function RunDetailPage({ s, projectId, runId }: { s: Session; projectId: string; runId: string }) {
  const [run, setRun] = useState<RunDetail | null>(null); const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Result | null>(null);
  const [aiSummary, setAiSummary] = useState<Record<string, unknown> | null>(null);
  const scenarios = useAsync(() => get<Scenario[]>(`/api/v1/projects/${projectId}/scenarios`), [projectId]);
  useEffect(() => {
    let es: EventSource | null = null;
    get<RunDetail>(`/api/v1/runs/${runId}`).then((r) => { setRun(r); if (r.status === 'queued' || r.status === 'running') { es = new EventSource(`/api/v1/runs/${runId}/events`); const refresh = () => get<RunDetail>(`/api/v1/runs/${runId}`).then(setRun); es.addEventListener('job.completed', refresh); es.addEventListener('job.progress', refresh); es.addEventListener('run.completed', () => { refresh(); es?.close(); }); es.addEventListener('run.cancelled', () => { refresh(); es?.close(); }); } }).catch((e) => setErr(e.message));
    return () => es?.close();
  }, [runId]);
  if (err) return <Alert kind="error">{err}</Alert>;
  if (!run) return <p className="muted">読み込み中…</p>;
  const canDefect = s.role !== 'viewer';
  return <>
    <header className="top"><div><Link to={`/projects/${projectId}/runs`}>← 実行一覧</Link><h1>Run {run.label ?? run.id.slice(-8)} <Badge v={run.status} /></h1><div className="muted small">{run.kind} · {run.trigger} · {fmtDate(run.createdAt)}{run.commitSha && <> · <code>{run.commitSha.slice(0, 8)}</code></>}</div></div>
      <div className="row">{(run.status === 'queued' || run.status === 'running') && s.role !== 'viewer' && <button className="btn danger" onClick={async () => { await post(`/api/v1/runs/${runId}/cancel`); setRun(await get<RunDetail>(`/api/v1/runs/${runId}`)); }}>中止</button>}{run.status === 'failed' && canDefect && <button className="btn" onClick={async () => { const r = await post<Run>(`/api/v1/runs/${runId}/retest-failed`, { label: '失敗分の再テスト' }); window.location.assign(`/projects/${projectId}/runs/${r.id}`); }}>失敗分だけ再テスト</button>}</div></header>
    <div className="grid cols-4"><div className="stat"><div className="v" style={{ color: 'var(--ok)' }}>{run.counts.passed ?? 0}</div><div className="l">passed</div></div><div className="stat"><div className="v" style={{ color: 'var(--warn)' }}>{(run.counts.flaky ?? 0) + (run.counts.passedAfterRetry ?? 0)}</div><div className="l">flaky（再試行で成功、Passed に隠しません）</div></div><div className="stat"><div className="v" style={{ color: 'var(--bad)' }}>{run.counts.failed ?? 0}</div><div className="l">failed</div></div><div className="stat"><div className="v">{run.counts.infraError ?? 0}</div><div className="l">infra error（テスト失敗ではなく実行基盤の問題）</div></div></div>
    {(run.status === 'queued' || run.status === 'running') && <Alert kind="info">実行中… {run.counts.queued ?? 0} 待機 / {run.counts.running ?? 0} 実行中（自動更新）</Alert>}
    <div className="table-wrap"><table><thead><tr><th>状態</th><th>シナリオ</th><th>ブラウザ</th><th>画面</th><th>結果詳細</th><th>失敗内容</th><th>証拠</th></tr></thead><tbody>
      {run.results.map((r) => <tr key={r.id}><td><Badge v={r.status} /></td><td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(r); setAiSummary(null); }}>{r.scenario?.key} {r.scenario?.title}</a></td><td className="small">{r.browser} {r.browserVersion?.split('.')[0]}</td><td className="small">{r.viewport.name ?? `${r.viewport.width}×${r.viewport.height}`}</td><td className="small">{r.outcomeDetail}{r.attempts > 1 && ` (${r.attempts} attempts)`}</td><td className="small" style={{ maxWidth: 360 }}>{r.failure && <><Badge v={r.failure.type} /> {r.failure.message.slice(0, 160)}</>}</td><td className="small">{r.artifacts.map((a) => a.kind).filter((v, i, arr) => arr.indexOf(v) === i).join(', ')}</td></tr>)}
      {run.jobs.filter((j) => j.status === 'queued' || j.status === 'leased' || j.status === 'running').map((j) => <tr key={j.id}><td><Badge v={j.status} /></td><td className="muted">{scenarios.data?.find((x) => x.id === (j as unknown as { scenarioId: string }).scenarioId)?.title ?? '…'}</td><td className="small">{j.browser}</td><td colSpan={4} className="muted small">attempt {j.attempt}{j.lastError ? ` — ${j.lastError}` : ''}</td></tr>)}
    </tbody></table></div>
    {open && <ResultDrawer r={open} projectId={projectId} canDefect={canDefect} onClose={() => setOpen(null)} aiSummary={aiSummary} setAiSummary={setAiSummary} />}
  </>;
}

function ResultDrawer({ r, projectId, canDefect, onClose, aiSummary, setAiSummary }: { r: Result; projectId: string; canDefect: boolean; onClose: () => void; aiSummary: Record<string, unknown> | null; setAiSummary: (v: Record<string, unknown> | null) => void }) {
  const { navigate } = useRouter();
  const [tab, setTab] = useState<'steps' | 'evidence' | 'console' | 'network' | 'checks'>('evidence');
  const [aiErr, setAiErr] = useState<string | null>(null);
  const shots = r.artifacts.filter((a) => a.kind === 'screenshot' || a.kind === 'diff');
  const video = r.artifacts.find((a) => a.kind === 'video'); const trace = r.artifacts.find((a) => a.kind === 'trace'); const dom = r.artifacts.find((a) => a.kind === 'dom');
  const url = (a: Artifact) => `/api/v1/artifacts/${a.id}/download`;
  return <Drawer title={`${r.scenario?.key ?? ''} ${r.scenario?.title ?? ''} — ${r.browser} ${r.viewport.name ?? `${r.viewport.width}×${r.viewport.height}`}`} onClose={onClose}>
    <div className="row"><Badge v={r.status} /><span className="muted small">{r.outcomeDetail} · {r.attempts} attempt(s) · {r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : ''}</span></div>
    {r.failure && <div className="alert error"><b>{r.failure.type}</b> ステップ {r.failure.stepIndex !== undefined ? r.failure.stepIndex + 1 : '-'} ({r.failure.stepType}): {r.failure.message}{r.failure.expected !== undefined && <div className="small">期待: {r.failure.expected}<br />実際: {r.failure.actual}</div>}{r.failure.url && <div className="small">URL: {r.failure.url}</div>}</div>}
    {canDefect && r.status !== 'passed' && <div className="row"><button className="btn primary" onClick={async () => { const d = await post<{ id: string }>(`/api/v1/projects/${projectId}/defects/from-result`, { resultId: r.id }); navigate(`/projects/${projectId}/defects/${d.id}`); }}>🐞 この失敗から不具合票を作る</button><button className="btn" onClick={async () => { setAiErr(null); try { const s = await post<{ output: Record<string, unknown> }>(`/api/v1/results/${r.id}/ai/failure-summary`); setAiSummary(s.output); } catch (e) { setAiErr(e instanceof Error ? e.message : String(e)); } }}>✨ AI に要約してもらう</button></div>}
    {aiErr && <Alert kind="warn">{aiErr}</Alert>}
    {aiSummary && <div className="panel"><h3 style={{ marginTop: 0 }}>AI 要約（結果は変更されません）</h3><p>{String(aiSummary.whatFailed)}</p><p className="small">根本原因（確度: <b>{String((aiSummary.rootCause as { confidence: string }).confidence)}</b>）: {String((aiSummary.rootCause as { statement: string }).statement)}</p>{Array.isArray(aiSummary.reproductionHints) && (aiSummary.reproductionHints as string[]).length > 0 && <ul className="small">{(aiSummary.reproductionHints as string[]).map((h, i) => <li key={i}>{h}</li>)}</ul>}</div>}
    <div className="tabs">{(['evidence', 'steps', 'console', 'network', 'checks'] as const).map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{{ evidence: '証拠', steps: 'ステップ', console: 'Console', network: 'Network', checks: 'チェック結果' }[t]}</button>)}</div>
    {tab === 'evidence' && <div className="evidence">
      {shots.length === 0 && !video && !trace && <p className="muted">証拠はありません（成功時は screenshot ステップ分のみ保存）。</p>}
      {shots.map((a) => <div key={a.id} style={{ marginBottom: 12 }}><div className="small muted">{a.kind} {a.label ?? ''} {a.stepIndex !== null ? `(step ${a.stepIndex + 1})` : ''} · {fmtBytes(a.sizeBytes)} {a.restricted && <Badge v="restricted" />}</div><a href={url(a)} target="_blank" rel="noreferrer"><img src={url(a)} alt={`${a.kind} ${a.label ?? ''}`} loading="lazy" /></a></div>)}
      {video && <div><div className="small muted">video · {fmtBytes(video.sizeBytes)}</div><video controls src={url(video)} /></div>}
      <div className="row" style={{ marginTop: 10 }}>{trace && <a className="btn sm" href={url(trace)}>⬇ trace.zip（npx playwright show-trace で再生）</a>}{dom && <a className="btn sm" href={url(dom)} target="_blank" rel="noreferrer">DOM snapshot</a>}{r.artifacts.filter((a) => a.kind === 'download' || a.kind === 'report').map((a) => <a key={a.id} className="btn sm" href={url(a)}>⬇ {a.kind} {a.label}</a>)}</div>
    </div>}
    {tab === 'steps' && <div className="steps">{r.steps.map((st) => <div key={st.index} className={`step ${st.status}`}><div className="n">{st.index + 1}</div><div className="body"><div className="row"><b>{st.type}</b><Badge v={st.status} /><span className="muted small">{st.durationMs}ms</span></div>{st.message && <div className="small" style={{ color: 'var(--bad)' }}>{st.message}</div>}</div></div>)}</div>}
    {tab === 'console' && <pre>{JSON.stringify(r.consoleSummary, null, 2)}</pre>}
    {tab === 'network' && <pre>{JSON.stringify(r.networkSummary, null, 2)}</pre>}
    {tab === 'checks' && <pre>{JSON.stringify({ checks: r.checks, metrics: r.metrics }, null, 2)}</pre>}
  </Drawer>;
}
