import { useEffect, useState } from 'react';
import { get, post, type Me, type Project } from './api.js';
import { Link, match, useRouter } from './router.js';
import { LoginPage } from './pages/Login.js';
import { DashboardPage } from './pages/Dashboard.js';
import { ProjectsPage, ProjectSettingsPage } from './pages/Projects.js';
import { RequirementsPage } from './pages/Requirements.js';
import { ScenariosPage } from './pages/Scenarios.js';
import { SuitesPage } from './pages/Suites.js';
import { RunsPage, RunDetailPage } from './pages/Runs.js';
import { VisualPage } from './pages/Visual.js';
import { DefectsPage } from './pages/Defects.js';
import { ReleasesPage } from './pages/Releases.js';
import { ManualPage } from './pages/Manual.js';
import { SchedulesPage } from './pages/Schedules.js';
import { SettingsPage } from './pages/Settings.js';
import { BugReportsPage, PublicIntakePage } from './pages/BugReport.js';

export interface Session { me: Me; orgId: string; role: string; projects: Project[]; project: Project | null; reload: () => void; }

export function App() {
  const { path, navigate } = useRouter();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [orgId, setOrgId] = useState<string>(localStorage.getItem('pf.org') ?? '');
  const [projects, setProjects] = useState<Project[]>([]);
  const [tick, setTick] = useState(0);
  const [unread, setUnread] = useState(0);
  useEffect(() => { if (path.startsWith('/intake/')) return; get<Me>('/api/v1/auth/me').then(setMe).catch(() => setMe(null)); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!me) return; const org = me.organizations.find((o) => o.id === orgId) ?? me.organizations[0]; if (!org) return; if (org.id !== orgId) setOrgId(org.id); get<Project[]>(`/api/v1/orgs/${org.id}/projects`).then(setProjects).catch(() => setProjects([])); get<Array<unknown>>(`/api/v1/orgs/${org.id}/notifications?unread=true&limit=50`).then((n) => setUnread(n.length)).catch(() => undefined); }, [me, orgId, tick]);
  useEffect(() => { if (orgId) localStorage.setItem('pf.org', orgId); }, [orgId]);
  const intake = match('/intake/:intakeId', path);
  if (intake) return <PublicIntakePage intakeId={intake.intakeId!} />; // public, token-protected; no login
  if (me === undefined) return <main><p className="muted">読み込み中…</p></main>;
  if (!me) return <LoginPage onLogin={() => setTick((t) => t + 1)} />;
  const org = me.organizations.find((o) => o.id === orgId) ?? me.organizations[0];
  const projectId = path.match(/^\/projects\/([^/?]+)/)?.[1] ?? localStorage.getItem('pf.project') ?? projects[0]?.id ?? null;
  const project = projects.find((p) => p.id === projectId) ?? null;
  if (project) localStorage.setItem('pf.project', project.id);
  const session: Session = { me, orgId: org?.id ?? '', role: org?.role ?? 'viewer', projects, project, reload: () => setTick((t) => t + 1) };
  const pid = project?.id;
  const nav: Array<[string, string, string]> = pid ? [['/projects/' + pid + '/dashboard', 'ダッシュボード', '📊'], ['/projects/' + pid + '/runs', 'テスト実行', '▶'], ['/projects/' + pid + '/scenarios', 'シナリオ', '📝'], ['/projects/' + pid + '/suites', 'スイート', '🧩'], ['/projects/' + pid + '/requirements', '要件', '📋'], ['/projects/' + pid + '/visual', 'Visual', '🖼'], ['/projects/' + pid + '/defects', '不具合', '🐞'], ['/projects/' + pid + '/bug-reports', '不具合報告', '📨'], ['/projects/' + pid + '/releases', 'リリース', '🚀'], ['/projects/' + pid + '/manual', '手動/実機', '📱'], ['/projects/' + pid + '/schedules', 'スケジュール', '⏰'], ['/projects/' + pid + '/settings', 'プロジェクト設定', '⚙']] : [];
  const bottom: Array<[string, string, string]> = pid ? [['/projects/' + pid + '/dashboard', 'ホーム', '📊'], ['/projects/' + pid + '/runs', '実行', '▶'], ['/projects/' + pid + '/defects', '不具合', '🐞'], ['/projects/' + pid + '/releases', 'リリース', '🚀'], ['/settings', '設定', '⚙']] : [['/projects', 'プロジェクト', '📁'], ['/settings', '設定', '⚙']];
  const isActive = (to: string) => path.split('?')[0] === to || (to !== '/' && path.startsWith(to + '/'));
  const page = route(path, session, navigate);
  return <div className="app">
    <nav className="side" aria-label="メイン">
      <div className="brand"><img src="/icon.svg" width="22" height="22" alt="" /> ProofFlow</div>
      {me.organizations.length > 1 && <select value={org?.id} onChange={(e) => { setOrgId(e.target.value); navigate('/projects'); }} aria-label="組織">{me.organizations.map((o) => <option key={o.id} value={o.id}>{o.name ?? o.slug}</option>)}</select>}
      <select value={project?.id ?? ''} onChange={(e) => navigate(e.target.value ? `/projects/${e.target.value}/dashboard` : '/projects')} aria-label="プロジェクト"><option value="">プロジェクトを選択…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <Link to="/projects" className={isActive('/projects') && !pid ? 'active' : ''}>📁 プロジェクト一覧</Link>
      {nav.map(([to, label, icon]) => <Link key={to} to={to} className={isActive(to) ? 'active' : ''}>{icon} {label}</Link>)}
      <div className="section">組織</div>
      <Link to="/settings" className={isActive('/settings') ? 'active' : ''}>⚙ 設定・メンバー・トークン</Link>
      <Link to="/notifications" className={`bell ${isActive('/notifications') ? 'active' : ''}`}>🔔 通知 {unread > 0 && <span className="dot">{unread}</span>}</Link>
      <div className="spacer" />
      <div className="user">{me.actor.name}<br /><span className="muted">{org?.name ?? ''} · {org?.role}</span><br /><a href="#" onClick={async (e) => { e.preventDefault(); await post('/api/v1/auth/logout'); setMe(null); }}>ログアウト</a></div>
    </nav>
    <main>{page}</main>
    <nav className="bottom" aria-label="モバイルナビ">{bottom.map(([to, label, icon]) => <Link key={to} to={to} className={isActive(to) ? 'active' : ''}><span>{icon}</span>{label}</Link>)}</nav>
  </div>;
}

