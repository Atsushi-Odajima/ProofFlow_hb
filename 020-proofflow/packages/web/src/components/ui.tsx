import { useEffect, useState, type ReactNode, type FormEvent } from 'react';
import { ApiError } from '../api.js';

export const Badge = ({ v }: { v: string | null | undefined }) => <span className={`badge ${v ?? ''}`}>{v ?? '—'}</span>;
export function Alert({ kind = 'info', children }: { kind?: 'info' | 'error' | 'ok' | 'warn'; children: ReactNode }) { return <div className={`alert ${kind}`}>{children}</div>; }
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [onClose]);
  return <><div className="overlay" onClick={onClose} /><div className="drawer" role="dialog" aria-label={title}><button className="btn sm close" onClick={onClose} aria-label="閉じる">✕ 閉じる</button><h2 style={{ marginTop: 0 }}>{title}</h2>{children}</div></>;
}
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [tick, setTick] = useState(0);
  useEffect(() => { let alive = true; setLoading(true); fn().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
export function Form({ onSubmit, children, submitLabel = '保存', busyLabel = '送信中…', className }: { onSubmit: (values: Record<string, string>) => Promise<void>; children: ReactNode; submitLabel?: string; busyLabel?: string; className?: string }) {
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [ok, setOk] = useState(false);
  const handle = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setErr(null); setOk(false); setBusy(true);
    const form = e.currentTarget; const fd = new FormData(form); const values: Record<string, string> = {}; fd.forEach((v, k) => { values[k] = String(v); });
    try { await onSubmit(values); setOk(true); form.reset(); } catch (ex) { setErr(ex instanceof ApiError ? `${ex.message}${ex.details ? ' ' + JSON.stringify(ex.details).slice(0, 300) : ''}` : ex instanceof Error ? ex.message : String(ex)); } finally { setBusy(false); }
  };
  return <form className={`f ${className ?? ''}`} onSubmit={handle}>{children}{err && <Alert kind="error">{err}</Alert>}{ok && <Alert kind="ok">完了しました</Alert>}<div><button className="btn primary" disabled={busy}>{busy ? busyLabel : submitLabel}</button></div></form>;
}
export function Tabs({ tabs, active, onChange }: { tabs: Array<[string, string]>; active: string; onChange: (k: string) => void }) { return <div className="tabs">{tabs.map(([k, label]) => <button key={k} className={active === k ? 'active' : ''} onClick={() => onChange(k)}>{label}</button>)}</div>; }
export function Empty({ children }: { children: ReactNode }) { return <p className="muted">{children}</p>; }
export function confirmAction(msg: string): boolean { return window.confirm(msg); }
