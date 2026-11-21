import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { api } from '../api/client.js';
import { actionLabel, shortHash } from '../components/evidence.jsx';
import { Empty, ErrorNote, Loading, PageHeader, Panel } from '../components/ui.jsx';
import { formatDateTime } from '../format.js';

const ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGIN_REFUSED_LOCKED',
  'ACCESS_DENIED',
  'USER_CREATED',
  'USER_UPDATED',
  'CASE_CREATED',
  'CASE_UPDATED',
  'CASE_CLOSED',
  'CASE_REOPENED',
  'CASE_MEMBER_ADDED',
  'CASE_MEMBER_REMOVED',
  'EVIDENCE_REGISTERED',
  'INTEGRITY_VERIFIED',
  'INTEGRITY_FAILED',
  'EVIDENCE_DOWNLOADED',
  'DOWNLOAD_BLOCKED',
  'CUSTODY_TRANSFER_REQUESTED',
  'CUSTODY_REASSIGNED',
  'CUSTODY_TRANSFER_ACCEPTED',
  'CUSTODY_TRANSFER_REJECTED',
  'CUSTODY_TRANSFER_CANCELLED',
  'REPORT_GENERATED',
  'AUDIT_CHAIN_VERIFIED',
  'AUDIT_CHAIN_BROKEN',
  'ALERT_ACKNOWLEDGED',
];
const PAGE = 100;

function entityLink(entry) {
  if (!entry.entityId) return entry.entity || '—';
  if (entry.entity === 'evidence') return <Link to={`/evidence/${entry.entityId}`}>evidence #{entry.entityId}</Link>;
  if (entry.entity === 'case') return <Link to={`/cases/${entry.entityId}`}>case #{entry.entityId}</Link>;
  return `${entry.entity} #${entry.entityId}`;
}

function ChainResult({ result, anchor }) {
  const ok = result.intact;
  return (
    <div className={`verdict ${ok ? 'verdict-ok' : 'verdict-bad'}`} role="status">
      <div className="verdict-head">
        <span className="verdict-stamp">{ok ? 'Chain intact' : 'Chain broken'}</span>
        <span className="mono verdict-time">Checked {formatDateTime(result.checkedAt)}</span>
      </div>
      <p>
        {result.entriesChecked.toLocaleString('en')} entries checked against their HMAC and their link to the entry before.{' '}
        {result.anchors.checked} anchored head{result.anchors.checked === 1 ? '' : 's'} checked.
      </p>
      {!ok && (
        <ul className="verdict-reasons">
          {result.breaks.map((b) => (
            <li key={`b${b.seq}`}>
              Entry <strong className="mono">#{b.seq}</strong> ({actionLabel(b.action)}, {formatDateTime(b.ts)}): {b.explanation}.
            </li>
          ))}
          {result.brokenCount > result.breaks.length && <li>…and {result.brokenCount - result.breaks.length} more entries.</li>}
          {result.anchors.problems.map((p) => (
            <li key={`a${p.anchorId}`}>
              Anchor <span className="mono">#{p.anchorId}</span> for entry <strong className="mono">#{p.seq}</strong>: {p.explanation}.
            </li>
          ))}
        </ul>
      )}
      <dl className="facts facts-cols">
        <div>
          <dt>Chain head</dt>
          <dd className="mono">{result.head ? `#${result.head.seq} · ${shortHash(result.head.entryHash)}` : 'empty log'}</dd>
        </div>
        <div>
          <dt>{anchor ? 'New anchor' : 'Latest anchor'}</dt>
          <dd className="mono">
            {anchor
              ? `#${anchor.anchorId} at entry #${anchor.seq}`
              : result.anchors.latest
                ? `#${result.anchors.latest.anchorId} at entry #${result.anchors.latest.seq}`
                : 'none yet'}
          </dd>
        </div>
      </dl>
      {!ok && <p className="muted">A critical alert has been raised. Nothing was anchored while the chain is broken.</p>}
    </div>
  );
}

