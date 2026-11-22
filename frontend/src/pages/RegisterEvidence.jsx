import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { sha256Hex, upload } from '../api/client.js';
import { useResource } from '../api/useResource.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Hash } from '../components/evidence.jsx';
import { ErrorNote, PageHeader, Tag } from '../components/ui.jsx';
import { formatBytes } from '../format.js';

const MAX_BYTES = 100 * 1024 * 1024; // matches the API's MAX_UPLOAD_MB default

/** Local "now" for a datetime-local input (no seconds). */
function nowLocal() {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function RegisterEvidence() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const casesRes = useResource('/cases?status=open');
  const fileInput = useRef(null);

  const [caseId, setCaseId] = useState(params.get('caseId') || '');
  const [file, setFile] = useState(null);
  const [localHash, setLocalHash] = useState(null);
  const [hashing, setHashing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [form, setForm] = useState({
    title: '',
    description: '',
    collectedAt: nowLocal(),
    collectionLocation: '',
    sourceDevice: '',
    collectionNotes: '',
  });
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // { evidence, warnings }

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const openCases = casesRes.data?.cases || [];
  const selectedCase = useMemo(() => openCases.find((c) => String(c.id) === String(caseId)), [openCases, caseId]);

  async function chooseFile(f) {
    setError(null);
    setLocalHash(null);
    if (!f) return setFile(null);
    if (f.size > MAX_BYTES) {
      setFile(null);
      setError(new Error(`${f.name} is ${formatBytes(f.size)}; the limit is 100 MB.`));
      return;
    }
    setFile(f);
    if (!form.title) setForm((prev) => ({ ...prev, title: f.name.replace(/\.[^.]+$/, '') }));
    setHashing(true);
    try {
      setLocalHash(await sha256Hex(f));
    } catch {
      setLocalHash(null); // Web Crypto unavailable (not localhost/HTTPS): the server hash still applies
    } finally {
      setHashing(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setError(null);
    const data = new FormData();
    data.append('caseId', caseId);
    data.append('title', form.title.trim());
    if (form.description.trim()) data.append('description', form.description.trim());
    if (form.collectedAt) data.append('collectedAt', new Date(form.collectedAt).toISOString());
    // "Collected by" is not sent: the API records the signed-in user's name.
    for (const k of ['collectionLocation', 'sourceDevice', 'collectionNotes']) {
      if (form[k].trim()) data.append(k, form[k].trim());
    }
    data.append('file', file, file.name); // file last, after the text fields
    setProgress(0);
    try {
      const res = await upload('/evidence', data, setProgress);
      setDone(res);
    } catch (err) {
      setError(err);
      setProgress(null);
    }
  }

  if (done) {
    const ev = done.evidence;
    const matches = localHash ? localHash === ev.sha256 : null;
    return (
      <>
        <PageHeader kicker="Intake complete" title="Evidence registered" />
        <div className="sheet sheet-done">
          <p className="kicker">
            <Tag large>{ev.evidenceCode}</Tag>
          </p>
          <h2>{ev.title}</h2>
          <p className="fingerprint-label">SHA-256 recorded by the server</p>
          <Hash value={ev.sha256} />
          {matches !== null && (
            <p className={`hash-check ${matches ? 'hash-check-ok' : 'hash-check-bad'}`}>
              {matches
                ? '✓ Matches the hash your browser computed before upload: the file arrived unchanged.'
                : '✗ Does NOT match the hash your browser computed. Do not rely on this item; register it again.'}
            </p>
          )}
          {done.warnings?.map((w) => (
            <div key={w.type} className="note note-info">
              <strong>Duplicate file.</strong> {w.message}
            </div>
          ))}
          <div className="sheet-actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate(`/evidence/${ev.id}`)}>
              Open the item
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDone(null);
                setFile(null);
                setLocalHash(null);
                setProgress(null);
                setForm((f) => ({ ...f, title: '', description: '', sourceDevice: '', collectionNotes: '' }));
              }}
            >
              Register another in this case
            </button>
          </div>
        </div>
      </>
    );
  }

  const uploading = progress !== null;
  const canSubmit = caseId && file && form.title.trim() && !uploading && !hashing;

  return (
    <>
      <p className="crumbs">
        <Link to={selectedCase ? `/cases/${selectedCase.id}` : '/evidence'}>← {selectedCase ? `Case ${selectedCase.caseNumber}` : 'Evidence'}</Link>
      </p>
      <PageHeader kicker="Intake" title="Register evidence">
        The file is fingerprinted with SHA-256 and stored encrypted. It cannot be changed or replaced afterwards.
      </PageHeader>

      <form className="register" onSubmit={submit}>
        <ErrorNote error={error || casesRes.error} />

        <section className="sheet">
          <div className="sheet-head">
            <p className="kicker">1 · File</p>
          </div>
          <div
            className={`dropzone${dragging ? ' dropzone-over' : ''}${file ? ' dropzone-has' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!uploading) chooseFile(e.dataTransfer.files[0]);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              id="evidence-file"
              className="visually-hidden"
              onChange={(e) => chooseFile(e.target.files[0])}
              disabled={uploading}
            />
            {file ? (
              <div className="dropzone-file">
                <p className="mono">{file.name}</p>
                <p className="muted">
                  {formatBytes(file.size)} · {file.type || 'unknown type'}
                </p>
                <p className="fingerprint-label">SHA-256 computed in your browser</p>
                {hashing ? <p className="muted mono">Computing…</p> : localHash ? <Hash value={localHash} compact /> : <p className="muted">Not available in this browser.</p>}
                <label htmlFor="evidence-file" className="btn btn-small">
                  Choose a different file
                </label>
              </div>
            ) : (
              <label htmlFor="evidence-file" className="dropzone-empty">
                <strong>Drop the file here</strong>
                <span>or click to choose · up to 100 MB</span>
              </label>
            )}
          </div>
        </section>

        <section className="sheet">
          <div className="sheet-head">
            <p className="kicker">2 · Description</p>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>Case</span>
              <select value={caseId} onChange={(e) => setCaseId(e.target.value)} required disabled={uploading}>
                <option value="">{casesRes.loading ? 'Loading…' : 'Choose an open case…'}</option>
                {openCases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.caseNumber} · {c.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Title</span>
              <input value={form.title} onChange={set('title')} maxLength={200} required disabled={uploading} />
            </label>
            <label className="field field-full">
              <span>
                Description <em>optional</em>
              </span>
              <textarea rows={2} value={form.description} onChange={set('description')} maxLength={5000} disabled={uploading} />
            </label>
          </div>
        </section>

        <section className="sheet">
          <div className="sheet-head">
            <p className="kicker">3 · Collection</p>
          </div>
          <div className="form-grid form-grid-2">
            <label className="field">
              <span>Collected at</span>
              <input type="datetime-local" value={form.collectedAt} onChange={set('collectedAt')} max={nowLocal()} disabled={uploading} />
            </label>
            <label className="field">
              <span>Collected by</span>
              <input value={user.fullName} readOnly aria-readonly="true" className="input-locked" />
              <small className="field-hint">Recorded as the person registering this item.</small>
            </label>
            <label className="field">
              <span>Location</span>
              <input value={form.collectionLocation} onChange={set('collectionLocation')} maxLength={300} placeholder="e.g. Kicukiro, Kigali" disabled={uploading} />
            </label>
            <label className="field">
              <span>Source device</span>
              <input value={form.sourceDevice} onChange={set('sourceDevice')} maxLength={300} placeholder="e.g. Samsung A14, IMEI …" disabled={uploading} />
            </label>
            <label className="field field-full">
              <span>
                Notes <em>optional</em>
              </span>
              <textarea rows={2} value={form.collectionNotes} onChange={set('collectionNotes')} maxLength={2000} disabled={uploading} />
            </label>
          </div>
        </section>

        <div className="register-submit">
          {uploading && (
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
              <p className="mono">{progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Hashing, encrypting and recording…'}</p>
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {uploading ? 'Registering…' : 'Register evidence'}
          </button>
        </div>
      </form>
    </>
  );
}
