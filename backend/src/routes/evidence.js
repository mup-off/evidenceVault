'use strict';

const express = require('express');
const multer = require('multer');
const path = require('node:path');

const config = require('../config');
const { pool, withTransaction } = require('../db');
const { HttpError, asyncHandler } = require('../errors');
const { requireRole } = require('../middleware/auth');
const audit = require('../services/audit');
const cases = require('../services/cases');
const custody = require('../services/custody');
const { SELECT_EVIDENCE, publicEvidence, getViewableEvidence, history } = require('../services/evidence');
const store = require('../services/evidenceStore');
const { sha256, encrypt } = require('../services/fileCrypto');
const integrity = require('../services/integrity');
const validate = require('../validate');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return cleaned || 'unnamed-file';
}

/** Collection metadata from the form: who collected it, when, where, from what. */
function collectionMetadata(input) {
  const meta = {};
  const text = (field, max) => {
    const v = validate.string(input[field], field, { optional: true, max });
    if (v) meta[field] = v;
  };
  if (input.collectedAt) {
    const when = new Date(input.collectedAt);
    if (Number.isNaN(when.getTime())) throw new HttpError(400, 'collectedAt must be a date and time');
    if (when.getTime() > Date.now() + 5 * 60 * 1000) throw new HttpError(400, 'collectedAt cannot be in the future');
    meta.collectedAt = when.toISOString();
  }
  text('collectionLocation', 300);
  text('sourceDevice', 300);
  text('collectionNotes', 2000);
  return meta;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20, fieldSize: 10_000 },
  defParamCharset: 'utf8', // keep non-ASCII file names intact
});

function singleFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, `File is larger than the ${Math.round(config.maxUploadBytes / 1048576)} MB limit`));
      }
      return next(new HttpError(400, `Upload rejected: ${err.message}`));
    }
    return next(err);
  });
}

async function nextEvidenceCode(tx) {
  const { rows } = await tx.query(
    `INSERT INTO evidence_code_counters (year, last_value)
     VALUES (EXTRACT(YEAR FROM now())::int, 1)
     ON CONFLICT (year) DO UPDATE SET last_value = evidence_code_counters.last_value + 1
     RETURNING year, last_value`,
  );
  const { year, last_value: n } = rows[0];
  return `EV-${year}-${String(n).padStart(6, '0')}`;
}

