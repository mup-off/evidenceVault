import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { useAuth } from '../auth/AuthContext.jsx';
import { safeReturnPath } from '../auth/guards.jsx';
import { formatDateTime } from '../format.js';

// Demo accounts from `npm run seed`, offered only in development builds.
const DEMO_ACCOUNTS = [
  ['Administrator', 'admin@evidencevault.local'],
  ['Investigator', 'investigator@evidencevault.local'],
  ['Custodian', 'custodian@evidencevault.local'],
  ['Auditor', 'auditor@evidencevault.local'],
];
const DEMO_PASSWORD = 'EvidenceVault#2026';

const TAPE = 'CHAIN OF CUSTODY · DO NOT ALTER · SHA-256 SEALED · ';

export default function SignIn() {
  const { status, notice, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const returnTo = safeReturnPath(location.state?.from);
  if (status === 'signed-in') return <Navigate to={returnTo} replace />;

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      navigate(returnTo, { replace: true });
    } catch (err) {
      const lockedUntil = err.body?.lockedUntil;
      setError(lockedUntil ? `${err.message} Locked until ${formatDateTime(lockedUntil)}.` : err.message);
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <section className="signin-art" aria-hidden="true">
        <div className="signin-wordmark">
          <span>Evidence</span>
          <span>Vault</span>
        </div>
        <p className="signin-claim">
          Digital evidence, registered once, fingerprinted with SHA-256, and accounted for at every hand-over.
        </p>
        <div className="tape tape-1">
          <span>{TAPE.repeat(6)}</span>
        </div>
        <div className="tape tape-2">
          <span>{TAPE.repeat(6)}</span>
        </div>
        <p className="signin-foot">Republic of Rwanda · Prototype</p>
      </section>

      <section className="signin-form-wrap">
        <form className="signin-form" onSubmit={submit} noValidate>
          <p className="kicker">Authorized personnel only</p>
          <h1>Sign in</h1>

          {notice && !error && <div className="note note-info">{notice}</div>}
          {error && (
            <div className="note note-error" role="alert">
              {error}
            </div>
          )}

          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="fineprint">
            Every sign-in is recorded. Five failed attempts lock the account for 15 minutes.
          </p>

          {import.meta.env.DEV && (
            <div className="demo-accounts">
              <p className="kicker">Demo accounts (development only)</p>
              <div className="demo-grid">
                {DEMO_ACCOUNTS.map(([label, demoEmail]) => (
                  <button
                    key={demoEmail}
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      setEmail(demoEmail);
                      setPassword(DEMO_PASSWORD);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
