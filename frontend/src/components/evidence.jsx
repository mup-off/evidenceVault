// Pieces shared by the evidence detail page and the printable report.

import { formatBytes, formatDateTime } from '../format.js';
import { Status } from './ui.jsx';

/** A SHA-256 in four groups of 16 so people can compare it by eye. */
export function Hash({ value, label, compact = false, match }) {
  if (!value) return <span className="hash hash-missing">not available</span>;
  const groups = value.match(/.{1,16}/g);
  return (
    <span className={`hash${compact ? ' hash-compact' : ''}${match === false ? ' hash-bad' : ''}`} aria-label={label}>
      {groups.map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </span>
  );
}

export const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');

export const INTEGRITY_REASONS = {
  FILE_MISSING: 'The stored file is missing.',
  STORED_FILE_CHANGED: 'The stored (encrypted) file no longer matches the hash recorded at intake.',
  DECRYPTION_AUTH_FAILED: 'Decryption authentication failed: the encrypted file was altered.',
  KEY_UNAVAILABLE: 'The encryption key for this item is not available on the server.',
  ORIGINAL_HASH_MISMATCH: 'The decrypted file does not match the original SHA-256.',
};

/** Recorded vs current hashes, with the verdict. result is the API's integrity result. */
export function IntegrityResult({ result }) {
  const ok = result.status === 'verified';
  const rows = [
    ['Original file (SHA-256)', result.recorded.sha256, result.current.sha256],
    ['Stored encrypted file (SHA-256)', result.recorded.storedFileSha256, result.current.storedFileSha256],
  ];
  return (
    <div className={`verdict ${ok ? 'verdict-ok' : 'verdict-bad'}`} role="status">
      <div className="verdict-head">
        <span className="verdict-stamp">{ok ? 'Verified' : 'Failed'}</span>
        <span className="mono verdict-time">Checked {formatDateTime(result.checkedAt)}</span>
      </div>
      {ok ? (
        <p>Both hashes match the values recorded at intake, and the file decrypted and authenticated correctly.</p>
      ) : (
        <ul className="verdict-reasons">
          {result.reasons.map((r) => (
            <li key={r}>{INTEGRITY_REASONS[r] || r}</li>
          ))}
        </ul>
      )}
      <dl className="hash-compare">
        {rows.map(([label, recorded, current]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <span className="hash-role">Recorded</span>
              <Hash value={recorded} compact />
            </dd>
            <dd>
              <span className="hash-role">Now</span>
              <Hash value={current} compact match={current ? current === recorded : false} />
              <span className={`match ${current && current === recorded ? 'match-yes' : 'match-no'}`}>
                {current && current === recorded ? 'match' : current ? 'differs' : 'could not compute'}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const ACTION_LABELS = {
  EVIDENCE_REGISTERED: 'Registered',
  INTEGRITY_VERIFIED: 'Integrity verified',
  INTEGRITY_FAILED: 'Integrity check failed',
  EVIDENCE_DOWNLOADED: 'Original downloaded',
  DOWNLOAD_BLOCKED: 'Download blocked',
  CUSTODY_TRANSFER_REQUESTED: 'Transfer requested',
  CUSTODY_REASSIGNED: 'Reassignment requested (administrator)',
  CUSTODY_TRANSFER_ACCEPTED: 'Custody accepted',
  CUSTODY_TRANSFER_REJECTED: 'Transfer rejected',
  CUSTODY_TRANSFER_CANCELLED: 'Transfer cancelled',
  REPORT_GENERATED: 'Chain-of-custody report generated',
  ACCESS_DENIED: 'Access refused',
};

export const actionLabel = (action) =>
  ACTION_LABELS[action] || action.charAt(0) + action.slice(1).toLowerCase().replace(/_/g, ' ');

const TONE = {
  INTEGRITY_FAILED: 'bad',
  DOWNLOAD_BLOCKED: 'bad',
  ACCESS_DENIED: 'bad',
  CUSTODY_TRANSFER_ACCEPTED: 'key',
  EVIDENCE_REGISTERED: 'key',
  CUSTODY_REASSIGNED: 'warn',
};

const TRIGGERS = { manual: 'on request', download: 'before download', report: 'for a report' };

/** One line of plain-language detail for an audit entry about an item. */
function entryDetail(entry) {
  const d = entry.details || {};
  switch (entry.action) {
    case 'EVIDENCE_REGISTERED':
      return `${d.originalName} · ${formatBytes(d.sizeBytes)}${d.duplicateOf?.length ? ` · duplicate of ${d.duplicateOf.join(', ')}` : ''}`;
    case 'INTEGRITY_VERIFIED':
      return `Checked ${TRIGGERS[d.trigger] || d.trigger}`;
    case 'INTEGRITY_FAILED':
      return `Checked ${TRIGGERS[d.trigger] || d.trigger}: ${(d.reasons || []).map((r) => INTEGRITY_REASONS[r] || r).join(' ')}`;
    case 'DOWNLOAD_BLOCKED':
      return (d.reasons || []).map((r) => INTEGRITY_REASONS[r] || r).join(' ');
    case 'CUSTODY_TRANSFER_REQUESTED':
    case 'CUSTODY_REASSIGNED':
      return `To ${d.toName || `user #${d.toUserId}`}. Reason: “${d.reason}”`;
    case 'CUSTODY_TRANSFER_ACCEPTED':
    case 'CUSTODY_TRANSFER_REJECTED':
    case 'CUSTODY_TRANSFER_CANCELLED':
      return d.note ? `Note: “${d.note}”` : `Transfer #${d.transferId}`;
    case 'REPORT_GENERATED':
      return `Integrity at the time: ${d.integrityStatus}`;
    case 'ACCESS_DENIED':
      return d.reason;
    default:
      return null;
  }
}

/** Vertical timeline of an item's audit entries, oldest first. */
export function HistoryTimeline({ entries }) {
  return (
    <ol className="timeline">
      {entries.map((e) => {
        const detail = entryDetail(e);
        return (
          <li key={e.seq} className={`tl tl-${TONE[e.action] || 'plain'}`}>
            <div className="tl-when mono">{formatDateTime(e.ts)}</div>
            <div className="tl-body">
              <p className="tl-what">
                {actionLabel(e.action)}
                {e.action === 'INTEGRITY_FAILED' && <Status value="failed" label="Failed" />}
              </p>
              <p className="tl-who">{e.userName || (e.userId ? `User #${e.userId}` : 'System')}</p>
              {detail && <p className="tl-detail">{detail}</p>}
              <p className="tl-seal mono" title={e.entryHash}>
                #{e.seq} · {shortHash(e.entryHash)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Collection metadata as a definition list. */
export function CollectionDetails({ metadata }) {
  const fields = [
    ['collectedAt', 'Collected at', (v) => formatDateTime(v)],
    ['collectedBy', 'Collected by'],
    ['collectionLocation', 'Location'],
    ['sourceDevice', 'Source device'],
    ['collectionNotes', 'Notes'],
  ].filter(([k]) => metadata?.[k]);
  if (fields.length === 0) return <p className="muted">No collection details were recorded.</p>;
  return (
    <dl className="facts">
      {fields.map(([k, label, fmt]) => (
        <div key={k}>
          <dt>{label}</dt>
          <dd>{fmt ? fmt(metadata[k]) : metadata[k]}</dd>
        </div>
      ))}
    </dl>
  );
}