/** Duplicate warning that names existing items only when the uploader may see them. */
async function duplicateWarning(req, fileHash) {
  const { rows } = await pool.query(
    `SELECT e.id, e.evidence_code, e.case_id, c.case_number
       FROM evidence e JOIN cases c ON c.id = e.case_id
      WHERE e.sha256 = $1 ORDER BY e.id`,
    [fileHash],
  );
  if (rows.length === 0) return null;
  const visible = [];
  for (const row of rows) {
    if (await cases.canView(req.user, { id: row.case_id })) {
      visible.push({ id: row.id, evidenceCode: row.evidence_code, caseNumber: row.case_number });
    }
  }
  return {
    type: 'DUPLICATE_FILE',
    message:
      visible.length > 0
        ? `A file with identical contents is already registered as ${visible.map((v) => v.evidenceCode).join(', ')}.`
        : 'A file with identical contents is already registered.',
    existing: visible,
    allCodes: rows.map((r) => r.evidence_code), // for the audit log only; removed before responding
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Register evidence: multipart form with "file", "caseId", "title" and
// optional "description" and collection metadata fields.
router.post(
  '/',
  requireRole('administrator', 'investigator'),
  singleFile,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'file is required (multipart field "file")');
    const input = req.body || {};
    const caseId = validate.id(input.caseId, 'caseId');
    const title = validate.string(input.title, 'title');
    const description = validate.string(input.description, 'description', { optional: true, max: 5000 });
    // "Collected by" is always the person registering; any value sent is ignored.
    const metadata = { ...collectionMetadata(input), collectedBy: req.user.fullName };

    const caseRow = await cases.getViewableCase(req, caseId); // investigators: assigned cases only
    if (caseRow.status === 'closed') {
      throw new HttpError(409, `Case ${caseRow.case_number} is closed; new evidence cannot be registered`);
    }

    // Hash the original before anything is stored.
    const plaintext = req.file.buffer;
    const fileHash = sha256(plaintext);
    const duplicate = await duplicateWarning(req, fileHash);

    const encrypted = encrypt(plaintext);
    const storedHash = sha256(encrypted.ciphertext);
    const storageName = await store.write(encrypted.ciphertext);

    let row;
    try {
      row = await withTransaction(async (tx) => {
        const code = await nextEvidenceCode(tx);
        const { rows } = await tx.query(
          `INSERT INTO evidence (evidence_code, case_id, title, description, original_name, mime_type, size_bytes,
                                 sha256, ciphertext_sha256, storage_name, key_id, iv, auth_tag,
                                 collection_metadata, registered_by, current_custodian_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
           RETURNING id`,
          [
            code,
            caseId,
            title,
            description,
            cleanFileName(req.file.originalname),
            req.file.mimetype || 'application/octet-stream',
            plaintext.length,
            fileHash,
            storedHash,
            storageName,
            encrypted.keyId,
            encrypted.iv,
            encrypted.authTag,
            JSON.stringify(metadata),
            req.user.id,
          ],
        );
        await audit.append(
          {
            ...audit.fromRequest(req),
            action: 'EVIDENCE_REGISTERED',
            entity: 'evidence',
            entityId: rows[0].id,
            details: {
              evidenceCode: code,
              caseNumber: caseRow.case_number,
              title,
              originalName: cleanFileName(req.file.originalname),
              sizeBytes: plaintext.length,
              sha256: fileHash,
              storedFileSha256: storedHash,
              collection: metadata,
              duplicateOf: duplicate ? duplicate.allCodes : undefined,
            },
          },
          tx,
        );
        return rows[0];
      });
    } catch (err) {
      await store.remove(storageName).catch(() => {});
      throw err;
    }

    const { rows } = await pool.query(`${SELECT_EVIDENCE} WHERE e.id = $1`, [row.id]);
    const warnings = [];
    if (duplicate) {
      const { allCodes, ...shown } = duplicate; // eslint-disable-line no-unused-vars
      warnings.push(shown);
    }
    res.status(201).json({ evidence: publicEvidence(rows[0]), warnings });
  }),
);

// List / search. q matches evidence code, title, case number, or a SHA-256 prefix.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const caseId = req.query.caseId ? validate.id(req.query.caseId, 'caseId') : null;
    const q = req.query.q ? validate.string(req.query.q, 'q', { max: 100 }) : null;
    const onlyAssigned = req.user.role === 'investigator';
    const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const hashPrefix = q && /^[0-9a-fA-F]{6,64}$/.test(q) ? `${q.toLowerCase()}%` : null;

    const { rows } = await pool.query(
      `${SELECT_EVIDENCE}
        WHERE ($1::bigint IS NULL OR e.case_id = $1)
          AND (NOT $2 OR EXISTS (SELECT 1 FROM case_members m WHERE m.case_id = e.case_id AND m.user_id = $3))
          AND ($4::text IS NULL
               OR e.evidence_code ILIKE $4 OR e.title ILIKE $4 OR c.case_number ILIKE $4
               OR ($5::text IS NOT NULL AND e.sha256 LIKE $5))
        ORDER BY e.created_at DESC
        LIMIT 500`,
      [caseId, onlyAssigned, req.user.id, like, hashPrefix],
    );
    res.json({ evidence: rows.map(publicEvidence) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const evidence = await getViewableEvidence(req, validate.id(req.params.id));
    res.json({ evidence: publicEvidence(evidence) });
  }),
);

// On-demand integrity check: any role that may view the item.
router.post(
  '/:id/verify',
  asyncHandler(async (req, res) => {
    const evidence = await getViewableEvidence(req, validate.id(req.params.id));
    const { result } = await integrity.verifyAndRecord(evidence, { req, trigger: 'manual' });
    const { rows } = await pool.query(`${SELECT_EVIDENCE} WHERE e.id = $1`, [evidence.id]);
    res.json({ result, evidence: publicEvidence(rows[0]) });
  }),
);

