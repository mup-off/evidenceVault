import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { api } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import { CollectionDetails, Hash, HistoryTimeline, IntegrityResult } from '../components/evidence.jsx';
import { ErrorNote, Forbidden, Loading, NotFound, PageHeader, Status, Tag } from '../components/ui.jsx';
import { formatBytes, formatDateTime } from '../format.js';
import { ROLE_LABELS } from '../roles.js';

/**
 * Generating a report is an audited action (it runs an integrity check, logs
 * REPORT_GENERATED and anchors the audit chain head), so it happens only when
 * the user presses the button, never on page load.
 */
export default function Report() {
  const { id } = useParams();
  const item = useResource(`/evidence/${encodeURIComponent(id)}`);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (item.error?.status === 403) return <Forbidden logged>This item belongs to a case you are not assigned to.</Forbidden>;
  if (item.error?.status === 404 || item.error?.status === 400) return <NotFound what="evidence item" />;
  if (item.error) return <ErrorNote error={item.error} />;
  if (!item.data) return <Loading />;
  const ev = item.data.evidence;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await api(`/evidence/${ev.id}/report`);
      setReport(res.report);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="no-print">
        <p className="crumbs">
          <Link to={`/evidence/${ev.id}`}>← {ev.evidenceCode}</Link>
        </p>
        <PageHeader
          kicker={<Tag large>{ev.evidenceCode}</Tag>}
          title="Chain-of-custody report"
          actions={
            <>
              <button type="button" className="btn btn-primary" onClick={generate} disabled={busy}>
                {busy ? 'Checking integrity…' : report ? 'Generate again' : 'Generate report'}
              </button>
              {report && (
                <button type="button" className="btn" onClick={() => window.print()}>
                  Print / save as PDF
                </button>
              )}
            </>
          }
        >
          Generating runs a fresh integrity check, is recorded in the audit log, and seals the report to the current
          audit chain head.
        </PageHeader>
        <ErrorNote error={error} />
      </div>

      {report && <ReportDocument report={report} />}
    </>
  );
}

function ReportDocument({ report: r }) {
  const ev = r.evidence;
  return (
    <article className="report">
      <header className="report-head">
        <div>
          <p className="report-org">EvidenceVault Rwanda</p>
          <h1>Chain-of-Custody Report</h1>
        </div>
        <div className="report-id">
          <Tag large>{ev.evidenceCode}</Tag>
          <p className="mono">Generated {formatDateTime(r.generatedAt)}</p>
          <p>
            by {r.generatedBy.fullName}, {ROLE_LABELS[r.generatedBy.role]}
          </p>
        </div>
      </header>

      <section className="report-section">
        <h2>1. Item</h2>
        <dl className="facts facts-cols">
          <div>
            <dt>Title</dt>
            <dd>{ev.title}</dd>
          </div>
          <div>
            <dt>Case</dt>
            <dd>
              <span className="mono">{r.case.caseNumber}</span> · {r.case.title} ({r.case.status})
            </dd>
          </div>
          <div>
            <dt>Original file</dt>
            <dd className="mono">{ev.originalName}</dd>
          </div>
          <div>
            <dt>Size and type</dt>
            <dd>
              {formatBytes(ev.sizeBytes)} ({ev.sizeBytes.toLocaleString('en')} bytes) · <span className="mono">{ev.mimeType}</span>
            </dd>
          </div>
          <div>
            <dt>Registered</dt>
            <dd>
              {formatDateTime(ev.createdAt)} by {ev.registeredByName}
            </dd>
          </div>
          <div>
            <dt>Current custodian</dt>
            <dd>
              {r.custody.current.fullName}, {ROLE_LABELS[r.custody.current.role]}
            </dd>
          </div>
        </dl>
        <p className="fingerprint-label">SHA-256 of the original file (recorded at intake)</p>
        <Hash value={ev.sha256} />
        {ev.description && <p className="evidence-description">{ev.description}</p>}
      </section>

      <section className="report-section">
        <h2>2. Integrity check at the time of this report</h2>
        <IntegrityResult result={r.integrity} />
      </section>

      <section className="report-section">
        <h2>3. Collection</h2>
        <CollectionDetails metadata={ev.collectionMetadata} />
      </section>

      <section className="report-section">
        <h2>4. Custody transfers</h2>
        {r.custody.transfers.length === 0 ? (
          <p>No transfers. The item has stayed with {ev.registeredByName} since registration.</p>
        ) : (
          <table className="table report-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Requested</th>
                <th scope="col">From → To</th>
                <th scope="col">Reason</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {r.custody.transfers.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.id}</td>
                  <td className="mono">{formatDateTime(t.requestedAt)}</td>
                  <td>
                    {t.from.fullName} → {t.to.fullName}
                    {t.reassignment && <span className="cell-sub">Reassigned by {t.requestedBy.fullName}</span>}
                  </td>
                  <td>{t.reason}</td>
                  <td>
                    <Status value={t.status} />
                    {t.decidedAt && (
                      <span className="cell-sub mono">
                        {formatDateTime(t.decidedAt)}
                        {t.decisionNote && ` · “${t.decisionNote}”`}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="report-section">
        <h2>5. Full history ({r.history.length} audit entries)</h2>
        <HistoryTimeline entries={r.history} />
      </section>

      <section className="report-section report-seal">
        <h2>6. Audit chain seal</h2>
        <p>
          This report is sealed to audit entry <strong className="mono">#{r.chainHead.seq}</strong>, the newest entry when it
          was generated. The entry and its hash are recorded as anchor <span className="mono">#{r.chainHead.anchorId}</span>.
          If any earlier entry is later edited or deleted, the chain check will fail.
        </p>
        <p className="fingerprint-label">Chain head hash (HMAC-SHA256)</p>
        <Hash value={r.chainHead.entryHash} />
      </section>

      <section className="report-signatures">
        <div>
          <span />
          <p>Custodian: signature and date</p>
        </div>
        <div>
          <span />
          <p>Reviewed by: name, signature and date</p>
        </div>
      </section>
    </article>
  );
}
