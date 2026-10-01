import { useState } from 'react';
import { api, get, post, patch, put, del, type Project, type Environment } from '../api.js';
import { Link, useRouter } from '../router.js';
import { useAsync, Form, Alert, Badge, Tabs, confirmAction } from '../components/ui.js';
import type { Session } from '../App.js';

export function ProjectsPage({ s }: { s: Session }) {
  const { navigate } = useRouter();
  return <>
    <header className="top"><h1>プロジェクト</h1></header>
    <div className="grid cols-2">
      {s.projects.map((p) => <div key={p.id} className="panel"><h3 style={{ marginTop: 0 }}><Link to={`/projects/${p.id}/dashboard`}>{p.name}</Link></h3><div className="muted">{p.slug} · {p.type}</div><div className="row" style={{ marginTop: 8 }}><Link className="btn sm" to={`/projects/${p.id}/runs`}>実行一覧</Link><Link className="btn sm" to={`/projects/${p.id}/settings`}>設定</Link></div></div>)}
      <div className="panel"><h3 style={{ marginTop: 0 }}>新しいプロジェクト</h3>
        <Form submitLabel="作成" onSubmit={async (v) => { const p = await post<Project>(`/api/v1/orgs/${s.orgId}/projects`, { name: v.name, type: v.type, timezone: v.timezone || 'Asia/Tokyo', repositoryUrl: v.repositoryUrl || undefined }); s.reload(); navigate(`/projects/${p.id}/settings`); }}>
          <label>名前<input name="name" required placeholder="例: My SaaS" /></label>
          <label>種類<select name="type" defaultValue="web_app"><option value="website">Website</option><option value="web_app">Web App</option><option value="pwa">PWA</option><option value="api">API</option><option value="mixed">Mixed</option></select></label>
          <label>タイムゾーン<input name="timezone" defaultValue="Asia/Tokyo" /></label>
          <label>リポジトリ URL（任意）<input name="repositoryUrl" placeholder="https://github.com/..." /></label>
        </Form></div>
    </div>
  </>;
}

