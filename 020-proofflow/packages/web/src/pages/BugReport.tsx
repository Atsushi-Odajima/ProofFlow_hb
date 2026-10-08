// ProofFlow 不具合報告 (merged from ErrorRelay): report form (internal + public intake), report list, intake management.
// The masked preview is computed in the browser with the same library the server applies before storing (ProofFlow 個人情報マスク).
import { useEffect, useMemo, useState } from 'react';
import * as br from '@proofflow/shared/bugreport';
import { ApiError, get, post, del, fmtDate, type Release, type Environment } from '../api.js';
import { Link } from '../router.js';
import { useAsync, Badge, Alert, Tabs, Drawer, Form, Empty } from '../components/ui.js';
import type { Session } from '../App.js';

type Category = br.FindingCategory;
interface Uploaded { id: string; fileName: string; kind: string; processing: Record<string, unknown> }
interface Similar { defectId: string; key: string; title: string; status: string; similarity: number }
interface SubmitResult { id: string; key: string; status: string; defectId?: string; replayed: boolean; similar?: Similar[] }
interface BugReportRow { id: string; key: string; title: string; source: string; status: string; defectId: string | null; defectKey: string | null; createdAt: string; redaction: br.RedactionSummary | null; similar: Similar[] }

/** Transport: internal pages use the session cookie; the public intake form adds its token header. */
interface Transport { preview: string; upload: string; submit: string; headers: Record<string, string> }
async function call<T>(method: string, url: string, headers: Record<string, string>, body?: unknown, raw?: { contentType: string; data: Blob }): Promise<T> {
  const h: Record<string, string> = { ...headers };
  let payload: BodyInit | undefined;
  if (raw) { h['content-type'] = raw.contentType; payload = raw.data; } else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers: h, body: payload, credentials: 'same-origin' });
  const text = await res.text(); let json: { data?: T; error?: { code: string; message: string; details?: unknown } } = {};
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) throw new ApiError(res.status, json.error?.code ?? 'http_error', json.error?.message ?? `HTTP ${res.status}`, json.error?.details);
  return json.data as T;
}
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** Non PNG/JPEG images are re-encoded to PNG in the browser (drops metadata, ErrorRelay behaviour). */
async function normalizeImage(f: File): Promise<{ blob: Blob; type: string; name: string }> {
  if (f.type === 'image/png' || f.type === 'image/jpeg' || !f.type.startsWith('image/')) return { blob: f, type: f.type || 'text/plain', name: f.name };
  const bmp = await createImageBitmap(f);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d')!.drawImage(bmp, 0, 0);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('cannot encode image'))), 'image/png'));
  return { blob, type: 'image/png', name: f.name.replace(/\.[^.]+$/, '') + '.png' };
}

