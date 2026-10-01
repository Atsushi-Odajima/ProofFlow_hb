import { get } from '../api.js';
import { Link } from '../router.js';
import { useAsync, Alert } from '../components/ui.js';
import type { Session } from '../App.js';

interface Dash { today: { runs: Record<string, number>; failedRuns: number; flakyResults: number; newDefects: number; readyForRetest: number; blockedReleases: number }; quality: { criticalRequirementCoverage: { covered: number; total: number }; browserCoverage30d: Record<string, number>; mobileChecks30d: { automatedMobileResults: number; manualChecks: number }; visualChangesPending: number; accessibilityFindings30d: Record<string, number>; openDefects: Record<string, number> }; note: string; }

export function DashboardPage({ s, projectId }: { s: Session; projectId: string }) {
  const { data, error } = useAsync(() => get<Dash>(`/api/v1/projects/${projectId}/dashboard`), [projectId]);
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const t = data.today; const q = data.quality; const base = `/projects/${projectId}`;
  const runsTotal = Object.values(t.runs).reduce((a, b) => a + b, 0);
  return <>
    <header className="top"><h1>{s.project?.name ?? 'プロジェクト'} — 今日</h1><div className="row"><Link className="btn primary" to={`${base}/runs?new=1`}>▶ テストを実行</Link></div></header>
    <div className="grid cols-4">
      <div className="stat"><div className="v">{runsTotal}</div><div className="l">今日の Run</div></div>
      <div className="stat"><div className="v" style={{ color: t.failedRuns ? 'var(--bad)' : undefined }}>{t.failedRuns}</div><div className="l">失敗した Run</div></div>
      <div className="stat"><div className="v" style={{ color: t.flakyResults ? 'var(--warn)' : undefined }}>{t.flakyResults}</div><div className="l">Flaky 結果</div></div>
      <div className="stat"><div className="v">{t.newDefects}</div><div className="l">新規不具合</div></div>
      <div className="stat"><div className="v">{t.readyForRetest}</div><div className="l">再テスト待ち</div></div>
      <div className="stat"><div className="v" style={{ color: t.blockedReleases ? 'var(--bad)' : undefined }}>{t.blockedReleases}</div><div className="l">BLOCKED なリリース</div></div>
    </div>
    <h2>品質の見える化</h2>
    <div className="grid cols-3">
      <div className="panel"><h3>Critical 要件カバレッジ</h3><div style={{ fontSize: 24, fontWeight: 700 }}>{q.criticalRequirementCoverage.covered} / {q.criticalRequirementCoverage.total}</div><p className="muted">p0/p1 要件のうち active シナリオがあるもの</p><Link to={`${base}/requirements`}>要件へ</Link></div>
      <div className="panel"><h3>ブラウザカバレッジ（30日）</h3>{Object.keys(q.browserCoverage30d).length ? Object.entries(q.browserCoverage30d).map(([b, n]) => <div key={b} className="row"><span className="chip">{b}</span><span className="muted">{n} 結果</span></div>) : <p className="muted">まだ実行がありません</p>}</div>
      <div className="panel"><h3>モバイル確認（30日）</h3><div>自動（mobile viewport）: <b>{q.mobileChecks30d.automatedMobileResults}</b></div><div>実機（Manual check）: <b>{q.mobileChecks30d.manualChecks}</b></div><p className="muted">WebKit/viewport emulation は実機の代わりになりません</p><Link to={`${base}/manual`}>実機確認を記録</Link></div>
      <div className="panel"><h3>Visual 変更の確認待ち</h3><div style={{ fontSize: 24, fontWeight: 700, color: q.visualChangesPending ? 'var(--warn)' : undefined }}>{q.visualChangesPending}</div><Link to={`${base}/visual`}>レビューへ</Link></div>
      <div className="panel"><h3>アクセシビリティ指摘（30日）</h3>{Object.entries(q.accessibilityFindings30d).map(([k, v]) => <div key={k} className="row"><span className={`badge ${k === 'critical' || k === 'serious' ? 'failed' : ''}`}>{k}</span><b>{v}</b></div>)}<p className="muted">自動チェックで検出できるのは一部です</p></div>
      <div className="panel"><h3>未解決の不具合</h3>{Object.keys(q.openDefects).length ? Object.entries(q.openDefects).map(([k, v]) => <div key={k} className="row"><span className={`badge ${k}`}>{k}</span><b>{v}</b></div>) : <p className="muted">なし</p>}<Link to={`${base}/defects`}>不具合へ</Link></div>
    </div>
    <p className="muted">{data.note}</p>
  </>;
}