// Download: integrity is checked first; a failed check blocks the download.
router.get(
  '/:id/download',
  requireRole('administrator', 'investigator', 'custodian'),
  asyncHandler(async (req, res) => {
    const evidence = await getViewableEvidence(req, validate.id(req.params.id));
    const { result, plaintext } = await integrity.verifyAndRecord(evidence, { req, trigger: 'download' });

    if (result.status !== 'verified') {
      await audit.append({
        ...audit.fromRequest(req),
        action: 'DOWNLOAD_BLOCKED',
        entity: 'evidence',
        entityId: evidence.id,
        details: { evidenceCode: evidence.evidence_code, reasons: result.reasons },
      });
      throw new HttpError(409, `Download blocked: integrity check failed (${result.summary})`, { result });
    }

    await audit.append({
      ...audit.fromRequest(req),
      action: 'EVIDENCE_DOWNLOADED',
      entity: 'evidence',
      entityId: evidence.id,
      details: { evidenceCode: evidence.evidence_code, sha256: result.current.sha256 },
    });

    const asciiName = evidence.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(evidence.original_name)}`,
      'Content-Length': String(plaintext.length),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'X-Evidence-Code': evidence.evidence_code,
      'X-Evidence-SHA256': result.current.sha256,
    });
    res.send(plaintext);
  }),
);

// ---------------------------------------------------------------------------
// Custody, history and the chain-of-custody report
// ---------------------------------------------------------------------------

// Request a transfer: the holder, or an administrator for any item (reassignment).
router.post(
  '/:id/transfers',
  requireRole('administrator', 'investigator', 'custodian'),
  asyncHandler(async (req, res) => {
    const input = validate.body(req);
    const toUserId = validate.id(input.toUserId, 'toUserId');
    const reason = validate.string(input.reason, 'reason', { max: 1000 });
    const evidence = await getViewableEvidence(req, validate.id(req.params.id));
    const transfer = await custody.request(req, evidence, { toUserId, reason });
    res.status(201).json({ transfer });
  }),
);

router.get(
  '/:id/transfers',
  asyncHandler(async (req, res) => {
    const evidence = await getViewableEvidence(req, validate.id(req.params.id));
    res.json({ transfers: await custody.listForEvidence(evidence.id) });
  }),
);

// Full history: every audit entry about this item, oldest first.
router.get(
  '/:id/history',
  asyncHandler(async (req, res) => {
    const evidence = await getViewableEvidence(req, validate.id(req.params.id));
    res.json({ history: (await history(evidence.id)).map(audit.publicEntry) });
  }),
);

// Chain-of-custody report: runs a fresh integrity check, logs the report,
// anchors the audit chain head and returns everything needed to print it.
router.get(
  '/:id/report',
  asyncHandler(async (req, res) => {
    const evidence = await getViewableEvidence(req, validate.id(req.params.id));
    const { result } = await integrity.verifyAndRecord(evidence, { req, trigger: 'report' });

    const chainHead = await withTransaction(async (tx) => {
      await audit.append(
        {
          ...audit.fromRequest(req),
          action: 'REPORT_GENERATED',
          entity: 'evidence',
          entityId: evidence.id,
          details: { evidenceCode: evidence.evidence_code, integrityStatus: result.status },
        },
        tx,
      );
      return audit.anchor('report', tx);
    });

    const [fresh, caseRow, transfers, entries] = await Promise.all([
      pool.query(`${SELECT_EVIDENCE} WHERE e.id = $1`, [evidence.id]).then((r) => r.rows[0]),
      cases.findCase(evidence.case_id),
      custody.listForEvidence(evidence.id),
      history(evidence.id),
    ]);

    res.set('Cache-Control', 'no-store');
    res.json({
      report: {
        title: `Chain-of-custody report: ${evidence.evidence_code}`,
        generatedAt: chainHead.anchoredAt,
        generatedBy: { id: req.user.id, fullName: req.user.fullName, role: req.user.role },
        evidence: publicEvidence(fresh),
        case: {
          id: caseRow.id,
          caseNumber: caseRow.case_number,
          title: caseRow.title,
          status: caseRow.status,
        },
        integrity: result,
        custody: {
          current: { id: fresh.current_custodian_id, fullName: fresh.custodian_name, role: fresh.custodian_role },
          transfers,
        },
        history: entries.map(audit.publicEntry),
        chainHead,
      },
    });
  }),
);

module.exports = router;
