import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { useResource } from '../api/useResource.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { shortHash } from '../components/evidence.jsx';
import { Empty, ErrorNote, Loading, PageHeader, Status, Tag } from '../components/ui.jsx';
import { formatBytes, formatDate } from '../format.js';
import { canRegisterEvidence } from '../roles.js';

export default function EvidenceList() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const [draft, setDraft] = useState(q);

  // Search as you type, after a short pause; the query lives in the URL so it survives reloads.
  useEffect(() => {
    const t = setTimeout(() => {
      if (draft.trim() !== q) setParams(draft.trim() ? { q: draft.trim() } : {}, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [draft, q, setParams]);

  const { data, error, loading } = useResource(`/evidence${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const items = data?.evidence || [];

  return (
    <>
      <PageHeader
        kicker="Register · Evidence"
        title="Evidence"
        actions={
          canRegisterEvidence(user) && (
            <Link className="btn btn-primary" to="/evidence/new">
              Register evidence
            </Link>
          )
        }
      >
        {user.role === 'investigator' ? 'Items in the cases you are assigned to.' : 'Every registered item.'}
      </PageHeader>

      <div className="toolbar">
        <input
          type="search"
          className="search search-wide"
          placeholder="Search by evidence code, title, case number, or the first 6+ characters of a SHA-256"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Search evidence"
        />
        {data && <span className="count">{items.length === 500 ? 'First 500 items' : `${items.length} item${items.length === 1 ? '' : 's'}`}</span>}
      </div>

      <ErrorNote error={error} />
      {loading && !data && <Loading label="Loading evidence" />}

      {data &&
        (items.length === 0 ? (
          <Empty title={q ? 'Nothing matches that search' : 'No evidence registered yet'}>
            {q && /^[0-9a-f]{1,5}$/i.test(q) ? 'Hash searches need at least 6 characters.' : null}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Title</th>
                  <th scope="col">Case</th>
                  <th scope="col">Custodian</th>
                  <th scope="col">Integrity</th>
                  <th scope="col">SHA-256</th>
                  <th scope="col">Registered</th>
                </tr>
              </thead>
              <tbody className="stagger">
                {items.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link to={`/evidence/${e.id}`} className="row-link">
                        <Tag>{e.evidenceCode}</Tag>
                      </Link>
                    </td>
                    <td className="cell-title">
                      <Link to={`/evidence/${e.id}`}>{e.title}</Link>
                      <span className="cell-sub mono">
                        {e.originalName} · {formatBytes(e.sizeBytes)}
                      </span>
                    </td>
                    <td>
                      <Link to={`/cases/${e.caseId}`} className="mono">
                        {e.caseNumber}
                      </Link>
                    </td>
                    <td>{e.currentCustodianName}</td>
                    <td>
                      <Status value={e.integrityStatus} />
                    </td>
                    <td className="mono muted" title={e.sha256}>
                      {shortHash(e.sha256)}
                    </td>
                    <td className="mono">{formatDate(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </>
  );
}