export function BugReportForm({ t, internal, releases, environments, defaultLang = 'ja', onDone }: { t: Transport; internal: boolean; releases?: Release[]; environments?: Environment[]; defaultLang?: br.Lang; onDone?: (r: SubmitResult) => void }) {
  const [lang, setLang] = useState<br.Lang>(defaultLang);
  const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [expected, setExpected] = useState(''); const [actual, setActual] = useState('');
  const [steps, setSteps] = useState<string[]>(['']); const [errorText, setErrorText] = useState(''); const [frequency, setFrequency] = useState<br.Frequency>('unknown');
  const [occurredAt, setOccurredAt] = useState<br.Timestamp | null>(null); const [manualTime, setManualTime] = useState(''); const tz = useMemo(() => br.detectTimeZone(), []);
  const [env, setEnv] = useState<br.ReportEnvironment>(() => br.captureBrowserEnvironment({ userAgent: navigator.userAgent, language: navigator.language, onLine: navigator.onLine, platform: navigator.platform, innerWidth: window.innerWidth, innerHeight: window.innerHeight, standalone: window.matchMedia?.('(display-mode: standalone)').matches, href: internal ? undefined : document.referrer || undefined }));
  const [reporterName, setReporterName] = useState(''); const [notes, setNotes] = useState('');
  const [decisions, setDecisions] = useState<Partial<Record<Category, 'redact' | 'keep'>>>({});
  const [files, setFiles] = useState<Uploaded[]>([]); const [uploading, setUploading] = useState(false);
  const [severity, setSeverity] = useState('medium'); const [priority, setPriority] = useState('p2'); const [rcId, setRcId] = useState(''); const [envId, setEnvId] = useState(''); const [existingDefectId, setExistingDefectId] = useState('');
  const [questions, setQuestions] = useState<string[]>([]); const [similar, setSimilar] = useState<Similar[] | null>(null);
  const [reviewed, setReviewed] = useState(false); const [idemKey, setIdemKey] = useState(newKey); const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState<SubmitResult | null>(null);

  const content: br.BugReportContent = { title, description, expected, actual, steps: steps.map((s) => s.trim()).filter(Boolean), errorText, frequency, occurredAt, environment: env, reporterName, additionalNotes: notes, language: lang };
  const masked = useMemo(() => br.sanitizeReport(content, decisions), [JSON.stringify(content), JSON.stringify(decisions)]); // eslint-disable-line react-hooks/exhaustive-deps
  const md = useMemo(() => br.generateDetailed(masked.content, lang, { attachments: files.map((f) => ({ fileName: f.fileName, redacted: true })), redaction: masked.summary }), [masked, lang, files]);
  const quality = br.checkReportQuality(masked.content, { attachments: files.length });
  const categories = [...new Set(masked.findings.map((f) => f.category))];
  useEffect(() => { setReviewed(false); }, [JSON.stringify(content), JSON.stringify(decisions)]); // eslint-disable-line react-hooks/exhaustive-deps
  const setEnvField = (k: br.EnvKey, v: string) => setEnv((e) => ({ ...e, [k]: v ? br.manualField(v) : br.unknownEnv() }));

  const upload = async (list: FileList | null) => {
    if (!list) return; setUploading(true); setErr(null);
    try {
      for (const f of Array.from(list).slice(0, 10 - files.length)) {
        const n = await normalizeImage(f);
        const r = await call<Uploaded>('PUT', `${t.upload}?fileName=${encodeURIComponent(n.name)}`, t.headers, undefined, { contentType: n.type, data: n.blob });
        setFiles((p) => [...p, r]);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setUploading(false); }
  };
  const submit = async () => {
    setBusy(true); setErr(null);
    const body = { ...content, environment: Object.fromEntries(Object.entries(env).filter(([, f]) => f.source !== 'unknown')), idempotencyKey: idemKey, attachmentIds: files.map((f) => f.id), decisions, ...(internal ? { severity, priority, releaseCandidateId: rcId || undefined, environmentId: envId || undefined, existingDefectId: existingDefectId || undefined } : {}) };
    try {
      // The same idempotency key is reused on retry (network errors), so a report is never filed twice.
      const r = await call<SubmitResult>('POST', t.submit, t.headers, body);
      setDone(r); onDone?.(r); setIdemKey(newKey());
    } catch (e) { setErr(e instanceof ApiError ? `${e.message}${e.details ? ' ' + JSON.stringify(e.details).slice(0, 300) : ''}` : e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (done) return <div className="panel">
    <Alert kind="ok">{done.replayed ? '同じ報告は受付済みです（二重登録はされません）。' : '不具合報告を受け付けました。'} 受付番号: <b>{done.key}</b></Alert>
    {internal && done.defectId && <p>Defect: <Link to={`${location.pathname.replace(/\/bug-reports.*$/, '')}/defects/${done.defectId}`}>不具合票を開く</Link>{done.status === 'attached_to_defect' && '（既存の不具合に証跡として追加）'}</p>}
    <button className="btn" onClick={() => { setDone(null); setTitle(''); setDescription(''); setExpected(''); setActual(''); setSteps(['']); setErrorText(''); setFiles([]); setOccurredAt(null); setNotes(''); setSimilar(null); setExistingDefectId(''); }}>続けて報告する</button>
  </div>;

  return <div className="grid cols-2 bugreport">
    <div className="panel">
      <h3>1. 何が起きたか</h3>
      <form className="f" onSubmit={(e) => e.preventDefault()}>
        <label>件名<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} placeholder="例: 決済ボタンを押しても反応しない" /></label>
        <label>何が起きたか（文章でそのまま）<textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="例: カートを開いて支払うを押したら何も起きなかった" /></label>
        <div className="row"><button type="button" className="btn sm" onClick={() => { const r = br.buildReproFromText(description, lang); if (r.steps.length) setSteps(r.steps); if (!actual && r.actual) setActual(r.actual); if (!expected && r.expected) setExpected(r.expected); setQuestions(r.questions); }}>文章から再現手順を作る</button><span className="muted small">作成した手順は必ず確認・修正してください（推測で手順を足しません）。</span></div>
        {questions.length > 0 && <Alert kind="warn">{questions.map((q, i) => <div key={i}>{q}</div>)}</Alert>}
        <fieldset><legend>再現手順</legend>
          {steps.map((s, i) => <div key={i} className="row"><span className="muted">{i + 1}.</span><input aria-label={`手順 ${i + 1}`} value={s} onChange={(e) => setSteps((p) => p.map((x, j) => (j === i ? e.target.value : x)))} style={{ flex: 1 }} />
            <button type="button" className="btn sm" aria-label="上へ" disabled={i === 0} onClick={() => setSteps((p) => { const n = [...p]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; return n; })}>↑</button>
            <button type="button" className="btn sm" aria-label="削除" onClick={() => setSteps((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : ['']))}>✕</button></div>)}
          <button type="button" className="btn sm" onClick={() => setSteps((p) => [...p, ''])} disabled={steps.length >= 50}>＋ 手順を追加</button>
        </fieldset>
        <label>期待する動作<textarea value={expected} onChange={(e) => setExpected(e.target.value)} /></label>
        <label>実際の動作<textarea value={actual} onChange={(e) => setActual(e.target.value)} /></label>
        <label>エラーメッセージ（あれば）<textarea value={errorText} onChange={(e) => setErrorText(e.target.value)} /></label>
        <div className="grid cols-2">
          <label>再現頻度<select value={frequency} onChange={(e) => setFrequency(e.target.value as br.Frequency)}><option value="unknown">不明</option><option value="first_time">初めて</option><option value="sometimes">時々</option><option value="always">毎回</option></select></label>
          <div><span className="small">発生日時（{tz}）</span><div className="row"><button type="button" className="btn sm" onClick={() => setOccurredAt(br.nowTimestamp(tz))}>今起きた</button><input type="datetime-local" aria-label="発生日時" value={manualTime} onChange={(e) => { setManualTime(e.target.value); setOccurredAt(e.target.value ? br.parseManualTimestamp(e.target.value.replace('T', ' '), tz) : null); }} /></div><span className="muted small">{occurredAt ? occurredAt.display : '未入力（不明のまま報告できます）'}</span></div>
        </div>
      </form>
      <h3>2. 環境と添付</h3>
      <form className="f" onSubmit={(e) => e.preventDefault()}>
        <p className="muted small">ブラウザ・OS・画面サイズは自動で取得しています（端末名は推測しません）。必要に応じて修正してください。</p>
        <div className="grid cols-2">{(['browser', 'os', 'osVersion', 'device', 'appVersion', 'pageUrl', 'viewport', 'locale'] as br.EnvKey[]).map((k) => <label key={k}>{br.ENV_LABELS[k].ja}{env[k].source === 'auto' && <span className="muted small"> （自動）</span>}<input value={env[k].value ?? ''} onChange={(e) => setEnvField(k, e.target.value)} /></label>)}</div>
        <label>スクリーンショット・ログ（PNG / JPEG / テキスト、最大 10 件）<input type="file" multiple accept="image/*,.txt,.log,.csv,.json,text/plain,application/json" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} disabled={uploading || files.length >= 10} /></label>
        {files.length > 0 && <ul className="small">{files.map((f) => <li key={f.id}>{f.fileName} — {f.kind === 'screenshot' ? `メタデータ除去: ${((f.processing.metadataRemoved as string[] | undefined) ?? []).join(', ') || 'なし'}` : `マスク: ${JSON.stringify(f.processing.redaction ?? {})}`} <button type="button" className="btn sm" onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))}>外す</button></li>)}</ul>}
        {files.some((f) => f.kind === 'screenshot') && <Alert kind="warn">画像の中身は自動では検出できません。送信前に確認してください: {br.IMAGE_MANUAL_CHECKLIST.map((c) => c.ja).join(' / ')}</Alert>}
        {!internal && <label>お名前（任意）<input value={reporterName} onChange={(e) => setReporterName(e.target.value)} maxLength={100} /></label>}
        <label>補足<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        {internal && <div className="grid cols-2">
          <label>重要度<select value={severity} onChange={(e) => setSeverity(e.target.value)}>{['critical', 'high', 'medium', 'low'].map((x) => <option key={x}>{x}</option>)}</select></label>
          <label>優先度<select value={priority} onChange={(e) => setPriority(e.target.value)}>{['p0', 'p1', 'p2', 'p3'].map((x) => <option key={x}>{x}</option>)}</select></label>
          <label>リリース候補<select value={rcId} onChange={(e) => setRcId(e.target.value)}><option value="">—</option>{(releases ?? []).map((r) => <option key={r.id} value={r.id}>{r.version}</option>)}</select></label>
          <label>環境<select value={envId} onChange={(e) => setEnvId(e.target.value)}><option value="">—</option>{(environments ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        </div>}
      </form>
    </div>
    <div className="panel">
      <h3>3. 個人情報マスクの確認と送信</h3>
      <div className="row"><Tabs tabs={[['ja', '日本語'], ['en', 'English']]} active={lang} onChange={(k) => setLang(k as br.Lang)} /></div>
      <p className="muted small">{br.SCANNER_DISCLAIMER.ja}</p>
      {masked.findings.length === 0 ? <p className="small">検出された個人情報・秘密情報はありません。</p> : <div className="table-wrap"><table><thead><tr><th>種類</th><th>件数</th><th>扱い</th></tr></thead><tbody>{categories.map((c) => <tr key={c}><td>{c}</td><td>{masked.findings.filter((f) => f.category === c).length}</td><td>{br.ALWAYS_REDACT.has(c) ? <span className="muted small">常にマスク</span> : <label className="small"><input type="checkbox" checked={decisions[c] === 'keep'} onChange={(e) => setDecisions((d) => ({ ...d, [c]: e.target.checked ? 'keep' : 'redact' }))} /> そのまま残す</label>}</td></tr>)}</tbody></table></div>}
      <h4>送信される内容（マスク後）</h4>
      <pre className="bugreport-preview" style={{ maxHeight: 360, whiteSpace: 'pre-wrap' }}>{md}</pre>
      <p className="small">{quality.items.filter((i) => i.status !== 'ok').map((i) => <span key={i.id} className={`chip ${i.status}`}>{i.status === 'missing' ? '必須: ' : '推奨: '}{i.label.ja}</span>)}</p>
      {internal && <div><button type="button" className="btn sm" onClick={async () => { try { const r = await call<{ similar: Similar[] }>('POST', t.preview, t.headers, { ...content, environment: {}, decisions }); setSimilar(r.similar); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } }}>既存の不具合と照合</button>
        {similar && (similar.length === 0 ? <p className="small muted">似ている未解決の不具合はありません。</p> : <div><p className="small">{br.KNOWN_ISSUE_NOTE.ja}</p>{similar.map((s) => <label key={s.defectId} className="small" style={{ display: 'block' }}><input type="radio" name="existing" checked={existingDefectId === s.defectId} onChange={() => setExistingDefectId(s.defectId)} /> {s.key} {s.title} <Badge v={s.status} /> 類似度 {Math.round(s.similarity * 100)}%</label>)}<label className="small" style={{ display: 'block' }}><input type="radio" name="existing" checked={!existingDefectId} onChange={() => setExistingDefectId('')} /> 新しい不具合として登録</label></div>)}
      </div>}
      <label className="small" style={{ display: 'block', margin: '10px 0' }}><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> マスク後の内容と添付を確認しました</label>
      {err && <Alert kind="error">{err}</Alert>}
      <button className="btn primary" disabled={busy || uploading || !reviewed || !quality.readyToSend} onClick={() => void submit()}>{busy ? '送信中…' : '不具合報告を送信'}</button>
    </div>
  </div>;
}

export function BugReportsPage({ s, projectId }: { s: Session; projectId: string }) {
  const [tab, setTab] = useState('new');
  const list = useAsync(() => get<BugReportRow[]>(`/api/v1/projects/${projectId}/bug-reports`), [projectId]);
  const releases = useAsync(() => get<Release[]>(`/api/v1/projects/${projectId}/releases`), [projectId]);
  const envs = useAsync(() => get<Environment[]>(`/api/v1/projects/${projectId}/environments`), [projectId]);
  const intakes = useAsync(() => get<Array<{ id: string; name: string; tokenPrefix: string; defaultSeverity: string; defaultPriority: string; maxPerHour: number; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }>>(`/api/v1/projects/${projectId}/bug-intakes`), [projectId]);
  const [open, setOpen] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const canWrite = s.role !== 'viewer';
  const canManage = ['owner', 'admin', 'qa_lead'].includes(s.role);
  const t: Transport = { preview: `/api/v1/projects/${projectId}/bug-reports/preview`, upload: `/api/v1/projects/${projectId}/bug-reports/attachments`, submit: `/api/v1/projects/${projectId}/bug-reports`, headers: {} };
  return <>
    <header className="top"><h1>ProofFlow 不具合報告</h1></header>
    <p className="muted">エラー画面・文章から、発生日時・環境・再現手順をそろえた報告を作り、個人情報マスクをかけてから不具合票（Defect）にします。</p>
    <Tabs tabs={[...(canWrite ? [['new', '新しい報告']] as Array<[string, string]> : []), ['list', `受け付けた報告（${list.data?.length ?? 0}）`], ['intake', '外部受付フォーム']]} active={canWrite ? tab : tab === 'new' ? 'list' : tab} onChange={setTab} />
    {canWrite && tab === 'new' && <BugReportForm t={t} internal releases={releases.data ?? []} environments={envs.data ?? []} onDone={() => list.reload()} />}
    {(tab === 'list' || (!canWrite && tab === 'new')) && (list.data?.length ? <div className="table-wrap"><table><thead><tr><th>受付</th><th>件名</th><th>経路</th><th>不具合票</th><th>マスク</th><th>受付日時</th></tr></thead><tbody>
      {list.data.map((r) => <tr key={r.id}><td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(r.id); }}>{r.key}</a></td><td>{r.title}</td><td><Badge v={r.source} /></td><td>{r.defectId ? <Link to={`/projects/${projectId}/defects/${r.defectId}`}>{r.defectKey ?? 'Defect'}</Link> : '—'}{r.similar.length > 0 && <span className="chip" title="似ている既存の不具合あり">類似 {r.similar.length}</span>}</td><td className="small">{Object.entries(r.redaction?.counts ?? {}).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}</td><td className="small">{fmtDate(r.createdAt)}</td></tr>)}
    </tbody></table></div> : <Empty>まだ報告はありません。</Empty>)}
    {tab === 'intake' && <>
      <Alert kind="info">外部受付フォームは、ログインしていない利用者・テスターから報告を受け付ける URL です。報告は受付フォームに設定した重要度で不具合票になり、報告者には受付番号だけが返ります（既存の不具合は見えません）。</Alert>
      {created && <Alert kind="ok">受付フォームの URL（この画面でしか表示されません）: <code style={{ wordBreak: 'break-all' }}>{created}</code> <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(created)}>コピー</button></Alert>}
      <div className="table-wrap"><table><thead><tr><th>名前</th><th>トークン</th><th>既定の重要度</th><th>上限/時</th><th>最終利用</th><th>状態</th><th></th></tr></thead><tbody>{(intakes.data ?? []).map((i) => <tr key={i.id}><td>{i.name}</td><td className="small">{i.tokenPrefix}…</td><td>{i.defaultSeverity} / {i.defaultPriority}</td><td>{i.maxPerHour}</td><td className="small">{fmtDate(i.lastUsedAt)}</td><td>{i.revokedAt ? <Badge v="revoked" /> : <Badge v="active" />}</td><td>{canManage && !i.revokedAt && <button className="btn sm" onClick={async () => { if (!window.confirm('この受付フォームを無効にしますか？')) return; await del(`/api/v1/projects/${projectId}/bug-intakes/${i.id}`); intakes.reload(); }}>無効化</button>}</td></tr>)}</tbody></table></div>
      {canManage && <div className="panel"><h3>受付フォームを作る</h3><Form submitLabel="作成" onSubmit={async (v) => { const r = await post<{ formUrlPath: string }>(`/api/v1/projects/${projectId}/bug-intakes`, { name: v.name, defaultSeverity: v.defaultSeverity, defaultPriority: v.defaultPriority, releaseCandidateId: v.releaseCandidateId || undefined, maxPerHour: Number(v.maxPerHour || 30) }); setCreated(`${location.origin}${r.formUrlPath}`); intakes.reload(); }}>
        <div className="grid cols-3"><label>名前<input name="name" required placeholder="β版テスター用" /></label><label>既定の重要度<select name="defaultSeverity" defaultValue="medium">{['critical', 'high', 'medium', 'low'].map((x) => <option key={x}>{x}</option>)}</select></label><label>既定の優先度<select name="defaultPriority" defaultValue="p2">{['p0', 'p1', 'p2', 'p3'].map((x) => <option key={x}>{x}</option>)}</select></label><label>リリース候補<select name="releaseCandidateId" defaultValue=""><option value="">—</option>{(releases.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.version}</option>)}</select></label><label>1 時間あたりの上限<input name="maxPerHour" type="number" min={1} max={1000} defaultValue={30} /></label></div>
      </Form></div>}
    </>}
    {open && <BugReportDrawer projectId={projectId} id={open} onClose={() => setOpen(null)} />}
  </>;
}

