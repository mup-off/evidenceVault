import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, getToken, onUnauthorized, setToken } from '../api/client.js';

const AuthContext = createContext(null);

/**
 * Holds the signed-in user. On load it re-reads the user from the API with
 * the stored token, so a deactivated account or changed role shows at once.
 * status: 'loading' | 'signed-in' | 'signed-out'
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(getToken() ? 'loading' : 'signed-out');
  const [notice, setNotice] = useState(null); // why the user was signed out, shown on the sign-in page

  useEffect(() => {
    onUnauthorized((message) => {
      setUser(null);
      setStatus('signed-out');
      setNotice(message);
    });
    return () => onUnauthorized(null);
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    api('/auth/me')
      .then(({ user: me }) => {
        if (cancelled) return;
        setUser(me);
        setStatus('signed-in');
      })
      .catch(() => {
        if (cancelled) return;
        setToken(null);
        setStatus('signed-out');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email, password) => {
    const { token, user: me } = await api('/auth/login', { method: 'POST', body: { email, password } });
    setToken(token);
    setNotice(null);
    setUser(me);
    setStatus('signed-in');
    return me;
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    setNotice('You have signed out.');
    setStatus('signed-out');
  }, []);

  const value = useMemo(() => ({ user, status, notice, signIn, signOut }), [user, status, notice, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
