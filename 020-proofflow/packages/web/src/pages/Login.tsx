import { useState } from 'react';
import { post } from '../api.js';
import { Form } from '../components/ui.js';

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  return <main style={{ maxWidth: 420, margin: '40px auto' }}>
    <div className="panel">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><img src="/icon.svg" width="28" height="28" alt="" /> ProofFlow</h1>
      <p className="muted">公開前に、壊れているところを全部見つける。</p>
      <div className="tabs"><button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>ログイン</button><button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>新規登録（組織作成）</button></div>
      {mode === 'login' ? <Form submitLabel="ログイン" onSubmit={async (v) => { await post('/api/v1/auth/login', { email: v.email, password: v.password }); onLogin(); }}>
        <label>メールアドレス<input name="email" type="email" autoComplete="username" required /></label>
        <label>パスワード<input name="password" type="password" autoComplete="current-password" required /></label>
      </Form> : <Form submitLabel="組織を作成して開始" onSubmit={async (v) => { await post('/api/v1/auth/signup', { email: v.email, password: v.password, name: v.name, organizationName: v.organizationName }); onLogin(); }}>
        <label>お名前<input name="name" required /></label>
        <label>組織名<input name="organizationName" required placeholder="例: 株式会社サンプル / 個人" /></label>
        <label>メールアドレス<input name="email" type="email" autoComplete="username" required /></label>
        <label>パスワード（10文字以上）<input name="password" type="password" autoComplete="new-password" minLength={10} required /></label>
      </Form>}
    </div>
  </main>;
}
