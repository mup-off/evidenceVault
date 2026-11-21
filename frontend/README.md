# EvidenceVault Rwanda: web app

React 18 single-page app (Vite 7, React Router 7 in library mode). It talks to the API in `../backend`.

## Run it

```sh
# 1. the API (see backend/README.md for first-time setup)
cd backend && npm start          # http://localhost:4000

# 2. the web app
cd frontend
npm install
npm run dev                      # http://localhost:5173
```

The dev server forwards `/api` to `http://localhost:4000`, so the browser uses a single origin and the API needs no CORS settings. To point it at another API, set `API_URL` (for example, `API_URL=http://localhost:4100 npm run dev`).

In development, the sign-in page has quick-fill buttons for the seeded demo accounts. They are left out of production builds.

`npm run build` writes a static build to `dist/`. `npm run preview` serves that build, with the same `/api` proxy.

## How it is put together

| Path | What it does |
| --- | --- |
| `src/api/client.js` | fetch wrapper: adds the bearer token, turns errors into `ApiError`, and signs the user out on a 401 |
| `src/api/useResource.js` | loads one API path: `{ data, error, loading, reload }` |
| `src/auth/AuthContext.jsx` | signed-in user. On load, re-reads the user from `/api/auth/me` |
| `src/auth/guards.jsx` | `RequireAuth` and `RequireRole` route guards, and a safe return path after sign-in |
| `src/roles.js` | role labels, the permission rules the screens need, and role-filtered navigation |
| `src/pages/` | one file per screen: sign-in, dashboard, cases, evidence list/detail/register, report, audit log, alerts, users |
| `src/components/evidence.jsx` | hash display, integrity verdict, history timeline, collection details (shared by detail and report) |
| `src/styles/global.css` | the theme (CSS variables at the top), layout and shared components |
| `src/styles/evidence.css` | the evidence, report (including print), audit, alert and user screens |

## Screens

| Path | Who | What |
| --- | --- | --- |
| `/` | everyone | Dashboard: counts, integrity bar, transfers waiting for you (accept/reject), open alerts |
| `/cases`, `/cases/:id` | everyone (investigators: assigned cases) | Case list, new case, members, close/reopen, the case's evidence |
| `/evidence` | everyone | Search by code, title, case number or a 6+ character SHA-256 prefix |
| `/evidence/new` | administrator, investigator | Register: drag-and-drop file, browser-side SHA-256, collection details, upload progress |
| `/evidence/:id` | everyone who may view the case | Fingerprint, Verify integrity, Download (not auditors), custody transfer, history timeline |
| `/evidence/:id/report` | same | Generate and print the chain-of-custody report |
| `/audit` | administrator, auditor | Audit log with filters and Verify chain; broken entries are highlighted |
| `/alerts` | administrator, auditor | Open and acknowledged alerts; administrators acknowledge |
| `/users` | administrator | Create users, change roles, deactivate, unlock, reset passwords |

Notes:

- **Server-side enforcement.** The screens only decide what to show. The API enforces every permission again and logs each refusal as `ACCESS_DENIED`.
- **Token storage.** The token is kept in `sessionStorage`, so it ends when the browser tab closes. The server also expires it after `JWT_EXPIRES_IN`, which defaults to 8 hours.
- **Time zone.** All times are shown in Kigali time (CAT), whatever the computer's time zone.
- **Offline fonts.** Archivo and IBM Plex Mono are bundled from npm, so the app works offline on the demo laptop.
