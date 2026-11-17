'use client';

import { useEffect, useState } from 'react';

/** Shows the signed-in Google account (verified server-side by the middleware) and a sign-out link. */
export function AuthStatus() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    fetch('/auth/me', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => setEmail(d?.email || null))
      .catch(() => setEmail(null));
  }, []);

  if (!email) return null;
  return (
    <span className="auth-status">
      <span className="auth-email" title="Signed in with Google">{email}</span>
      <a className="btn btn-ghost btn-sm" href="/auth/logout">Sign out</a>
    </span>
  );
}
