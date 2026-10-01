import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

interface RouterState { path: string; navigate: (to: string) => void; }
const Ctx = createContext<RouterState>({ path: '/', navigate: () => undefined });
export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname + window.location.search);
  useEffect(() => { const on = () => setPath(window.location.pathname + window.location.search); window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on); }, []);
  const navigate = (to: string) => { window.history.pushState(null, '', to); setPath(to); window.scrollTo(0, 0); };
  return <Ctx.Provider value={{ path, navigate }}>{children}</Ctx.Provider>;
}
export const useRouter = () => useContext(Ctx);
/** Match "/projects/:id/runs/:runId" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = path.split('?')[0]!.split('/').filter(Boolean); const t = pattern.split('/').filter(Boolean);
  if (p.length !== t.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) { const seg = t[i]!; if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(p[i]!); else if (seg !== p[i]) return null; }
  return params;
}
export function Link({ to, children, className, onClick }: { to: string; children: ReactNode; className?: string; onClick?: () => void }) {
  const { navigate } = useRouter();
  return <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); onClick?.(); navigate(to); }}>{children}</a>;
}
export function useQuery(): URLSearchParams { const { path } = useRouter(); return new URLSearchParams(path.split('?')[1] ?? ''); }
