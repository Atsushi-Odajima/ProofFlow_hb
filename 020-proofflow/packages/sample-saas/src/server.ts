/**
 * Sample SaaS — a deliberately buggy target application used for demos and ProofFlow's own tests.
 * Every bug is a toggle (default ON = "seeded"). Turning a bug off simulates the fix + redeploy.
 *   GET  /__sample/bugs            → current toggles
 *   POST /__sample/bugs {name:bool} → toggle
 * Test account: demo@example.com / demo-pass-123 (fake data only).
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export const BUG_NAMES = ['mobileCtaOffscreen', 'loginInvalidErrorMissing', 'signupDoubleSubmit', 'profileApi500', 'visualButtonShift', 'brokenLink', 'consoleException', 'downloadFilenameError', 'uploadInvalidTypeAccepted', 'a11yMissingLabel', 'apiSchemaBreak', 'slowApi'] as const;
export type BugName = (typeof BUG_NAMES)[number];

export function createSampleApp(opts: { bugs?: Partial<Record<BugName, boolean>> } = {}) {
  const bugs: Record<BugName, boolean> = Object.fromEntries(BUG_NAMES.map((b) => [b, true])) as Record<BugName, boolean>;
  Object.assign(bugs, opts.bugs ?? {});
  const users = new Map<string, { id: string; email: string; name: string; password: string; plan: string }>();
  users.set('demo@example.com', { id: 'u_demo', email: 'demo@example.com', name: 'Demo User', password: 'demo-pass-123', plan: 'pro' });
  const sessions = new Map<string, string>();
  const signups: string[] = [];

  const layout = (title: string, body: string, extraHead = '') => `<!doctype html><html${bugs.a11yMissingLabel ? '' : ' lang="ja"'}><head><meta charset="utf-8"><title>${title} — Sample SaaS</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;color:#1a1a2e;background:#fafafa}header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;background:#1a1a2e;color:#fff;position:sticky;top:0;z-index:5}header a{color:#fff;margin-left:14px;text-decoration:none}main{max-width:960px;margin:0 auto;padding:24px 16px}.hero{padding:48px 0}.btn{display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;border:0;border-radius:6px;font-size:16px;cursor:pointer;text-decoration:none}.btn.shift{margin-left:${bugs.visualButtonShift ? '28px' : '0'}}label{display:block;margin:12px 0 4px}input,select{padding:8px;width:100%;max-width:360px;border:1px solid #bbb;border-radius:4px}.error{color:#b91c1c;margin-top:8px}.ok{color:#15803d}footer{padding:24px 16px;color:#666;font-size:14px}
@media (max-width:480px){.hero .cta{${bugs.mobileCtaOffscreen ? 'position:relative;left:640px;' : ''}}}
</style>${extraHead}</head><body><header><strong>Sample SaaS</strong><nav><a href="/">Home</a><a href="/login">Login</a><a href="/signup">Sign up</a><a href="/dashboard">Dashboard</a><a href="/settings">Settings</a></nav></header><main>${body}</main><footer>© Sample SaaS · <a href="/terms">Terms</a> · <a href="${bugs.brokenLink ? '/pricing-old' : '/pricing'}">Pricing</a></footer></body></html>`;

  const pages: Record<string, () => string> = {
    '/': () => layout('Home', `<section class="hero"><h1>Ship with confidence</h1><p>Sample SaaS is the demo target for ProofFlow.</p><a class="btn cta shift" href="/signup" id="cta">Start free trial</a></section><section><h2>Features</h2><ul><li>Dashboards</li><li>Reports</li><li>Exports</li></ul></section>`),
    '/pricing': () => layout('Pricing', `<h1>Pricing</h1><p>Free / Pro / Team</p>`),
    '/terms': () => layout('Terms', `<h1>Terms</h1><p>Demo terms.</p>`),
    '/login': () => layout('Login', `<h1>Log in</h1><form method="post" action="/login" id="login-form"><label for="email">Email</label><input id="email" name="email" type="email" required><label for="password">Password</label><input id="password" name="password" type="password" required><p><button class="btn" type="submit">Log in</button></p><div id="login-error" class="error" role="alert"></div></form>`),
    '/signup': () => layout('Sign up', `<h1>Create your account</h1><form id="signup-form"><label for="name">Name</label><input id="name" name="name" required><label for="email">Email</label><input id="email" name="email" type="email" required><label for="password">Password</label><input id="password" name="password" type="password" minlength="8" required><p><button class="btn" type="submit" id="signup-submit">Create account</button></p><div id="signup-msg" role="status"></div></form>
<script>
${bugs.consoleException ? "setTimeout(function(){ throw new Error('widget init failed: undefined is not a function'); }, 10);" : ''}
var f=document.getElementById('signup-form');var b=document.getElementById('signup-submit');var m=document.getElementById('signup-msg');
f.addEventListener('submit',function(e){e.preventDefault();${bugs.signupDoubleSubmit ? '' : 'if(b.disabled)return;b.disabled=true;'}var fd=new FormData(f);fetch('/api/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(fd))}).then(function(r){return r.json()}).then(function(j){m.textContent=j.ok?'Account created':'Error: '+j.error;m.className=j.ok?'ok':'error';${bugs.signupDoubleSubmit ? '' : 'b.disabled=false;'}});});
</script>`),
    '/dashboard': () => layout('Dashboard', `<h1>Welcome back</h1><p id="welcome">Loading profile…</p><p><a class="btn" href="/api/export.csv" id="export" download>Download report</a></p>
<script>fetch('/api/profile',{credentials:'include'}).then(function(r){if(!r.ok)throw new Error('profile '+r.status);return r.json()}).then(function(p){document.getElementById('welcome').textContent='Hello, '+p.name+' ('+p.plan+')'}).catch(function(e){document.getElementById('welcome').textContent='Could not load profile';console.error(e)});</script>`),
    '/settings': () => layout('Settings', `<h1>Settings</h1><form id="avatar-form" enctype="multipart/form-data" method="post" action="/api/avatar">${bugs.a11yMissingLabel ? '<input id="display-name" name="displayName" placeholder="Display name">' : '<label for="display-name">Display name</label><input id="display-name" name="displayName">'}<label for="avatar">Avatar (PNG/JPEG)</label><input id="avatar" name="avatar" type="file" accept="image/png,image/jpeg"><p><button class="btn" type="submit" id="avatar-submit">Upload</button></p><div id="avatar-msg" role="status"></div></form>${bugs.a11yMissingLabel ? '<img src="/logo.png" width="40" height="40">' : '<img src="/logo.png" width="40" height="40" alt="Sample SaaS logo">'}
<script>var af=document.getElementById('avatar-form');af.addEventListener('submit',function(e){e.preventDefault();var fd=new FormData(af);fetch('/api/avatar',{method:'POST',body:fd}).then(function(r){return r.json()}).then(function(j){var m=document.getElementById('avatar-msg');m.textContent=j.ok?'Uploaded '+j.filename:'Rejected: '+j.error;m.className=j.ok?'ok':'error'});});</script>`),
  };

  const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const readBody = (req: http.IncomingMessage) => new Promise<Buffer>((resolve) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
  const parseCookies = (h?: string) => Object.fromEntries((h ?? '').split(';').map((p) => p.trim().split('=')).filter((p) => p[0]) as [string, string][]);
  const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const currentUser = (req: http.IncomingMessage) => { const c = parseCookies(req.headers.cookie); const auth = req.headers.authorization; const tok = auth?.startsWith('Bearer ') ? auth.slice(7) : c.sid; const email = tok ? sessions.get(tok) : undefined; return email ? users.get(email) : undefined; };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/__sample/bugs') {
        if (req.method === 'POST') { const b = JSON.parse((await readBody(req)).toString() || '{}') as Partial<Record<BugName, boolean>>; for (const [k, v] of Object.entries(b)) if ((BUG_NAMES as readonly string[]).includes(k)) bugs[k as BugName] = !!v; }
        return json(res, 200, bugs);
      }
      if (path === '/__sample/reset') { signups.length = 0; sessions.clear(); return json(res, 200, { ok: true }); }
      if (path === '/__sample/signups') return json(res, 200, { signups });
      if (path === '/logo.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG_1x1); }
      if (path === '/login' && req.method === 'POST') {
        const body = new URLSearchParams((await readBody(req)).toString());
        const u = users.get(String(body.get('email') ?? '').toLowerCase());
        if (!u || u.password !== body.get('password')) {
          const msg = bugs.loginInvalidErrorMissing ? '' : '<p class="error" id="login-error-text">Invalid email or password</p>';
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end(layout('Login', `<h1>Log in</h1>${msg}<form method="post" action="/login" id="login-form"><label for="email">Email</label><input id="email" name="email" type="email" required value="${body.get('email') ?? ''}"><label for="password">Password</label><input id="password" name="password" type="password" required><p><button class="btn" type="submit">Log in</button></p></form>`));
        }
        const sid = randomUUID(); sessions.set(sid, u.email);
        res.writeHead(302, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly`, location: '/dashboard' }); return res.end();
      }
      if (path === '/api/auth/login' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}') as { email?: string; password?: string };
        const u = users.get(String(b.email ?? '').toLowerCase());
        if (!u || u.password !== b.password) return json(res, 401, { error: 'invalid_credentials' });
        const tok = randomUUID(); sessions.set(tok, u.email); return json(res, 200, { token: tok, user: { id: u.id, email: u.email } });
      }
      if (path === '/api/signup' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}') as { name?: string; email?: string; password?: string };
        if (!b.email || !b.password || !b.name) return json(res, 400, { ok: false, error: 'missing fields' });
        if (users.has(b.email.toLowerCase()) && !bugs.signupDoubleSubmit) return json(res, 409, { ok: false, error: 'duplicate email' });
        signups.push(b.email.toLowerCase()); users.set(b.email.toLowerCase(), { id: 'u_' + signups.length, email: b.email.toLowerCase(), name: b.name, password: b.password, plan: 'free' });
        return json(res, 201, { ok: true });
      }
      if (path === '/api/profile') {
        const u = currentUser(req);
        if (!u) return json(res, 401, { error: 'unauthorized' });
        if (bugs.slowApi) await new Promise((r) => setTimeout(r, 1200));
        if (bugs.profileApi500) return json(res, 500, { error: 'internal error: NullPointer at ProfileService.load' });
        return json(res, 200, { id: u.id, email: u.email, name: u.name, plan: bugs.apiSchemaBreak ? 2 : u.plan, createdAt: '2026-01-01T00:00:00Z' });
      }
      if (path === '/api/export.csv') {
        const u = currentUser(req); if (!u) { res.writeHead(302, { location: '/login' }); return res.end(); }
        if (bugs.downloadFilenameError) { res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="export.txt"' }); return res.end('id,amount\n1,100\n'); }
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' }); return res.end('id,amount\n1,100\n');
      }
      if (path === '/api/avatar' && req.method === 'POST') {
        const raw = (await readBody(req)).toString('latin1');
        const m = /filename="([^"]*)"\r\nContent-Type: ([^\r\n]+)/i.exec(raw);
        const filename = m?.[1] ?? ''; const ct = (m?.[2] ?? '').toLowerCase();
        const okType = ct === 'image/png' || ct === 'image/jpeg';
        if (!okType && !bugs.uploadInvalidTypeAccepted) return json(res, 415, { ok: false, error: 'unsupported file type' });
        if (!filename) return json(res, 400, { ok: false, error: 'no file' });
        return json(res, 200, { ok: true, filename });
      }
      if (path === '/api/health') return json(res, 200, { ok: true });
      const page = pages[path];
      if (page) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page()); }
      if (path === '/pricing-old') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(layout('Not found', '<h1>404</h1>')); }
      res.writeHead(404, { 'content-type': 'text/html' }); res.end(layout('Not found', '<h1>404 Not Found</h1>'));
    } catch (e) { json(res, 500, { error: String(e) }); }
  });
  return { server, bugs, users, signups, listen: (port = 4100, host = '127.0.0.1') => new Promise<number>((resolve) => server.listen(port, host, () => resolve((server.address() as { port: number }).port))), close: () => new Promise<void>((r) => server.close(() => r())) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
  const app = createSampleApp();
  app.listen(Number(process.env.PORT ?? 4100), process.env.HOST ?? '127.0.0.1').then((p) => console.log(`[sample-saas] listening on http://127.0.0.1:${p} (bugs seeded: ON)`));
}