function BugReportDrawer({ projectId, id, onClose }: { projectId: string; id: string; onClose: () => void }) {
  const r = useAsync(() => get<{ key: string; title: string; source: string; report: { ja: string; en: string }; defect: { id: string; key: string; status: string } | null; similar: Similar[]; attachments: Array<{ artifactId: string; fileName: string; contentType: string }>; findings: br.PublicFinding[] }>(`/api/v1/projects/${projectId}/bug-reports/${id}`), [id]);
  const [lang, setLang] = useState<br.Lang>('ja');
  const x = r.data; if (!x) return null;
  return <Drawer title={`${x.key} ${x.title}`} onClose={onClose}>
    <div className="row"><Badge v={x.source} />{x.defect && <Link to={`/projects/${projectId}/defects/${x.defect.id}`}>{x.defect.key}</Link>}{x.defect && <Badge v={x.defect.status} />}<a className="btn sm" href={`/api/v1/projects/${projectId}/bug-reports/${id}/report?lang=${lang}`}>⬇ Markdown</a></div>
    {x.similar.length > 0 && <Alert kind="warn">似ている既存の不具合: {x.similar.map((s) => <Link key={s.defectId} to={`/projects/${projectId}/defects/${s.defectId}`}> {s.key}（{Math.round(s.similarity * 100)}%）</Link>)}</Alert>}
    <Tabs tabs={[['ja', '日本語'], ['en', 'English']]} active={lang} onChange={(k) => setLang(k as br.Lang)} />
    <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 420 }}>{x.report[lang]}</pre>
    <h3>添付（証跡）</h3><ul className="small">{x.attachments.map((a) => <li key={a.artifactId}><a href={`/api/v1/artifacts/${a.artifactId}/download`} target="_blank" rel="noreferrer">{a.fileName}</a> <span className="muted">{a.contentType}</span></li>)}</ul>
  </Drawer>;
}