export default function AuditLog() {
  const [filters, setFilters] = useState({ action: '', entity: '', entityId: '' });
  const [entries, setEntries] = useState([]);
  const [next, setNext] = useState(null);
  const [state, setState] = useState({ loading: true, error: null });
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(null);

  const query = useCallback(
    (beforeSeq) => {
      const p = new URLSearchParams({ limit: String(PAGE) });
      if (filters.action) p.set('action', filters.action);
      if (filters.entity) p.set('entity', filters.entity);
      if (filters.entityId.trim()) p.set('entityId', filters.entityId.trim());
      if (beforeSeq) p.set('beforeSeq', String(beforeSeq));
      return `/audit?${p}`;
    },
    [filters],
  );

  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: null });
    api(query(), { signal: controller.signal })
      .then((d) => {
        setEntries(d.entries);
        setNext(d.nextBeforeSeq);
        setState({ loading: false, error: null });
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setState({ loading: false, error });
      });
    return () => controller.abort();
  }, [query]);

  async function loadOlder() {
    setState({ loading: true, error: null });
    try {
      const d = await api(query(next));
      setEntries((list) => [...list, ...d.entries]);
      setNext(d.nextBeforeSeq);
      setState({ loading: false, error: null });
    } catch (error) {
      setState({ loading: false, error });
    }
  }

  async function verifyChain() {
    setChecking(true);
    setCheckError(null);
    try {
      setCheck(await api('/audit/verify', { method: 'POST' }));
      setFilters((f) => ({ ...f })); // reload: the check itself was just logged
    } catch (err) {
      setCheckError(err);
    } finally {
      setChecking(false);
    }
  }

  const broken = new Set([...(check?.result.breaks || []).map((b) => b.seq), ...(check?.result.anchors.problems || []).map((p) => p.seq)]);
  const set = (field) => (e) => setFilters((f) => ({ ...f, [field]: e.target.value }));

  return (
    <>
      <PageHeader
        kicker="Oversight · Append-only record"
        title="Audit log"
        actions={
          <button type="button" className="btn btn-primary" onClick={verifyChain} disabled={checking}>
            {checking ? 'Checking every entry…' : 'Verify chain'}
          </button>
        }
      >
        Every action, oldest to newest, linked by an HMAC hash chain. The database refuses edits and deletions.
      </PageHeader>

      <ErrorNote error={checkError} />
      {check && <ChainResult result={check.result} anchor={check.anchor} />}

      <Panel
        title="Entries"
        meta={<span className="count">{entries.length ? `#${entries[0].seq} – #${entries[entries.length - 1].seq}` : ''}</span>}
      >
        <div className="toolbar toolbar-tight">
          <label className="field">
            <span>Action</span>
            <select value={filters.action} onChange={set('action')}>
              <option value="">All actions</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {actionLabel(a)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>About</span>
            <select value={filters.entity} onChange={set('entity')}>
              <option value="">Anything</option>
              <option value="evidence">Evidence</option>
              <option value="case">Cases</option>
              <option value="user">Users</option>
              <option value="alert">Alerts</option>
              <option value="audit_log">Audit log</option>
            </select>
          </label>
          <label className="field">
            <span>Record id</span>
            <input className="mono" value={filters.entityId} onChange={set('entityId')} inputMode="numeric" placeholder="e.g. 12" />
          </label>
        </div>

        <ErrorNote error={state.error} />
        {entries.length === 0 && !state.loading ? (
          <Empty title="No entries match" />
        ) : (
          <div className="table-wrap">
            <table className="table table-compact audit-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Time (CAT)</th>
                  <th scope="col">Action</th>
                  <th scope="col">By</th>
                  <th scope="col">About</th>
                  <th scope="col">Details</th>
                  <th scope="col">Entry hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.seq} className={broken.has(e.seq) ? 'row-broken' : e.action === 'ACCESS_DENIED' || e.action.endsWith('FAILED') ? 'row-warn' : ''}>
                    <td className="mono">{e.seq}</td>
                    <td className="mono nowrap">{formatDateTime(e.ts).replace(' CAT', '')}</td>
                    <td className="nowrap">
                      <span className="mono action-code">{e.action}</span>
                    </td>
                    <td>{e.userName || (e.userId ? `#${e.userId}` : <span className="muted">system</span>)}</td>
                    <td className="nowrap">{entityLink(e)}</td>
                    <td className="details-cell">
                      <code>{JSON.stringify(e.details)}</code>
                    </td>
                    <td className="mono muted nowrap" title={`entry ${e.entryHash}\nprevious ${e.prevHash}`}>
                      {shortHash(e.entryHash)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {state.loading && <Loading label="Loading entries" />}
        {next && !state.loading && (
          <div className="load-more">
            <button type="button" className="btn" onClick={loadOlder}>
              Load older entries
            </button>
          </div>
        )}
      </Panel>
    </>
  );
}