function route(path: string, s: Session, navigate: (to: string) => void) {
  const p = path.split('?')[0]!;
  let m: Record<string, string> | null;
  if (p === '/' || p === '' || p === '/login') { setTimeout(() => navigate(s.project ? `/projects/${s.project.id}/dashboard` : '/projects'), 0); return null; }
  if (p === '/projects') return <ProjectsPage s={s} />;
  if (p === '/settings') return <SettingsPage s={s} />;
  if (p === '/notifications') return <SettingsPage s={s} tab="notifications" />;
  if ((m = match('/projects/:id/dashboard', p))) return <DashboardPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/settings', p))) return <ProjectSettingsPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/requirements', p))) return <RequirementsPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/scenarios', p))) return <ScenariosPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/suites', p))) return <SuitesPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/runs', p))) return <RunsPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/runs/:runId', p))) return <RunDetailPage s={s} projectId={m.id!} runId={m.runId!} />;
  if ((m = match('/projects/:id/visual', p))) return <VisualPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/defects', p))) return <DefectsPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/defects/:defectId', p))) return <DefectsPage s={s} projectId={m.id!} defectId={m.defectId!} />;
  if ((m = match('/projects/:id/bug-reports', p))) return <BugReportsPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/releases', p))) return <ReleasesPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/releases/:rcId', p))) return <ReleasesPage s={s} projectId={m.id!} rcId={m.rcId!} />;
  if ((m = match('/projects/:id/manual', p))) return <ManualPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id/schedules', p))) return <SchedulesPage s={s} projectId={m.id!} />;
  if ((m = match('/projects/:id', p))) { const id = m.id; setTimeout(() => navigate(`/projects/${id}/dashboard`), 0); return null; }
  return <div className="panel"><h1>ページが見つかりません</h1><Link to="/projects">プロジェクト一覧へ</Link></div>;
}
