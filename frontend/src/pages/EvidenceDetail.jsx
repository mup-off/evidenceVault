import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { api, download } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { CollectionDetails, Hash, HistoryTimeline, IntegrityResult } from '../components/evidence.jsx';
import { ErrorNote, Forbidden, Loading, NotFound, PageHeader, Panel, RoleBadge, Status, Tag } from '../components/ui.jsx';
import { formatBytes, formatDateTime } from '../format.js';
import { canDownload, canRequestTransfer, HOLDER_ROLES } from '../roles.js';

const INTEGRITY_LABEL = { verified: 'Verified', unverified: 'Not yet verified', failed: 'Integrity failed' };

function TransferForm({ evidence, onDone }) {
  const directory = useResource('/users/directory');
  const caseInfo = useResource(`/cases/${evidence.caseId}`);
  const [toUserId, setToUserId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Recipients: active holders-by-role, minus the current custodian; investigators only if assigned to the case.
  const memberIds = new Set((caseInfo.data?.members || []).map((m) => m.id));
  const recipients = (directory.data?.users || []).filter(
    (u) =>
      HOLDER_ROLES.includes(u.role) &&
      u.id !== evidence.currentCustodianId &&
      (u.role !== 'investigator' || memberIds.has(u.id)),
  );

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/evidence/${evidence.id}/transfers`, {
        method: 'POST',
        body: { toUserId: Number(toUserId), reason: reason.trim() },
      });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form className="transfer-form" onSubmit={submit}>
      <p className="kicker">Hand over custody</p>
      <ErrorNote error={error || directory.error || caseInfo.error} />
      <label className="field">
        <span>Recipient</span>
        <select value={toUserId} onChange={(e) => setToUserId(e.target.value)} required disabled={busy}>
          <option value="">{directory.loading || caseInfo.loading ? 'Loading…' : 'Choose a person…'}</option>
          {recipients.map((u) => (
            <option key={u.id} value={u.id}>
              {u.fullName} · {u.role}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Reason</span>
        <textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
          placeholder="e.g. Lodging in the evidence room"
          required
          disabled={busy}
        />
      </label>
      <p className="panel-hint">The recipient must accept before custody changes. Investigators must be assigned to the case.</p>
      <button type="submit" className="btn btn-primary" disabled={busy || !toUserId || !reason.trim()}>
        {busy ? 'Sending…' : 'Request transfer'}
      </button>
    </form>
  );
}

function PendingTransfer({ transfer, user, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const isRecipient = transfer.to.id === user.id;
  const mayCancel =
    user.role === 'administrator' || transfer.requestedBy.id === user.id || transfer.from.id === user.id;

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
    <div className="pending">
      <p className="kicker">
        <Status value="pending" /> Awaiting acceptance
      </p>
      <p>
        <strong>{transfer.from.fullName}</strong> → <strong>{transfer.to.fullName}</strong>
      </p>
      <p className="transfer-reason">“{transfer.reason}”</p>
      <p className="muted mono">
        Requested by {transfer.requestedBy.fullName} · {formatDateTime(transfer.requestedAt)}
      </p>
      <ErrorNote error={error} />
      {(isRecipient || mayCancel) && (
        <div className="transfer-actions">
          {isRecipient && (
            <input
              className="input-small"
              placeholder="Note (optional)"
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
              aria-label="Note"
            />
          )}
          {isRecipient && (
            <>
              <button type="button" className="btn btn-primary btn-small" disabled={Boolean(busy)} onClick={() => decide('accept')}>
                Accept custody
              </button>
              <button type="button" className="btn btn-small" disabled={Boolean(busy)} onClick={() => decide('reject')}>
                Reject
              </button>
            </>
          )}
          {mayCancel && (
            <button type="button" className="btn btn-small btn-quiet" disabled={Boolean(busy)} onClick={() => decide('cancel')}>
              Cancel request
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function EvidenceDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const item = useResource(`/evidence/${encodeURIComponent(id)}?v=${version}`);
  const ready = Boolean(item.data);
  const transfers = useResource(ready ? `/evidence/${id}/transfers?v=${version}` : null);
  const history = useResource(ready ? `/evidence/${id}/history?v=${version}` : null);

  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);

  if (item.error?.status === 403) return <Forbidden logged>This item belongs to a case you are not assigned to.</Forbidden>;
  if (item.error?.status === 404 || item.error?.status === 400) return <NotFound what="evidence item" />;
  if (item.error) return <ErrorNote error={item.error} />;
  if (!item.data) return <Loading label="Opening evidence" />;

  const ev = item.data.evidence;
  const pending = transfers.data?.transfers.find((t) => t.status === 'pending');
  const closed = ev.caseStatus === 'closed';
  const showTransferForm = !closed && !pending && canRequestTransfer(user, ev);

  async function verify() {
    setBusy('verify');
    setActionError(null);
    try {
      const res = await api(`/evidence/${ev.id}/verify`, { method: 'POST' });
      setResult(res.result);
      refresh();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  async function downloadOriginal() {
    setBusy('download');
    setActionError(null);
    try {
      await download(`/evidence/${ev.id}/download`, ev.originalName);
      refresh();
    } catch (err) {
      if (err.body?.result) setResult(err.body.result);
      setActionError(err);
      refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <p className="crumbs">
        <Link to={`/cases/${ev.caseId}`}>← Case {ev.caseNumber}</Link>
      </p>
      <PageHeader
        kicker={
          <>
            <Tag large>{ev.evidenceCode}</Tag>
            <Status value={ev.integrityStatus} label={INTEGRITY_LABEL[ev.integrityStatus]} />
            {closed && <Status value="closed" label="Case closed" />}
          </>
        }
        title={ev.title}
        actions={
          <>
            <button type="button" className="btn btn-primary" onClick={verify} disabled={Boolean(busy)}>
              {busy === 'verify' ? 'Checking…' : 'Verify integrity'}
            </button>
            {canDownload(user) && (
              <button type="button" className="btn" onClick={downloadOriginal} disabled={Boolean(busy)}>
                {busy === 'download' ? 'Checking, then downloading…' : 'Download original'}
              </button>
            )}
            <Link className="btn" to={`/evidence/${ev.id}/report`}>
              Custody report
            </Link>
          </>
        }
      >
        Registered by {ev.registeredByName} on <span className="mono">{formatDateTime(ev.createdAt)}</span>
        {ev.lastVerifiedAt && (
          <>
            {' '}
            · last checked <span className="mono">{formatDateTime(ev.lastVerifiedAt)}</span>
          </>
        )}
      </PageHeader>

      <ErrorNote error={actionError} />
      {result && <IntegrityResult result={result} />}

      <div className="evidence-grid">
        <div className="evidence-main">
          <Panel title="Fingerprint">
            <p className="fingerprint-label">SHA-256 of the original file, computed at intake</p>
            <Hash value={ev.sha256} label="SHA-256 of the original file" />
            <dl className="facts facts-cols">
              <div>
                <dt>File name</dt>
                <dd className="mono">{ev.originalName}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>
                  {formatBytes(ev.sizeBytes)} <span className="muted">({ev.sizeBytes.toLocaleString('en')} bytes)</span>
                </dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd className="mono">{ev.mimeType}</dd>
              </div>
              <div>
                <dt>Stored file (encrypted) SHA-256</dt>
                <dd>
                  <Hash value={ev.storedFileSha256} compact />
                </dd>
              </div>
            </dl>
            {ev.description && <p className="evidence-description">{ev.description}</p>}
          </Panel>

          <Panel title="Collection">
            <CollectionDetails metadata={ev.collectionMetadata} />
          </Panel>

          <Panel title="History" meta={history.data && <span className="count">{history.data.history.length} entries</span>}>
            <ErrorNote error={history.error} />
            {history.data ? <HistoryTimeline entries={history.data.history} /> : <Loading label="Loading history" />}
          </Panel>
        </div>

        <aside className="evidence-side">
          <Panel title="Custody">
            <p className="kicker">Current custodian</p>
            <p className="custodian">
              {ev.currentCustodianName}
              {ev.currentCustodianId === user.id && <span className="member-flag">You</span>}
            </p>

            {pending && <PendingTransfer transfer={pending} user={user} onDone={refresh} />}
            {showTransferForm && <TransferForm key={version} evidence={ev} onDone={refresh} />}
            {closed && <p className="panel-hint">The case is closed, so custody cannot be transferred.</p>}
            {!closed && !pending && !canRequestTransfer(user, ev) && user.role !== 'auditor' && (
              <p className="panel-hint">Only the current custodian or an administrator can hand this item over.</p>
            )}
          </Panel>

          <Panel title="Transfers" meta={transfers.data && <span className="count">{transfers.data.transfers.length}</span>}>
            {transfers.data?.transfers.length ? (
              <ol className="transfer-log">
                {transfers.data.transfers.map((t) => (
                  <li key={t.id}>
                    <div className="transfer-log-head">
                      <Status value={t.status} />
                      <span className="mono muted">{formatDateTime(t.decidedAt || t.requestedAt)}</span>
                    </div>
                    <p>
                      {t.from.fullName} → {t.to.fullName} <RoleBadgeInline role={t.to.role} />
                    </p>
                    <p className="muted">“{t.reason}”</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">No transfers yet. The person who registered it still holds it.</p>
            )}
          </Panel>
        </aside>
      </div>
    </>
  );
}

function RoleBadgeInline({ role }) {
  return (
    <span className="role-inline">
      <RoleBadge role={role} />
    </span>
  );
}
