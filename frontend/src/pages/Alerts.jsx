import { useState } from 'react';
import { Link } from 'react-router';

import { api } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Empty, ErrorNote, Loading, PageHeader, Status, Tag } from '../components/ui.jsx';
import { formatDateTime } from '../format.js';

const FILTERS = [
  ['open', 'Open'],
  ['acknowledged', 'Acknowledged'],
  ['all', 'All'],
];

export default function Alerts() {
  const { user } = useAuth();
  const [status, setStatus] = useState('open');
  const { data, error, loading, reload } = useResource(`/alerts?status=${status}`);
  const [busyId, setBusyId] = useState(null);
  const [ackError, setAckError] = useState(null);
  const isAdmin = user.role === 'administrator';

  async function acknowledge(alert) {
    setBusyId(alert.id);
    setAckError(null);
    try {
      await api(`/alerts/${alert.id}/acknowledge`, { method: 'POST' });
      reload();
    } catch (err) {
      setAckError(err);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader kicker="Oversight · Security events" title="Alerts">
        Integrity failures, refused access, account lockouts and broken audit chains.
        {!isAdmin && ' Only administrators can acknowledge alerts.'}
      </PageHeader>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter alerts">
          {FILTERS.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={error || ackError} />
      {loading && !data && <Loading label="Loading alerts" />}

      {data &&
        (data.alerts.length === 0 ? (
          <Empty title={status === 'open' ? 'No open alerts' : 'No alerts'} />
        ) : (
          <ul className="alert-list stagger">
            {data.alerts.map((a) => (
              <li key={a.id} className={`alert-card alert-${a.severity}${a.acknowledged ? ' alert-done' : ''}`}>
                <div className="alert-head">
                  <Status value={a.severity} />
                  <span className="mono alert-type">{a.type}</span>
                  <span className="mono alert-time">{formatDateTime(a.createdAt)}</span>
                </div>
                <p className="alert-message">{a.message}</p>
                <div className="alert-foot">
                  {a.evidenceId && (
                    <Link to={`/evidence/${a.evidenceId}`}>
                      <Tag>{a.evidenceCode}</Tag>
                    </Link>
                  )}
                  {a.userName && <span className="muted">User: {a.userName}</span>}
                  {a.acknowledged ? (
                    <span className="muted">
                      Acknowledged by {a.acknowledgedByName} · {formatDateTime(a.acknowledgedAt)}
                    </span>
                  ) : (
                    isAdmin && (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => acknowledge(a)}
                        disabled={busyId === a.id}
                      >
                        {busyId === a.id ? 'Acknowledging…' : 'Acknowledge'}
                      </button>
                    )
                  )}
                </div>
              </li>
            ))}
          </ul>
        ))}
    </>
  );
}
