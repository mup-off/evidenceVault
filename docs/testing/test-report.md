# EvidenceVault Rwanda: test report

| | |
| --- | --- |
| Phase | 6: Testing |
| Date | 22 November 2026 |
| Build | Backend and frontend as of Phase 5 (Phase 6 fixes included) |
| Environment | Windows 11, Node.js 22.14, PostgreSQL 16 (Docker), Chrome (manual tests) |

## Summary

| Test set | Cases | Passed | Failed | Status |
| --- | --- | --- | --- | --- |
| Automated API tests (Jest + Supertest) | 333 | 333 | 0 | ✅ Passed |
| … of which: role matrix (every route × every role) | 194 | 194 | 0 | ✅ Passed |
| … of which: Testing and demo plan rows R01–R20 | 22 | 22 | 0 | ✅ Passed |
| Manual browser scripts A–F | 47 | 47 | 0 | ✅ Passed |

All automated tests and all manual browser scripts pass. Phase 6 found three defects. All three have been fixed and retested (see [Defects](#5-defects)).

## 1. Automated API tests

Run with `cd backend && npm test`. The suite uses a separate `evidencevault_test` database, which is wiped and migrated at the start of each run.

| File | What it covers | Tests | Result |
| --- | --- | --- | --- |
| `auth.test.js` | Sign-in, lockout, sessions, token revocation, audit chain basics | 17 | ✅ 17/17 |
| `users.test.js` | User management, directory | 9 | ✅ 9/9 |
| `cases.test.js` | Cases, case-level access, members, closing | 18 | ✅ 18/18 |
| `evidence.test.js` | Intake, encryption at rest, duplicates, integrity, download | 22 | ✅ 22/22 |
| `custody.test.js` | Transfers, reassignment, closed cases, concurrency | 23 | ✅ 23/23 |
| `audit.test.js` | Chain verification, tampering, triggers, anchors, alerts | 19 | ✅ 19/19 |
| `report.test.js` | Custody report, dashboard, file tamper demo | 6 | ✅ 6/6 |
| `startup.test.js` | Refusing to start without keys | 3 | ✅ 3/3 |
| `permissions.test.js` | Role matrix (section 2) | 194 | ✅ 194/194 |
| `acceptance.test.js` | Testing and demo plan rows (section 3) | 22 | ✅ 22/22 |
| **Total** | | **333** | ✅ **333/333** |

## 2. Role matrix

`permissions.test.js` calls every API route as each of the five roles below. It checks the status code against this table, which matches the plan's "Roles and permissions" table. For every refusal (**403**), it also checks that exactly one `ACCESS_DENIED` entry was written to the audit log. A further 33 tests call each route with no token and expect **401**.

Roles: **Admin** is the administrator. **Inv** is the investigator assigned to the case and holding the item. **Inv✗** is an investigator *not* assigned to the case. **Cus** is the custodian, who is the recipient of the pending transfer. **Aud** is the auditor.

| Route | Admin | Inv | Inv✗ | Cus | Aud |
| --- | --- | --- | --- | --- | --- |
| GET /api/auth/me | 200 | 200 | 200 | 200 | 200 |
| GET /api/users/directory | 200 | 200 | 200 | 200 | 200 |
| GET /api/users | 200 | 403 | 403 | 403 | 403 |
| GET /api/users/:id | 200 | 403 | 403 | 403 | 403 |
| POST /api/users | 201 | 403 | 403 | 403 | 403 |
| PATCH /api/users/:id | 200 | 403 | 403 | 403 | 403 |
| GET /api/cases | 200 | 200 | 200 ¹ | 200 | 200 |
| POST /api/cases | 201 | 201 | 201 | 403 | 403 |
| GET /api/cases/:id | 200 | 200 | 403 | 200 | 200 |
| PATCH /api/cases/:id | 200 | 200 | 403 | 403 | 403 |
| POST /api/cases/:id/members | 201 | 201 | 403 | 403 | 403 |
| DELETE /api/cases/:id/members/:userId | 200 | 200 | 403 | 403 | 403 |
| POST /api/evidence | 201 | 201 | 403 | 403 | 403 |
| GET /api/evidence | 200 | 200 | 200 ¹ | 200 | 200 |
| GET /api/evidence/:id | 200 | 200 | 403 | 200 | 200 |
| POST /api/evidence/:id/verify | 200 | 200 | 403 | 200 | 200 |
| GET /api/evidence/:id/download | 200 | 200 | 403 | 200 | 403 |
| GET /api/evidence/:id/history | 200 | 200 | 403 | 200 | 200 |
| GET /api/evidence/:id/transfers | 200 | 200 | 403 | 200 | 200 |
| GET /api/evidence/:id/report | 200 | 200 | 403 | 200 | 200 |
| POST /api/evidence/:id/transfers | 201 ² | 201 | 403 | 403 | 403 |
| GET /api/transfers | 200 | 200 | 200 | 200 | 200 |
| GET /api/transfers?direction=all | 200 | 403 | 403 | 403 | 200 |
| POST /api/transfers/:id/accept | 403 | 403 | 403 | 200 | 403 |
| POST /api/transfers/:id/reject | 403 | 403 | 403 | 200 | 403 |
| POST /api/transfers/:id/cancel | 200 | 200 ³ | 403 | 403 | 403 |
| GET /api/audit | 200 | 403 | 403 | 403 | 200 |
| GET /api/audit/head | 200 | 403 | 403 | 403 | 200 |
| POST /api/audit/verify | 200 | 403 | 403 | 403 | 200 |
| GET /api/alerts | 200 | 403 | 403 | 403 | 200 |
| POST /api/alerts/:id/acknowledge | 200 | 403 | 403 | 403 | 403 |
| GET /api/dashboard | 200 | 200 | 200 | 200 | 200 |

¹ The list is returned, but a separate test confirms that it contains nothing from the case the investigator is not assigned to.
² The administrator does not hold the item, so this is a reassignment, logged as `CUSTODY_REASSIGNED`.
³ The investigator is the requester of the pending transfer.

## 3. Testing and demo plan

Each row of the plan's table has its own test in `acceptance.test.js`, named after the row number.

| Row | Area | Test | Expected result | Result |
| --- | --- | --- | --- | --- |
| R01 | Sign-in | Five wrong passwords | Account locked 15 minutes, alert raised | ✅ Pass |
| R02 | Sign-in | Deactivate a signed-in user, then make a request | Refused at once; old token stops working | ✅ Pass |
| R03 | Access | Investigator opens an unassigned case | Refused, ACCESS_DENIED logged, alert raised | ✅ Pass |
| R04 | Access | Auditor tries to download a file | Refused with 403 | ✅ Pass |
| R05 | Intake | Upload a file | SHA-256 recorded; stored file encrypted and unreadable | ✅ Pass |
| R06 | Intake | Upload the same file twice | Duplicate warning | ✅ Pass |
| R07 | Intake | Register evidence on a closed case | Refused | ✅ Pass |
| R08 | Integrity | Verify an untouched file | Hashes match, Verified | ✅ Pass |
| R09 | Integrity | Flip one byte, then verify | Failed; both stored-file hashes shown; decryption authentication failed; critical alert | ✅ Pass |
| R10 | Integrity | Delete the stored file, then verify | Failed (file missing), critical alert | ✅ Pass |
| R11 | Integrity | Download a tampered file | Download blocked | ✅ Pass |
| R12 | Custody | Transfer to a custodian who accepts | Custodian changes; both steps in history | ✅ Pass |
| R13 | Custody | Non-custodian requests a transfer | Refused | ✅ Pass |
| R14 | Custody | Two simultaneous accepts of the same item | Only one succeeds | ✅ Pass |
| R15 | Audit | Edit one entry in the database, then check the chain | Broken at that entry | ✅ Pass |
| R16 | Audit | Edit an entry and recompute with plain SHA-256 | Still detected | ✅ Pass |
| R17 | Audit | Delete the newest entries, then check the chain | Detected through the anchored head | ✅ Pass |
| R18 | Audit | TRUNCATE, UPDATE or DELETE as the app role (3 tests) | Refused by the database | ✅ Pass |
| R19 | Keys | Remove `secrets.json` and start the server | Refuses to start with a clear message | ✅ Pass |
| R20 | Report | Generate a report | Fresh integrity check, full history, chain head | ✅ Pass |

The same scenarios are run by hand in the browser in manual scripts A–E, and live in the demo.

## 4. Manual browser tests

The scripts are in [manual-test-scripts.md](manual-test-scripts.md). They were run in Chrome against a freshly reset demo database.

| Script | Role | Steps | Passed | Failed | Tester | Date |
| --- | --- | --- | --- | --- | --- | --- |
| A | Investigator | 16 | 16 | 0 | MUPENZI Fulgence | 22 Nov 2026 |
| B | Custodian | 6 | 6 | 0 | MUPENZI Fulgence | 22 Nov 2026 |
| C | Tamper demo | 4 | 4 | 0 | MUPENZI Fulgence | 22 Nov 2026 |
| D | Auditor | 6 | 6 | 0 | MUPENZI Fulgence | 22 Nov 2026 |
| E | Administrator | 10 | 10 | 0 | MUPENZI Fulgence | 22 Nov 2026 |
| F | Layout and robustness | 5 | 5 | 0 | MUPENZI Fulgence | 22 Nov 2026 |
| **Total** | | **47** | **47** | **0** | | |

Step A11 first failed because of defect D3. It passed on the rerun after the fix, and is counted as passed above.

## 5. Defects

| # | Found in | Description | Severity | Fix | Retest |
| --- | --- | --- | --- | --- | --- |
| D1 | Phase 6 code review | The "403 · Access refused" page always said "The attempt has been recorded in the audit log", including for screens the browser blocks by role. Those never reach the API, so nothing was logged and the message was false. | Low | The message now appears only when the API refused the request (case, evidence and report pages) | ✅ Frontend build; manual step A15 |
| D3 | Manual script A, step A11 | On screens narrower than 1100 px, the evidence page drops to one column and the Custody panel (with the transfer form) ended up below the full history timeline. The tester could not find it. | Medium | In one column, Custody now comes first. A "Hand over custody" / "Pending transfer" button in the page header scrolls to it. | ✅ A11 rerun passed |
| D2 | Phase 6 test runs | When the machine was busy, the per-test database reset sometimes went over Jest's 20 s limit. A different test failed each time. This was a test-infrastructure problem, not a product defect. | Low | Test timeout raised to 60 s | ✅ 333/333 on rerun |

Three changes were requested by the user rather than found as defects. They are listed here for completeness:

- **Collected by.** "Collected by" is now always the registering user, and is read-only in the form and enforced by the API.
- **History order.** On the evidence page, history is listed newest first so recent activity is easy to find. The custody report keeps it oldest first, in chain-of-custody order.
- **Startup message.** The server now prints a clear message, instead of a stack trace, when its port is already in use.

## 6. Not covered

- **Frontend code.** There are no automated tests for the frontend code. The screens are covered by the manual scripts.
- **Browser support.** Only current Chrome is tested. Upload progress and the browser-side SHA-256 need a secure context (localhost or HTTPS).
- **Load.** There is no load or performance testing. The prototype handles files up to 100 MB in memory.
- **Security review.** No penetration test or independent security review has been done (see the hardening roadmap in the plan).