export function ProjectSettingsPage({ s, projectId }: { s: Session; projectId: string }) {
  const [tab, setTab] = useState('environments');
  const proj = useAsync(() => get<Project & { environments: Environment[]; description?: string }>(`/api/v1/projects/${projectId}`), [projectId]);
  const secrets = useAsync(() => get<Array<{ id: string; name: string; environment_id: string | null; version: number; updated_at: string }>>(`/api/v1/projects/${projectId}/secrets`), [projectId]);
  const domains = useAsync(() => get<Array<{ id: string; hostname: string; method: string; status: string; last_error: string | null }>>(`/api/v1/projects/${projectId}/domains`), [projectId]);
  const fixtures = useAsync(() => get<Array<{ id: string; name: string; content_type: string; size_bytes: number }>>(`/api/v1/projects/${projectId}/fixtures`), [projectId]);
  const [verifyInfo, setVerifyInfo] = useState<string | null>(null);
  const p = proj.data;
  if (!p) return <p className="muted">読み込み中…</p>;
  const canWrite = ['owner', 'admin', 'qa_lead'].includes(s.role);
  return <>
    <header className="top"><h1>{p.name} の設定</h1></header>
    <Tabs tabs={[['environments', '環境'], ['secrets', 'シークレット'], ['domains', 'ドメイン検証'], ['fixtures', 'テストファイル'], ['general', '基本']]} active={tab} onChange={setTab} />
    {tab === 'environments' && <>
      <div className="table-wrap"><table><thead><tr><th>名前</th><th>種類</th><th>Base URL</th><th>破壊的テスト</th><th>ドメイン</th><th></th></tr></thead><tbody>
        {p.environments.map((e) => <tr key={e.id}><td>{e.name}{p.defaultEnvironmentId === e.id && <span className="chip">既定</span>}</td><td><Badge v={e.kind} /></td><td className="small">{e.baseUrl}</td><td><Badge v={e.destructivePolicy === 'deny' ? 'deny' : 'allow'} /></td><td>{e.domainVerified ? <Badge v="verified" /> : e.kind === 'local' ? <span className="muted">不要</span> : <Badge v="unverified" />}</td><td>{canWrite && <button className="btn sm danger" onClick={async () => { if (confirmAction(`環境 ${e.name} を削除しますか？`)) { await del(`/api/v1/projects/${projectId}/environments/${e.id}`); proj.reload(); } }}>削除</button>}</td></tr>)}
      </tbody></table></div>
      {canWrite && <div className="panel"><h3>環境を追加</h3>
        <Form submitLabel="追加" onSubmit={async (v) => { await post(`/api/v1/projects/${projectId}/environments`, { name: v.name, kind: v.kind, baseUrl: v.baseUrl, apiBaseUrl: v.apiBaseUrl || undefined, allowPrivateNetwork: v.allowPrivateNetwork === 'on', authProfile: v.authKind === 'none' ? { kind: 'none' } : { kind: 'password_form', loginUrl: v.loginUrl || '/login', usernameTarget: { label: v.userLabel || 'Email' }, passwordTarget: { label: v.passLabel || 'Password' }, submitTarget: { role: 'button', name: v.submitName || 'Log in' }, usernameSecretRef: v.userSecret || 'LOGIN_EMAIL', passwordSecretRef: v.passSecret || 'LOGIN_PASSWORD', successUrlContains: v.successUrl || undefined }, maskSelectors: v.maskSelectors ? v.maskSelectors.split(',').map((x) => x.trim()).filter(Boolean) : [] }); proj.reload(); }}>
          <label>名前<input name="name" required placeholder="Staging" /></label>
          <label>種類<select name="kind" defaultValue="staging"><option value="local">local（自分の PC、self-hosted runner）</option><option value="preview">preview</option><option value="staging">staging</option><option value="production">production（破壊的テストは既定で禁止）</option></select></label>
          <label>Base URL<input name="baseUrl" required placeholder="https://staging.example.com" /></label>
          <label>API Base URL（任意）<input name="apiBaseUrl" placeholder="https://api-staging.example.com" /></label>
          <label className="inline"><input type="checkbox" name="allowPrivateNetwork" style={{ width: 'auto' }} /> localhost / 社内ネットワークを許可（local 環境 + self-hosted runner のみ）</label>
          <label>ログイン方式<select name="authKind" defaultValue="none"><option value="none">なし</option><option value="password_form">パスワードフォーム（シークレット参照）</option></select></label>
          <div className="grid cols-3"><label>ログイン URL<input name="loginUrl" placeholder="/login" /></label><label>ユーザー欄ラベル<input name="userLabel" placeholder="Email" /></label><label>パスワード欄ラベル<input name="passLabel" placeholder="Password" /></label><label>送信ボタン名<input name="submitName" placeholder="Log in" /></label><label>ユーザー secret 名<input name="userSecret" placeholder="LOGIN_EMAIL" /></label><label>パスワード secret 名<input name="passSecret" placeholder="LOGIN_PASSWORD" /></label><label>成功後 URL に含む文字<input name="successUrl" placeholder="/dashboard" /></label></div>
          <label>マスクする CSS セレクタ（カンマ区切り、個人情報の映り込み対策）<input name="maskSelectors" placeholder=".user-email, #card-number" /></label>
        </Form></div>}
    </>}
    {tab === 'secrets' && <>
      <Alert kind="info">値はサーバー側で暗号化され、API・ログ・証拠には出ません。シナリオでは <code>{'{{secret:NAME}}'}</code> として参照します。</Alert>
      <div className="table-wrap"><table><thead><tr><th>名前</th><th>環境</th><th>version</th><th>更新</th><th></th></tr></thead><tbody>{(secrets.data ?? []).map((x) => <tr key={x.id}><td><code>{x.name}</code></td><td>{x.environment_id ? p.environments.find((e) => e.id === x.environment_id)?.name ?? x.environment_id : '全環境'}</td><td>{x.version}</td><td className="small">{x.updated_at.slice(0, 16)}</td><td>{canWrite && <button className="btn sm danger" onClick={async () => { if (confirmAction('削除しますか？')) { await del(`/api/v1/projects/${projectId}/secrets/${x.id}`); secrets.reload(); } }}>削除</button>}</td></tr>)}</tbody></table></div>
      {canWrite && <div className="panel"><h3>シークレットを登録 / 更新</h3><Form submitLabel="保存" onSubmit={async (v) => { await put(`/api/v1/projects/${projectId}/secrets`, { name: v.name, value: v.value, environmentId: v.environmentId || undefined }); secrets.reload(); }}>
        <label>名前<input name="name" required pattern="[A-Za-z0-9_.-]+" placeholder="LOGIN_PASSWORD" /></label>
        <label>値<input name="value" type="password" required autoComplete="off" /></label>
        <label>環境（省略で全環境）<select name="environmentId" defaultValue=""><option value="">全環境</option>{p.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      </Form></div>}
    </>}
    {tab === 'domains' && <>
      <Alert kind="info">公開 URL は所有確認が済むまで低負荷モードで実行されます。localhost（local 環境）は不要です。</Alert>
      <div className="table-wrap"><table><thead><tr><th>ホスト</th><th>方式</th><th>状態</th><th>エラー</th><th></th></tr></thead><tbody>{(domains.data ?? []).map((d) => <tr key={d.id}><td>{d.hostname}</td><td>{d.method}</td><td><Badge v={d.status} /></td><td className="small">{d.last_error ?? ''}</td><td>{canWrite && d.status !== 'verified' && <button className="btn sm" onClick={async () => { const r = await post<{ status: string; error: string | null }>(`/api/v1/projects/${projectId}/domains/${d.id}/verify`); setVerifyInfo(`${d.hostname}: ${r.status}${r.error ? ' — ' + r.error : ''}`); domains.reload(); proj.reload(); }}>検証する</button>}</td></tr>)}</tbody></table></div>
      {verifyInfo && <Alert kind="info">{verifyInfo}</Alert>}
      {canWrite && <div className="panel"><h3>検証を開始</h3><Form submitLabel="トークンを発行" onSubmit={async (v) => { const r = await post<{ instructions: string; token: string }>(`/api/v1/projects/${projectId}/domains`, { hostname: v.hostname, method: v.method }); setVerifyInfo(r.instructions); domains.reload(); }}>
        <label>ホスト名<input name="hostname" required placeholder="staging.example.com" /></label>
        <label>方式<select name="method" defaultValue="well_known"><option value="well_known">/.well-known/proofflow-verify.txt</option><option value="html_token">HTML meta タグ</option><option value="dns_txt">DNS TXT</option><option value="manual">組織 Owner/Admin による確認</option></select></label>
      </Form></div>}
    </>}
    {tab === 'fixtures' && <>
      <div className="table-wrap"><table><thead><tr><th>名前</th><th>種類</th><th>サイズ</th><th></th></tr></thead><tbody>{(fixtures.data ?? []).map((f) => <tr key={f.id}><td><code>{f.name}</code></td><td>{f.content_type}</td><td>{f.size_bytes}</td><td>{canWrite && <button className="btn sm danger" onClick={async () => { await del(`/api/v1/projects/${projectId}/fixtures/${f.id}`); fixtures.reload(); }}>削除</button>}</td></tr>)}</tbody></table></div>
      {canWrite && <div className="panel"><h3>アップロード用ファイルを登録（画像 / PDF / CSV / JSON など。実行ファイルは不可）</h3><input type="file" aria-label="ファイル" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; await api('PUT', `/api/v1/projects/${projectId}/fixtures?name=${encodeURIComponent(f.name)}`, undefined, { contentType: f.type || 'application/octet-stream', data: f }); fixtures.reload(); }} /></div>}
    </>}
    {tab === 'general' && <div className="panel"><Form submitLabel="保存" onSubmit={async (v) => { await patch(`/api/v1/projects/${projectId}`, { name: v.name, description: v.description, defaultEnvironmentId: v.defaultEnvironmentId || undefined }); proj.reload(); s.reload(); }}>
      <label>名前<input name="name" defaultValue={p.name} required /></label>
      <label>説明<textarea name="description" defaultValue={p.description ?? ''} /></label>
      <label>既定の環境<select name="defaultEnvironmentId" defaultValue={p.defaultEnvironmentId ?? ''}><option value="">—</option>{p.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
    </Form></div>}
  </>;
}
