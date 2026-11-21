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
| `src/pages/` | sign-in, dashboard, case list, case detail, and placeholders for the Phase 5 screens |
| `src/styles/global.css` | the whole theme: CSS variables at the top |

Notes:

- **Server-side enforcement.** The screens only decide what to show. The API enforces every permission again and logs each refusal as `ACCESS_DENIED`.
- **Token storage.** The token is kept in `sessionStorage`, so it ends when the browser tab closes. The server also expires it after `JWT_EXPIRES_IN`, which defaults to 8 hours.
- **Time zone.** All times are shown in Kigali time (CAT), whatever the computer's time zone.
- **Offline fonts.** Archivo and IBM Plex Mono are bundled from npm, so the app works offline on the demo laptop.
