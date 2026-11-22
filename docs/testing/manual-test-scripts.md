# EvidenceVault Rwanda: manual test scripts

Run these in a browser against a fresh demo database. Mark each step **P** (pass) or **F** (fail). For every **F**, note what happened and add a row to the defects table in `test-report.md`.

## Before you start

1. Reset the demo data. This deletes everything in the dev database.
   ```sh
   docker compose down -v && docker compose up -d
   cd backend && npm run migrate && npm run seed
   ```
   Keep `data/secrets.json`, but delete the old files in `backend/data/evidence/`.
2. Start the API: `cd backend && npm start`.
3. Start the web app: `cd frontend && npm run dev`.
4. Open http://localhost:5173.

The demo password is `EvidenceVault#2026`. In development, the sign-in page has quick-fill buttons for each role.

Keep two test files at hand: a screenshot (`screenshot.png`) and any small PDF (`statement.pdf`).

Tester: ____________  Date: ____________  Browser and version: ____________

---

## Script A: Investigator (investigator@evidencevault.local)

| # | Action | Expected | P/F |
| --- | --- | --- | --- |
| A1 | Sign in with a wrong password | "Invalid email or password"; you stay on the sign-in page | |
| A2 | Sign in correctly | Dashboard greets you as "Muraho, Demo". Navigation shows Dashboard, Cases and Evidence, with no Audit log, Alerts or Users | |
| A3 | Cases → New case: number `RIB-2026-0101`, title `Mobile money fraud` | Case page opens. Status is Open, and you are listed as an assigned investigator ("Opened the case") | |
| A4 | Assign `Second Investigator` | They appear in the member list | |
| A5 | Click **Register evidence** on the case | The form opens with the case already chosen. "Collected by" shows your name and cannot be edited | |
| A6 | Drop `screenshot.png` onto the file area | File name, size and a browser-computed SHA-256 appear. The title is filled in from the file name | |
| A7 | Fill in location and source device, then press **Register evidence** | The progress bar runs. Then "Evidence registered" with code `EV-2026-000001`, and the hash match check shows ✓ | |
| A8 | Press **Register another in this case** and upload the **same** screenshot | Registered as `EV-2026-000002`, with a "Duplicate file" warning naming EV-2026-000001 | |
| A9 | Open EV-2026-000001 → **Verify integrity** | A green **Verified** stamp. Recorded and current hashes both show "match" | |
| A10 | **Download original** | The file downloads, and opening it shows the same screenshot | |
| A11 | In Custody, choose `Demo Custodian`, give the reason "Lodging in the evidence room", and request the transfer | A pending card shows Demo Investigator → Demo Custodian. Custodian is still you | |
| A12 | History panel | Shows Registered, Integrity verified, Original downloaded and Transfer requested, each with a time in CAT and an entry number | |
| A13 | Custody report → **Generate report** → **Print / save as PDF** | The print preview has no sidebar or buttons. It has sections 1–6, the chain seal hash and signature lines | |
| A14 | Evidence → search the first 8 characters of the hash | Both items are found | |
| A15 | Type `/audit` in the address bar | "403 · Access refused", without claiming that anything was logged | |
| A16 | Sign out | Back on the sign-in page with "You have signed out." | |

## Script B: Custodian (custodian@evidencevault.local)

| # | Action | Expected | P/F |
| --- | --- | --- | --- |
| B1 | Sign in | The dashboard shows 1 transfer in "Waiting for you" for EV-2026-000001, with the reason | |
| B2 | Enter the note "Sealed bag 14", then **Accept custody** | The card disappears, and "In your custody" becomes 1 | |
| B3 | Open EV-2026-000001 | Current custodian is Demo Custodian ("You"). History shows Custody accepted with your note | |
| B4 | Cases | Every case is listed, including ones you are not assigned to | |
| B5 | Open EV-2026-000002 (held by the investigator) | No transfer form, and the page says only the custodian or an administrator can hand it over | |
| B6 | Evidence list: is there a "Register evidence" button? | No | |

## Script C: Tamper demo (run in a terminal between B and D)

| # | Action | Expected | P/F |
| --- | --- | --- | --- |
| C1 | `cd backend && npm run tamper:file -- EV-2026-000001` | Prints the SHA-256 before and after | |
| C2 | As the custodian, **Verify integrity** on EV-2026-000001 | A red **Failed** stamp, with reasons "stored file no longer matches" and "decryption authentication failed". Hash rows show "differs" | |
| C3 | **Download original** | Blocked, with the same failure reasons. No file downloads | |
| C4 | `npm run tamper:log` | Prints which entry was backdated | |

## Script D: Auditor (auditor@evidencevault.local)

| # | Action | Expected | P/F |
| --- | --- | --- | --- |
| D1 | Sign in | Navigation includes Audit log and Alerts, but not Users. The dashboard shows open alerts, including a critical INTEGRITY_FAILED | |
| D2 | Open EV-2026-000001 | There is no Download button. History shows the failed checks and the blocked download | |
| D3 | Alerts | INTEGRITY_FAILED (critical) is listed, with no Acknowledge button | |
| D4 | Audit log → **Verify chain** | A red **Chain broken** stamp naming the backdated entry. That row is highlighted in the table | |
| D5 | Generate the report for EV-2026-000001 | Section 2 shows Failed, with the reasons | |
| D6 | Filter the audit log by action "Access refused" | Shows the refusals recorded so far | |

## Script E: Administrator (admin@evidencevault.local)

| # | Action | Expected | P/F |
| --- | --- | --- | --- |
| E1 | Sign in | Navigation includes Users | |
| E2 | Alerts → acknowledge the INTEGRITY_FAILED alert | It shows "Acknowledged by Demo Administrator" and leaves the Open list | |
| E3 | Users → Add user: `Test Auditor 2`, role Auditor | The new user is listed as Active | |
| E4 | In another browser (or a private window), sign in as `investigator2@evidencevault.local` with a wrong password five times | The fifth attempt locks the account, with the time it unlocks | |
| E5 | Users: investigator2 | Status Locked → **Unlock** → Active. They can sign in again | |
| E6 | Sign in as investigator2 in the other window, then **Deactivate** them here | Their next click in the other window returns them to sign-in with a session-ended message | |
| E7 | Open EV-2026-000002 (held by the investigator) → request a transfer to the custodian | Accepted as a reassignment. History says "Reassignment requested (administrator)" | |
| E8 | Case RIB-2026-0101 → **Close case** | A read-only notice appears, and the Register evidence button is gone | |
| E9 | Case RIB-2026-0101 → **Reopen** | The case is open again | |
| E10 | Try to change your own role in Users | The role selector for your own row is disabled | |

## Script F: Layout and robustness

| # | Action | Expected | P/F |
| --- | --- | --- | --- |
| F1 | Narrow the window to phone width (about 375 px) | The sidebar becomes a top bar, and no page scrolls sideways | |
| F2 | Stop the API, then click around | A clear "Cannot reach the EvidenceVault API" message, not a blank page | |
| F3 | Reload while signed in | You stay signed in on the same page | |
| F4 | Close the tab, then open the app in a **new** tab (not "reopen closed tab", which restores the session) | You are asked to sign in (the token lasts only for the tab) | |
| F5 | Turn on "reduce motion" in the operating system | Pages appear without animation | |