/** Public page: /intake/:intakeId#token=pfi_… (no login). The token stays in the URL fragment, so it never reaches server logs. */
export function PublicIntakePage({ intakeId }: { intakeId: string }) {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
  const headers = { 'x-proofflow-intake-token': token };
  const [info, setInfo] = useState<{ name: string; projectName: string } | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { call<{ name: string; projectName: string }>('GET', `/api/v1/intake/${intakeId}`, headers).then(setInfo).catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'この受付フォームは存在しないか、無効になっています。' : e instanceof ApiError && e.status === 401 ? 'URL が正しくありません（受付トークンがありません）。' : String(e))); }, [intakeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const t: Transport = { preview: `/api/v1/intake/${intakeId}/preview`, upload: `/api/v1/intake/${intakeId}/attachments`, submit: `/api/v1/intake/${intakeId}/bug-reports`, headers };
  return <main className="public-intake">
    <header className="top"><h1>不具合の報告{info ? ` — ${info.projectName}` : ''}</h1></header>
    {err && <Alert kind="error">{err}</Alert>}
    {info && <><p className="muted">{info.name}。入力内容のメールアドレス・電話番号・パスワード・API キー等は送信前に自動でマスクされます（ProofFlow 個人情報マスク）。</p><BugReportForm t={t} internal={false} /></>}
  </main>;
}
