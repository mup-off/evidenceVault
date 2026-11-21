import { useState } from 'react';
import { Link } from 'react-router';

import { api } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { ErrorNote, Empty, Loading, PageHeader, Panel, Status, Tag } from '../components/ui.jsx';
import { firstName, formatDateTime, formatLongDate } from '../format.js';
import { seesAlerts } from '../roles.js';

function Tile({ label, value, tone, children }) {
  return (
    <div className={`tile${tone ? ` tile-${tone}` : ''}`}>
      <p className="tile-label">{label}</p>
      <p className="tile-value">{value}</p>
      {children && <p className="tile-foot">{children}</p>}
    </div>
  );
}

/** Proportions of verified / unverified / failed items as one segmented bar. */
function IntegrityBar({ evidence }) {
  const { total, verified, unverified, failed } = evidence;
  const parts = [
    ['verified', 'Verified', verified],
    ['unverified', 'Not yet verified', unverified],
    ['failed', 'Failed', failed],
  ];
  return (
    <div className="integrity">
      <div className="integrity-bar" role="img" aria-label={parts.map(([, l, n]) => `${l}: ${n}`).join(', ')}>
        {total === 0 ? (
          <span className="seg seg-none" style={{ flexGrow: 1 }} />
        ) : (
          parts.map(([key, , n]) => n > 0 && <span key={key} className={`seg seg-${key}`} style={{ flexGrow: n }} />)
        )}
      </div>
      <ul className="integrity-legend">
        {parts.map(([key, label, n]) => (
          <li key={key}>
            <span className={`dot seg-${key}`} aria-hidden="true" />
            {label} <strong>{n}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IncomingTransfer({ transfer, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  async function decide(decision) {
    setBusy(decision);
    setError(null);
    try {
      await api(`/transfers/${transfer.id}/${decision}`, { method: 'POST', body: note.trim() ? { note: note.trim() } : {} });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  }

  return (
    <li className="transfer">
      <div className="transfer-head">
        <Link to={`/evidence/${transfer.evidenceId}`}>
          <Tag>{transfer.evidenceCode}</Tag>
        </Link>
        <span className="transfer-case">
          Case <Link to={`/cases/${transfer.caseId}`}>{transfer.caseNumber}</Link>
        </span>
        {transfer.reassignment && <Status value="warning" label="Admin reassignment" />}
      </div>
      <p className="transfer-line">
        From <strong>{transfer.from.fullName}</strong>
        {transfer.reassignment && <> (requested by {transfer.requestedBy.fullName})</>} ·{' '}
        <span className="mono">{formatDateTime(transfer.requestedAt)}</span>
      </p>
      <p className="transfer-reason">“{transfer.reason}”</p>
      <div className="transfer-actions">
        <input
          className="input-small"
          placeholder="Note (optional), e.g. seal number"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          aria-label={`Note for transfer of ${transfer.evidenceCode}`}
        />
        <button type="button" className="btn btn-primary btn-small" disabled={Boolean(busy)} onClick={() => decide('accept')}>
          {busy === 'accept' ? 'Accepting…' : 'Accept custody'}
        </button>
        <button type="button" className="btn btn-small" disabled={Boolean(busy)} onClick={() => decide('reject')}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      <ErrorNote error={error} />
    </li>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useResource('/dashboard');

  return (
    <>
      <PageHeader kicker={`Duty board · ${formatLongDate()}`} title={`Muraho, ${firstName(user.fullName)}`}>
        {user.role === 'investigator'
          ? 'Counts cover the cases you are assigned to.'
          : 'Counts cover every case in the system.'}
      </PageHeader>

      {loading && !data && <Loading />}
      <ErrorNote error={error} />

      {data && (
        <div className="dash">
          <div className="tiles stagger">
            <Tile label="Open cases" value={data.cases.open}>
              {data.cases.closed} closed
            </Tile>
            <Tile label="Evidence items" value={data.evidence.total}>
              {data.evidence.verified} verified
            </Tile>
            <Tile label="Integrity failures" value={data.evidence.failed} tone={data.evidence.failed > 0 ? 'bad' : null}>
              {data.evidence.failed > 0 ? 'Needs investigation' : 'None recorded'}
            </Tile>
            <Tile label="In your custody" value={data.custody.holding}>
              {data.custody.outgoingPending} outgoing pending
            </Tile>
          </div>

          <div className="dash-grid">
            <Panel
              title="Waiting for you"
              meta={<span className="count">{data.custody.incomingPending}</span>}
              className="panel-waiting"
            >
              {data.custody.waitingForYou.length === 0 ? (
                <Empty title="No transfers waiting">When someone hands an item to you, it appears here for you to accept.</Empty>
              ) : (
                <ul className="transfers">
                  {data.custody.waitingForYou.map((t) => (
                    <IncomingTransfer key={t.id} transfer={t} onDone={reload} />
                  ))}
                </ul>
              )}
            </Panel>

            <div className="dash-side">
              <Panel title="Integrity">
                <IntegrityBar evidence={data.evidence} />
              </Panel>

              {seesAlerts(user) && data.alerts && (
                <Panel
                  title="Open alerts"
                  meta={
                    <span className={`count${data.alerts.critical > 0 ? ' count-bad' : ''}`}>
                      {data.alerts.open}
                      {data.alerts.critical > 0 && <> · {data.alerts.critical} critical</>}
                    </span>
                  }
                >
                  {data.alerts.latest.length === 0 ? (
                    <Empty title="No open alerts" />
                  ) : (
                    <ul className="alerts">
                      {data.alerts.latest.map((a) => (
                        <li key={a.id} className={`alert alert-${a.severity}`}>
                          <div className="alert-head">
                            <Status value={a.severity} />
                            <span className="mono alert-type">{a.type}</span>
                          </div>
                          <p>{a.message}</p>
                          <p className="mono alert-time">{formatDateTime(a.createdAt)}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
