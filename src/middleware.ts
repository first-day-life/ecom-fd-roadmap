// TEMPORARY access gate: a single long shared token, passed once as a URL parameter.
//
//   https://<site>/?token=<ACCESS_TOKEN>
//
// A matching token sets an httpOnly cookie (30 days) and redirects to the same URL
// without the token, so it doesn't linger in the address bar. Every page and API
// route then requires that cookie, or the token as ?token= / an
// "Authorization: Bearer <token>" header for scripts.
//
// Replace with real per-user authentication. Until then, rotating ACCESS_TOKEN
// logs everyone out.

import { NextRequest, NextResponse } from 'next/server';

const COOKIE = 'roadmap_access';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** Constant-time string comparison (Edge runtime has no crypto.timingSafeEqual). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function deny(req: NextRequest, status: number, message: string) {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: message }, { status });
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Roadmap — access required</title>
<style>body{font-family:system-ui,sans-serif;background:#f8f9fb;color:#1a1d23;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px 32px;max-width:420px}h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#6b7280;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>Access required</h1><p>${message}</p></div></body></html>`;
  return new NextResponse(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function middleware(req: NextRequest) {
  const expected = process.env.ACCESS_TOKEN || '';

  if (!expected) {
    // Fail closed in production; stay open for local development.
    if (process.env.NODE_ENV === 'production') {
      return deny(req, 503, 'This site is not configured yet (ACCESS_TOKEN is not set).');
    }
    return NextResponse.next();
  }
  if (expected.length < 32) {
    return deny(req, 503, 'ACCESS_TOKEN is too short. Use at least 32 characters (e.g. openssl rand -hex 32).');
  }

  const urlToken = req.nextUrl.searchParams.get('token') || '';
  const header = req.headers.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const cookie = req.cookies.get(COOKIE)?.value || '';

  // First visit with ?token=… → remember it in a cookie and strip it from the URL
  if (urlToken && safeEqual(urlToken, expected)) {
    const clean = req.nextUrl.clone();
    clean.searchParams.delete('token');
    const res = req.method === 'GET' && !req.nextUrl.pathname.startsWith('/api/')
      ? NextResponse.redirect(clean)
      : NextResponse.next();
    res.cookies.set(COOKIE, expected, {
      httpOnly: true,
      secure: req.nextUrl.protocol === 'https:',
      sameSite: 'lax',
      path: '/',
      maxAge: MAX_AGE,
    });
    return res;
  }

  if ((cookie && safeEqual(cookie, expected)) || (bearer && safeEqual(bearer, expected))) {
    return NextResponse.next();
  }

  return deny(req, 401, 'Open this site using the link with the access token (…?token=…). Ask the roadmap owner for the link.');
}

export const config = {
  // Everything except Next.js build assets and the favicon
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
