// Small fetch wrapper for the EvidenceVault API.
//
// - The sign-in token is kept in sessionStorage: it lasts for the browser tab
//   and is gone when the tab closes.
// - A 401 on a signed-in request (expired token, deactivated account, reset
//   password) clears the token and tells the auth layer to sign the user out.
// - Every failure is thrown as an ApiError with the API's own message.

const TOKEN_KEY = 'evidencevault.token';

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked (private mode): the session simply will not survive a reload.
  }
}

let unauthorizedHandler = null;

/** Called with the API's message when a signed-in request is refused with 401. */
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

const UNREACHABLE = 'Cannot reach the EvidenceVault API. Is the backend running (npm start in backend/)?';

/**
 * api('/cases'), api('/cases', { method: 'POST', body: {...} }).
 * body may be a plain object (sent as JSON) or FormData (sent as multipart).
 */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const token = getToken();
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, UNREACHABLE);
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (res.status === 401 && token) {
    setToken(null);
    unauthorizedHandler?.(data?.error || 'Your session has ended. Please sign in again.');
  }
  if (!res.ok) {
    // The dev proxy answers with a plain-text 5xx when the API is down.
    if (!isJson && res.status >= 500) throw new ApiError(res.status, UNREACHABLE);
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data);
  }
  return data;
}
