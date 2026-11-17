'use client';

import { useEffect, useState } from 'react';

const IDENTITY_CDN = 'https://esm.sh/@netlify/identity';

export function GoogleAuthButton() {
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    async function initAuth() {
      const { handleAuthCallback, getUser } = await import(
        /* webpackIgnore: true */ IDENTITY_CDN
      );
      await handleAuthCallback();
      const user = await getUser();
      if (user?.email) {
        setUserEmail(user.email);
      }
    }
    initAuth();
  }, []);

  const handleLogin = async () => {
    const { oauthLogin } = await import(
      /* webpackIgnore: true */ IDENTITY_CDN
    );
    oauthLogin('google');
  };

  const handleLogout = async () => {
    const { logout } = await import(
      /* webpackIgnore: true */ IDENTITY_CDN
    );
    await logout();
    setUserEmail(null);
    window.location.reload();
  };

  if (userEmail) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span>Signed in as {userEmail}</span>
        <button onClick={handleLogout}>Sign out</button>
      </div>
    );
  }

  return <button onClick={handleLogin}>Sign in with Google</button>;
}
