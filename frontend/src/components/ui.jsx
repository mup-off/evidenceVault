import { Link } from 'react-router';

import { ROLE_LABELS } from '../roles.js';

/** Page heading: a small mono "file label" above a heavy title. */
export function PageHeader({ kicker, title, children, actions }) {
  return (
    <header className="page-header">
      <div>
        {kicker && <p className="kicker">{kicker}</p>}
        <h1>{title}</h1>
        {children && <div className="page-sub">{children}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/** Case numbers and evidence codes, styled like a punched evidence tag. */
export function Tag({ children, large = false }) {
  return <span className={`tag${large ? ' tag-lg' : ''}`}>{children}</span>;
}

const STATUS_TONE = {
  open: 'ok',
  closed: 'muted',
  verified: 'ok',
  unverified: 'warn',
  failed: 'bad',
  pending: 'warn',
  accepted: 'ok',
  rejected: 'bad',
  cancelled: 'muted',
  critical: 'bad',
  warning: 'warn',
  info: 'muted',
};

export function Status({ value, label }) {
  return <span className={`status status-${STATUS_TONE[value] || 'muted'}`}>{label || value}</span>;
}

export function RoleBadge({ role }) {
  return <span className={`role role-${role}`}>{ROLE_LABELS[role] || role}</span>;
}

export function ErrorNote({ error, children }) {
  if (!error && !children) return null;
  return (
    <div className="note note-error" role="alert">
      {children || error.message}
    </div>
  );
}

export function Loading({ label = 'Loading' }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading-bar" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Panel({ title, meta, children, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      {(title || meta) && (
        <div className="panel-head">
          {title && <h2>{title}</h2>}
          {meta && <div className="panel-meta">{meta}</div>}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Splash() {
  return (
    <div className="splash" role="status">
      <span className="brand-mark" aria-hidden="true" />
      Opening EvidenceVault…
    </div>
  );
}

export function Forbidden({ children }) {
  return (
    <div className="refusal">
      <p className="kicker">403 · Access refused</p>
      <h1>You do not have access to this</h1>
      <p>{children || 'Your role does not allow this screen.'} The attempt has been recorded in the audit log.</p>
      <Link className="btn" to="/">
        Back to dashboard
      </Link>
    </div>
  );
}

export function NotFound({ what = 'page' }) {
  return (
    <div className="refusal">
      <p className="kicker">404 · Not on file</p>
      <h1>No such {what}</h1>
      <p>It may have been mistyped, or it does not exist.</p>
      <Link className="btn" to="/">
        Back to dashboard
      </Link>
    </div>
  );
}
