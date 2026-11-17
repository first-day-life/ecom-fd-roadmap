// Access control: Google sign-in through Netlify Identity, limited to allowed email domains.
//
// Flow
//   1. Signed-out visitors get a sign-in page (pages) or 401 JSON (API).
//   2. "Sign in with Google" → /.netlify/identity/authorize?provider=google → Google →
//      back to the site with #access_token=… in the URL hash.
//   3. The sign-in page posts those tokens to /auth/session. The server checks them with
//      Netlify Identity (/.netlify/identity/user), checks the email domain, and stores them
//      in httpOnly cookies.
//   4. Every request: the access token is re-checked with Identity (cached briefly); when
//      it has expired, the refresh token gets a new one transparently.
//
// Env
//   ALLOWED_EMAIL_DOMAINS  comma-separated, default "firstday.com"
//   ALLOWED_EMAILS         optional comma-separated extra addresses (e.g. contractors)
//   AUTH_REQUIRED=1        enforce sign-in outside production too (local dev is open by default)
//   IDENTITY_URL           override the Identity endpoint (default: <site>/.netlify/identity) — for testing

import { NextRequest, NextResponse } from 'next/server';

const AT = 'rm_at';                 // Identity access token (JWT, ~1h)
const RT = 'rm_rt';                 // Identity refresh token
const RT_MAX_AGE = 60 * 60 * 24 * 30;
const VERIFY_TTL = 5 * 60 * 1000;   // re-check a token with Identity at most every 5 min per instance

function env(name: string): string {
  const fromProcess = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (fromProcess) return fromProcess.trim();
  try {
    const v = (globalThis as any).Netlify?.env?.get?.(name);
    if (v) return String(v).trim();
  } catch { /* not on Netlify */ }
  return '';
}

const csv = (v: string) => v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function authRequired(): boolean {
  return process.env.NODE_ENV === 'production' || env('AUTH_REQUIRED') === '1';
}

function emailAllowed(email: string): boolean {
  const e = email.toLowerCase();
  if (csv(env('ALLOWED_EMAILS')).includes(e)) return true;
  const domains = csv(env('ALLOWED_EMAIL_DOMAINS') || 'firstday.com');
  return domains.some(d => e.endsWith('@' + d));
}

// --- Identity calls --------------------------------------------------------

/** Identity endpoint. Prefer an explicit override, then the request's public host, then Netlify's URL. */
function identityBase(req: NextRequest): string {
  const override = env('IDENTITY_URL');
  if (override) return override.replace(/\/$/, '');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') || req.nextUrl.protocol.replace(':', '') || 'https';
  if (host) return `${proto}://${host}/.netlify/identity`;
  const site = env('URL');
  return `${site || req.nextUrl.origin}/.netlify/identity`;
}

/** Why the last verification failed — surfaced on the sign-in page to make problems diagnosable. */
type Verify = { email: string } | { error: string };

const verified = new Map<string, { email: string; at: number }>();

async function identityUser(req: NextRequest, token: string): Promise<Verify> {
  const hit = verified.get(token);
  if (hit && Date.now() - hit.at < VERIFY_TTL) return { email: hit.email };
  const url = `${identityBase(req)}/user`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const text = await res.text();
    if (!res.ok) { verified.delete(token); return { error: `Identity ${res.status} from ${url}: ${text.slice(0, 200)}` }; }
    let u: any = {};
    try { u = JSON.parse(text); } catch { return { error: `Identity returned non-JSON from ${url}: ${text.slice(0, 120)}` }; }
    if (!u?.email) return { error: 'Identity user has no email' };
    if (verified.size > 500) verified.clear();
    verified.set(token, { email: u.email, at: Date.now() });
    return { email: u.email };
  } catch (e: any) {
    return { error: `Could not reach Identity at ${url}: ${e?.message || e}` };
  }
}

const ok = (v: Verify): v is { email: string } => 'email' in v;

