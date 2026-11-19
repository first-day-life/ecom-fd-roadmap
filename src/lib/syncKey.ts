// Key the scheduled Netlify function uses to call /api/sync/* without a browser sign-in.
// Derived from CLICKUP_API_TOKEN (already set on Netlify), so no new secret is needed and the
// token itself is never sent. Web Crypto works in both middleware (edge) and route handlers.
export async function syncKey(): Promise<string> {
  const token = (process.env.CLICKUP_API_TOKEN || '').trim();
  if (!token) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('roadmap-sync:' + token));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function validSyncKey(given: string | null): Promise<boolean> {
  if (!given) return false;
  const want = await syncKey();
  if (!want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
