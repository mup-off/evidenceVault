# EvidenceVault Rwanda: API

Node.js 22 + Express 4 + PostgreSQL 16.

## First-time setup

```sh
# from the project root: start PostgreSQL 16 (port 5434)
docker compose up -d

cd backend
npm install
cp .env.example .env      # defaults match docker-compose.yml
npm run keygen            # creates data/secrets.json - BACK IT UP
npm run migrate
npm run seed              # demo accounts
npm start                 # http://localhost:4000
```

`data/secrets.json` holds the JWT secret, the audit-log HMAC key and the file-encryption keys. The server refuses to start without it, and `keygen` refuses to overwrite it. Losing it makes stored evidence unreadable and the audit log unverifiable.

## Demo accounts

Every demo account uses the password `EvidenceVault#2026`. You can override it with `SEED_DEMO_PASSWORD`.

| Role | Email |
| --- | --- |
| Administrator | admin@evidencevault.local |
| Investigator | investigator@evidencevault.local |
| Investigator | investigator2@evidencevault.local |
| Custodian | custodian@evidencevault.local |
| Auditor | auditor@evidencevault.local |

## Database roles

The Docker init script (`db/init/`) creates two roles:

- **ev_owner** owns the schema and runs migrations (`MIGRATION_DATABASE_URL`).
- **ev_app** is used by the API (`DATABASE_URL`). It has only the privileges the migrations grant. On `audit_log` it has only `SELECT` and `INSERT`.

## Tests

```sh
npm test
```

Tests run against `evidencevault_test`. Its schema is wiped and migrated on every run, and throwaway keys are written to `tests/.tmp/`.

## API (Phase 1: accounts and cases)

All routes except sign-in and health need `Authorization: Bearer <token>`.

| Method | Path | Who |
| --- | --- | --- |
| GET | /api/health | anyone |
| POST | /api/auth/login | anyone. Body: `{ email, password }` |
| GET | /api/auth/me | signed in |
| GET | /api/users/directory?role= | signed in (active users, no emails) |
| GET | /api/users | administrator |
| GET | /api/users/:id | administrator |
| POST | /api/users | administrator. Body: `{ fullName, email, role, password }` |
| PATCH | /api/users/:id | administrator. Body: any of `fullName, role, active, password, unlock: true` |
| GET | /api/cases?status= | all roles; investigators see only assigned cases |
| POST | /api/cases | administrator, investigator. Body: `{ caseNumber, title, description? }` |
| GET | /api/cases/:id | anyone who may view the case (with members) |
| PATCH | /api/cases/:id | administrator, or the investigator who opened it. Body: any of `title, description, status`. Only administrators can reopen a case. |
| POST | /api/cases/:id/members | same as PATCH. Body: `{ userId }` (active investigators only) |
| DELETE | /api/cases/:id/members/:userId | same as PATCH. The case opener cannot be removed. |

## API (Phase 2: evidence)

| Method | Path | Who |
| --- | --- | --- |
| POST | /api/evidence | administrator; investigator on an assigned, open case. Multipart fields: `file`, `caseId`, `title`, optional `description`, `collectedAt`, `collectedBy`, `collectionLocation`, `sourceDevice`, `collectionNotes`. Returns `warnings` (for example, a duplicate file). |
| GET | /api/evidence?caseId=&q= | all roles; investigators see only assigned cases. `q` matches the code, title, case number or a SHA-256 prefix (6 or more hex characters). |
| GET | /api/evidence/:id | anyone who may view the case |
| POST | /api/evidence/:id/verify | anyone who may view the case. Returns `result` with `status`, `reasons`, and the recorded and current hashes. |
| GET | /api/evidence/:id/download | administrator, custodian, assigned investigator (not auditors). Runs an integrity check first, and returns **409** if the check fails. |

Evidence files are stored encrypted (AES-256-GCM) and read-only in `EVIDENCE_DIR` (default `data/evidence/`). Back them up together with the database.

## API (Phase 3: custody, audit, alerts, reports)

| Method | Path | Who |
| --- | --- | --- |
| POST | /api/evidence/:id/transfers | the current holder (investigator, custodian, administrator), or an administrator for any item (logged as `CUSTODY_REASSIGNED`). Body: `{ toUserId, reason }`. The reason is always required. Refused on closed cases. |
| GET | /api/evidence/:id/transfers | anyone who may view the case |
| GET | /api/evidence/:id/history | anyone who may view the case. Every audit entry about the item, oldest first. |
| GET | /api/evidence/:id/report | anyone who may view the case. Runs a fresh integrity check, then returns the item, the integrity result, custody transfers, full history and the anchored audit chain head. |
| GET | /api/transfers?direction=&status= | signed in. `direction`: `incoming`, `outgoing`, `mine` (default) or `all` (administrators and auditors only). |
| POST | /api/transfers/:id/accept | the recipient only. Optional body `{ note }`. Refused if the case has been closed. |
| POST | /api/transfers/:id/reject | the recipient only. Optional body `{ note }`. |
| POST | /api/transfers/:id/cancel | the requester, the holder, or an administrator |
| GET | /api/audit?action=&entity=&entityId=&userId=&beforeSeq=&limit= | administrator, auditor. Newest first, at most 500 per page. |
| GET | /api/audit/head | administrator, auditor |
| POST | /api/audit/verify | administrator, auditor. Checks the whole chain and every anchor, logs the result, anchors the head if intact, and raises a critical alert if not. |
| GET | /api/alerts?status=&severity= | administrator, auditor. `status`: `open` (default), `acknowledged` or `all`. |
| POST | /api/alerts/:id/acknowledge | administrator |
| GET | /api/dashboard | signed in. Role-aware counts, transfers waiting for you, and open alerts (administrators and auditors). |

Custody rules:

- The custodian changes only when the recipient accepts.
- Recipients must be active administrators, investigators or custodians. An investigator recipient must be assigned to the case.
- An item can have only one pending transfer at a time.
- Accepting locks the transfer and the evidence row, so of two simultaneous accepts only one succeeds.

### How the audit log is protected

- Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on `audit_log` and `audit_anchors` for every role, including the owner. The app role also has only `SELECT` and `INSERT` on both tables.
- Each entry's hash is an HMAC-SHA256 keyed from `secrets.json`, so the chain cannot be recomputed without the key.
- Each report and each successful chain check records the current head in `audit_anchors`, also HMAC-signed. The chain check requires every anchored entry to still exist with the same hash, so deleting the newest entries is detected.

## Tamper demo

These scripts connect as the owner role (`MIGRATION_DATABASE_URL`) and act like someone with direct server access. They refuse to run when `NODE_ENV=production`.

```sh
npm run tamper:file -- EV-2026-000001            # flip one bit in the stored file
npm run tamper:file -- EV-2026-000001 --delete   # delete the stored file
npm run tamper:log                               # backdate one custody or intake entry by an hour
npm run tamper:log -- --seq 42                   # backdate entry #42
npm run tamper:log -- --recompute                # backdate, then recompute later hashes with plain SHA-256
npm run tamper:log -- --delete-newest 3          # delete the newest 3 entries
```

After `tamper:file`, Verify integrity reports Failed and downloads are blocked. After `tamper:log`, `POST /api/audit/verify` reports where the chain breaks. `--delete-newest` is detected once a report or chain check has anchored one of the deleted entries.

The tampering cannot be undone. On the dev database, restore from a backup or rebuild it: `docker compose down -v`, then run the setup steps again.

Every refused action is written to the audit log as `ACCESS_DENIED` and raises a warning alert. Five failed sign-ins lock an account for 15 minutes.