async function refreshTokens(req: NextRequest, refreshToken: string): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
  try {
    const res = await fetch(`${identityBase(req)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const t = await res.json();
    return t?.access_token ? t : null;
  } catch {
    return null;
  }
}

function setSession(res: NextResponse, req: NextRequest, t: { access_token: string; refresh_token?: string; expires_in?: number }) {
  const secure = req.nextUrl.protocol === 'https:';
  res.cookies.set(AT, t.access_token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: Math.max(60, Number(t.expires_in) || 3600) });
  if (t.refresh_token) res.cookies.set(RT, t.refresh_token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: RT_MAX_AGE });
}

function clearSession(res: NextResponse) {
  res.cookies.set(AT, '', { path: '/', maxAge: 0 });
  res.cookies.set(RT, '', { path: '/', maxAge: 0 });
}

// --- Pages -----------------------------------------------------------------

function page(status: number, title: string, body: string) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Roadmap — ${title}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#f8f9fb;color:#1a1d23;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px 32px;max-width:420px;width:100%}h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#6b7280;line-height:1.6;margin:0 0 16px}
.btn{display:inline-flex;align-items:center;gap:10px;background:#0f1117;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none}
.btn.ghost{background:#fff;color:#374151;border:1px solid #e5e7eb}.err{color:#dc2626;font-size:13px;margin-top:12px;min-height:1em;word-break:break-word;white-space:pre-wrap}</style></head>
<body><div class="card">${body}</div></body></html>`;
  return new NextResponse(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function signInPage() {
  const domains = (env('ALLOWED_EMAIL_DOMAINS') || 'firstday.com').split(',').map(d => '@' + d.trim()).join(', ');
  return page(401, 'Sign in', `
<h1>firstday.com — Roadmap</h1>
<p>Sign in with your Google account (${domains}) to continue.</p>
<button class="btn" id="go">Sign in with Google</button>
<div class="err" id="err"></div>
<script>
(function(){
  var err = document.getElementById('err');
  var h = new URLSearchParams(location.hash.slice(1));
  var q = new URLSearchParams(location.search);
  var hashErr = h.get('error') || q.get('error');
  if (hashErr) {
    err.textContent = 'Sign-in failed — ' + hashErr + ': ' + (h.get('error_description') || q.get('error_description') || '(no description)');
    history.replaceState(null,'',location.pathname);
  }
  if (h.get('access_token')) {
    err.style.color = '#6b7280'; err.textContent = 'Signing you in…';
    fetch('/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_in: h.get('expires_in') }) })
      .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
      .then(function(x){
        if (!x.ok) { err.style.color=''; err.textContent = (x.d.error || 'Sign-in failed') + (x.d.detail ? ' Details: ' + x.d.detail : ''); history.replaceState(null,'',location.pathname); return; }
        var back = sessionStorage.getItem('rm_return') || '/'; sessionStorage.removeItem('rm_return');
        location.replace(back);
      })
      .catch(function(){ err.style.color=''; err.textContent = 'Sign-in failed — please try again.'; });
  }
  document.getElementById('go').onclick = function(){
    try { sessionStorage.setItem('rm_return', location.pathname + location.search); } catch(e) {}
    location.href = '/.netlify/identity/authorize?provider=google';
  };
})();
</script>`);
}

function forbiddenPage(email: string) {
  return page(403, 'Not allowed', `
<h1>Not allowed</h1>
<p>You're signed in as <strong>${email.replace(/[<>&"]/g, '')}</strong>, which doesn't have access to this roadmap.</p>
<a class="btn ghost" href="/auth/logout">Sign out and use another account</a>`);
}

// --- Middleware ------------------------------------------------------------

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!authRequired()) return NextResponse.next();

  // Sign-in completion: browser posts the tokens from the OAuth redirect hash
  if (pathname === '/auth/session' && req.method === 'POST') {
    let body: any = {};
    try { body = await req.json(); } catch { /* empty */ }
    if (!body?.access_token) return NextResponse.json({ error: 'No access token received from the sign-in redirect.' }, { status: 400 });
    const v = await identityUser(req, String(body.access_token));
    if (!ok(v)) return NextResponse.json({ error: 'Could not verify your sign-in.', detail: v.error }, { status: 401 });
    const user = v;
    if (!emailAllowed(user.email)) return NextResponse.json({ error: `${user.email} doesn't have access to this roadmap.` }, { status: 403 });
    const res = NextResponse.json({ ok: true, email: user.email });
    setSession(res, req, body);
    return res;
  }

  if (pathname === '/auth/logout') {
    const res = NextResponse.redirect(new URL('/', req.url));
    clearSession(res);
    return res;
  }

  // Normal request: check (and if needed refresh) the session
  let user = null as { email: string } | null;
  let refreshed = null as Awaited<ReturnType<typeof refreshTokens>>;
  const at = req.cookies.get(AT)?.value;
  const rt = req.cookies.get(RT)?.value;
  if (at) { const v = await identityUser(req, at); if (ok(v)) user = v; }
  if (!user && rt) {
    refreshed = await refreshTokens(req, rt);
    if (refreshed) { const v = await identityUser(req, refreshed.access_token); if (ok(v)) user = v; }
  }

  if (!user) {
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }
    const res = signInPage();
    if (at || rt) clearSession(res);
    return res;
  }

  if (!emailAllowed(user.email)) {
    return pathname.startsWith('/api/') || pathname.startsWith('/auth/')
      ? NextResponse.json({ error: 'Not allowed' }, { status: 403 })
      : forbiddenPage(user.email);
  }

  if (pathname === '/auth/me') {
    const res = NextResponse.json({ email: user.email });
    if (refreshed) setSession(res, req, refreshed);
    return res;
  }

  // Pass the verified email to route handlers (client-supplied values are overwritten)
  const headers = new Headers(req.headers);
  headers.set('x-roadmap-user', user.email);
  const res = NextResponse.next({ request: { headers } });
  if (refreshed) setSession(res, req, refreshed);
  return res;
}

export const config = {
  // Everything except Next.js build assets, the favicon and Netlify's own endpoints (Identity)
  matcher: ['/((?!_next/static|_next/image|favicon.ico|\\.netlify/).*)'],
};
