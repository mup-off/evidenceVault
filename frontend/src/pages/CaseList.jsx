import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { api } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Empty, ErrorNote, Loading, PageHeader, Status, Tag } from '../components/ui.jsx';
import { formatDate } from '../format.js';
import { canCreateCase } from '../roles.js';

function NewCaseForm({ onCancel }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ caseNumber: '', title: '', description: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { caseNumber: form.caseNumber.trim(), title: form.title.trim() };
      if (form.description.trim()) body.description = form.description.trim();
      const { case: created } = await api('/cases', { method: 'POST', body });
      navigate(`/cases/${created.id}`);
    } catch (err) {
      setError(err.status === 409 ? new Error(`Case number ${form.caseNumber.trim()} is already in use.`) : err);
      setBusy(false);
    }
  }

  return (
    <form className="sheet" onSubmit={submit}>
      <div className="sheet-head">
        <p className="kicker">New file</p>
        <h2>Open a case</h2>
      </div>
      <ErrorNote error={error} />
      <div className="form-grid">
        <label className="field">
          <span>Case number</span>
          <input className="mono" value={form.caseNumber} onChange={set('caseNumber')} placeholder="RIB-2026-0001" maxLength={50} required autoFocus />
        </label>
        <label className="field field-wide">
          <span>Title</span>
          <input value={form.title} onChange={set('title')} placeholder="Short description of the investigation" maxLength={200} required />
        </label>
        <label className="field field-full">
          <span>
            Description <em>optional</em>
          </span>
          <textarea rows={3} value={form.description} onChange={set('description')} maxLength={5000} />
        </label>
      </div>
      <div className="sheet-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !form.caseNumber.trim() || !form.title.trim()}>
          {busy ? 'Opening…' : 'Open case'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const FILTERS = [
  ['', 'All'],
  ['open', 'Open'],
  ['closed', 'Closed'],
];

export default function CaseList() {
  const { user } = useAuth();
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const { data, error, loading } = useResource(`/cases${status ? `?status=${status}` : ''}`);

  const cases = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data?.cases || [];
    if (!q) return list;
    return list.filter((c) => c.caseNumber.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
  }, [data, query]);

  return (
    <>
      <PageHeader
        kicker="Register · Cases"
        title="Cases"
        actions={
          canCreateCase(user) &&
          !creating && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              New case
            </button>
          )
        }
      >
        {user.role === 'investigator' ? 'Cases you are assigned to.' : 'Every case on file.'}
      </PageHeader>

      {creating && <NewCaseForm onCancel={() => setCreating(false)} />}

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter by status">
          {FILTERS.map(([value, label]) => (
            <button key={label} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="search"
          placeholder="Search case number or title"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search cases"
        />
      </div>

      <ErrorNote error={error} />
      {loading && !data && <Loading label="Loading cases" />}

      {data &&
        (cases.length === 0 ? (
          <Empty title={query ? 'No cases match your search' : 'No cases yet'}>
            {!query && canCreateCase(user) ? 'Open the first case with “New case”.' : null}
            {!query && user.role === 'investigator' ? ' Cases appear here once you are assigned to them.' : null}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Opened by</th>
                  <th scope="col">Opened</th>
                </tr>
              </thead>
              <tbody className="stagger">
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/cases/${c.id}`} className="row-link">
                        <Tag>{c.caseNumber}</Tag>
                      </Link>
                    </td>
                    <td className="cell-title">
                      <Link to={`/cases/${c.id}`}>{c.title}</Link>
                    </td>
                    <td>
                      <Status value={c.status} />
                    </td>
                    <td>{c.createdByName}</td>
                    <td className="mono">{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </>
  );
}
