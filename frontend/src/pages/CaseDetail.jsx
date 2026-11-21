import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { api } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Empty, ErrorNote, Forbidden, Loading, NotFound, PageHeader, Panel, Status, Tag } from '../components/ui.jsx';
import { formatDate, formatDateTime } from '../format.js';
import { canManageCase, canRegisterEvidence, canReopenCase } from '../roles.js';

function EditCase({ caseRow, onSaved, onCancel }) {
  const [title, setTitle] = useState(caseRow.title);
  const [description, setDescription] = useState(caseRow.description || '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/cases/${caseRow.id}`, { method: 'PATCH', body: { title: title.trim(), description: description.trim() } });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form className="sheet" onSubmit={submit}>
      <ErrorNote error={error} />
      <div className="form-grid">
        <label className="field field-full">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
        </label>
        <label className="field field-full">
          <span>Description</span>
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
        </label>
      </div>
      <div className="sheet-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Members({ caseRow, members, manage, onChange }) {
  const directory = useResource(manage ? '/users/directory?role=investigator' : null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const memberIds = new Set(members.map((m) => m.id));
  const candidates = (directory.data?.users || []).filter((u) => !memberIds.has(u.id));

  async function run(request) {
    setBusy(true);
    setError(null);
    try {
      await request();
      setSelected('');
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const add = (event) => {
    event.preventDefault();
    run(() => api(`/cases/${caseRow.id}/members`, { method: 'POST', body: { userId: Number(selected) } }));
  };
  const remove = (member) => {
    if (!window.confirm(`Remove ${member.fullName} from case ${caseRow.caseNumber}? They will lose access to its evidence.`)) return;
    run(() => api(`/cases/${caseRow.id}/members/${member.id}`, { method: 'DELETE' }));
  };

  return (
    <Panel title="Assigned investigators" meta={<span className="count">{members.length}</span>}>
      <p className="panel-hint">Administrators, custodians and auditors can see every case; investigators only see cases listed here.</p>
      <ErrorNote error={error} />
      {members.length === 0 ? (
        <Empty title="No investigators assigned" />
      ) : (
        <ul className="members">
          {members.map((m) => (
            <li key={m.id}>
              <div>
                <p className="member-name">
                  {m.fullName}
                  {m.id === caseRow.createdBy && <span className="member-flag">Opened the case</span>}
                </p>
                <p className="member-meta mono">
                  {m.email} · since {formatDate(m.addedAt)}
                </p>
              </div>
              {manage && m.id !== caseRow.createdBy && (
                <button type="button" className="btn btn-small btn-quiet" onClick={() => remove(m)} disabled={busy}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {manage && (
        <form className="add-member" onSubmit={add}>
          <label className="field">
            <span>Assign an investigator</span>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={busy || directory.loading}>
              <option value="">{candidates.length ? 'Choose…' : 'Everyone is already assigned'}</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn" disabled={busy || !selected}>
            Assign
          </button>
        </form>
      )}
    </Panel>
  );
}

function CaseEvidence({ caseId, canRegister }) {
  const { data, error, loading } = useResource(`/evidence?caseId=${caseId}`);
  return (
    <Panel
      title="Evidence"
      meta={
        <>
          {data && <span className="count">{data.evidence.length}</span>}
          {canRegister && (
            <Link className="btn btn-small btn-primary" to={`/evidence/new?caseId=${caseId}`}>
              Register evidence
            </Link>
          )}
        </>
      }
    >
      <ErrorNote error={error} />
      {loading && !data && <Loading label="Loading evidence" />}
      {data &&
        (data.evidence.length === 0 ? (
          <Empty title="No evidence registered">{canRegister ? 'Use “Register evidence” to add the first item.' : null}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Title</th>
                  <th scope="col">Custodian</th>
                  <th scope="col">Integrity</th>
                  <th scope="col">Registered</th>
                </tr>
              </thead>
              <tbody>
                {data.evidence.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link to={`/evidence/${e.id}`}>
                        <Tag>{e.evidenceCode}</Tag>
                      </Link>
                    </td>
                    <td className="cell-title">{e.title}</td>
                    <td>{e.currentCustodianName}</td>
                    <td>
                      <Status value={e.integrityStatus} />
                    </td>
                    <td className="mono">{formatDate(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Panel>
  );
}

export default function CaseDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data, error, loading, reload } = useResource(`/cases/${encodeURIComponent(id)}`);
  const [editing, setEditing] = useState(false);
  const [statusError, setStatusError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (error?.status === 403) return <Forbidden>You are not assigned to this case.</Forbidden>;
  if (error?.status === 404 || error?.status === 400) return <NotFound what="case" />;
  if (loading && !data) return <Loading label="Opening case" />;
  if (error) return <ErrorNote error={error} />;

  const c = data.case;
  const manage = canManageCase(user, c);

  async function setCaseStatus(next) {
    const question =
      next === 'closed'
        ? `Close case ${c.caseNumber}? It becomes read-only: no new evidence and no custody transfers.`
        : `Reopen case ${c.caseNumber}?`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setStatusError(null);
    try {
      await api(`/cases/${c.id}`, { method: 'PATCH', body: { status: next } });
      reload();
    } catch (err) {
      setStatusError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="crumbs">
        <Link to="/cases">← All cases</Link>
      </p>
      <PageHeader
        kicker={
          <>
            <Tag large>{c.caseNumber}</Tag> <Status value={c.status} />
          </>
        }
        title={c.title}
        actions={
          <>
            {manage && !editing && (
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            {manage && c.status === 'open' && (
              <button type="button" className="btn btn-danger" onClick={() => setCaseStatus('closed')} disabled={busy}>
                Close case
              </button>
            )}
            {c.status === 'closed' && canReopenCase(user) && (
              <button type="button" className="btn" onClick={() => setCaseStatus('open')} disabled={busy}>
                Reopen
              </button>
            )}
          </>
        }
      >
        Opened by {c.createdByName} on <span className="mono">{formatDateTime(c.createdAt)}</span>
        {c.closedAt && (
          <>
            {' '}
            · closed <span className="mono">{formatDateTime(c.closedAt)}</span>
          </>
        )}
      </PageHeader>

      <ErrorNote error={statusError} />
      {c.status === 'closed' && (
        <div className="note note-info">This case is closed and read-only. Evidence can still be viewed, verified and reported.</div>
      )}

      {editing ? (
        <EditCase
          caseRow={c}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      ) : (
        c.description && <p className="case-description">{c.description}</p>
      )}

      <div className="case-grid">
        <CaseEvidence caseId={c.id} canRegister={c.status === 'open' && canRegisterEvidence(user)} />
        <Members caseRow={c} members={data.members} manage={manage} onChange={reload} />
      </div>
    </>
  );
}
