import { useState } from 'react';

import { api } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { ErrorNote, Loading, PageHeader, Status } from '../components/ui.jsx';
import { formatDate, formatDateTime } from '../format.js';
import { ROLE_LABELS } from '../roles.js';

const ROLES = Object.keys(ROLE_LABELS);

function NewUserForm({ onDone, onCancel }) {
  const [form, setForm] = useState({ fullName: '', email: '', role: 'investigator', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/users', { method: 'POST', body: { ...form, fullName: form.fullName.trim(), email: form.email.trim() } });
      onDone();
    } catch (err) {
      setError(err.status === 409 ? new Error('An account with that email already exists.') : err);
      setBusy(false);
    }
  }

  return (
    <form className="sheet" onSubmit={submit}>
      <div className="sheet-head">
        <p className="kicker">New account</p>
        <h2>Add a user</h2>
      </div>
      <ErrorNote error={error} />
      <div className="form-grid form-grid-2">
        <label className="field">
          <span>Full name</span>
          <input value={form.fullName} onChange={set('fullName')} maxLength={200} required autoFocus />
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" value={form.email} onChange={set('email')} maxLength={254} required />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={form.role} onChange={set('role')}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Initial password</span>
          <input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} minLength={10} required />
        </label>
      </div>
      <p className="panel-hint">At least 10 characters. Give it to the person through a separate channel.</p>
      <div className="sheet-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !form.fullName.trim() || !form.email.trim() || form.password.length < 10}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function UserRow({ u, isSelf, onChanged, onError }) {
  const [busy, setBusy] = useState(false);

  async function patch(body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    onError(null);
    try {
      await api(`/users/${u.id}`, { method: 'PATCH', body });
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  function resetPassword() {
    const password = window.prompt(`New password for ${u.fullName} (at least 10 characters). Their current sessions will end.`);
    if (password === null) return;
    if (password.length < 10) {
      onError(new Error('The new password must be at least 10 characters.'));
      return;
    }
    patch({ password });
  }

  return (
    <tr className={u.active ? '' : 'row-muted'}>
      <td>
        <p className="cell-title">
          {u.fullName}
          {isSelf && <span className="member-flag">You</span>}
        </p>
        <span className="cell-sub mono">{u.email}</span>
      </td>
      <td>
        <select
          className="input-small"
          value={u.role}
          disabled={busy || isSelf}
          onChange={(e) => patch({ role: e.target.value }, `Change ${u.fullName}'s role to ${ROLE_LABELS[e.target.value]}? It takes effect on their next request.`)}
          aria-label={`Role of ${u.fullName}`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </td>
      <td>
        {!u.active ? <Status value="closed" label="Deactivated" /> : u.lockedUntil ? <Status value="failed" label="Locked" /> : <Status value="open" label="Active" />}
        {u.lockedUntil && <span className="cell-sub mono">until {formatDateTime(u.lockedUntil)}</span>}
      </td>
      <td className="mono">{formatDate(u.createdAt)}</td>
      <td>
        <div className="row-actions">
          {u.lockedUntil && (
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => patch({ unlock: true })}>
              Unlock
            </button>
          )}
          <button type="button" className="btn btn-small btn-quiet" disabled={busy} onClick={resetPassword}>
            Reset password
          </button>
          {!isSelf &&
            (u.active ? (
              <button
                type="button"
                className="btn btn-small btn-danger"
                disabled={busy}
                onClick={() => patch({ active: false }, `Deactivate ${u.fullName}? They are signed out at once and cannot sign in again.`)}
              >
                Deactivate
              </button>
            ) : (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => patch({ active: true })}>
                Reactivate
              </button>
            ))}
        </div>
      </td>
    </tr>
  );
}

export default function Users() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useResource('/users');
  const [creating, setCreating] = useState(false);
  const [rowError, setRowError] = useState(null);

  return (
    <>
      <PageHeader
        kicker="Administration · Accounts"
        title="Users"
        actions={
          !creating && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              Add user
            </button>
          )
        }
      >
        Changes take effect on the user’s next request. Deactivating or resetting a password ends their sessions.
      </PageHeader>

      {creating && (
        <NewUserForm
          onCancel={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            reload();
          }}
        />
      )}

      <ErrorNote error={error || rowError} />
      {loading && !data && <Loading label="Loading users" />}

      {data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <UserRow key={u.id} u={u} isSelf={u.id === user.id} onChanged={reload} onError={setRowError} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
