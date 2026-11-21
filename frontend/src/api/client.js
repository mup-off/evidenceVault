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

/** File name from a Content-Disposition header, preferring the UTF-8 form. */
function fileNameFrom(disposition, fallback) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition || '');
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition || '');
  return plain ? plain[1] : fallback;
}

/**
 * Downloads a file (the API needs the bearer header, so a plain link will not
 * do) and hands it to the browser to save. Returns the response headers.
 */
export async function download(path, fallbackName = 'download') {
  const token = getToken();
  let res;
  try {
    res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, UNREACHABLE);
  }
  if (!res.ok) {
    const data = (res.headers.get('content-type') || '').includes('application/json') ? await res.json().catch(() => null) : null;
    if (res.status === 401 && token) {
      setToken(null);
      unauthorizedHandler?.(data?.error || 'Your session has ended. Please sign in again.');
    }
    throw new ApiError(res.status, data?.error || `Download failed (${res.status})`, data);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFrom(res.headers.get('content-disposition'), fallbackName);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return res.headers;
}

/**
 * Multipart upload with progress. onProgress receives a fraction 0..1.
 * (fetch cannot report upload progress, so this uses XMLHttpRequest.)
 */
export function upload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, UNREACHABLE));
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status === 401 && token) {
        setToken(null);
        unauthorizedHandler?.(data?.error || 'Your session has ended. Please sign in again.');
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else if (!data && xhr.status >= 500) reject(new ApiError(xhr.status, UNREACHABLE));
      else reject(new ApiError(xhr.status, data?.error || `Upload failed (${xhr.status})`, data));
    };
    xhr.send(formData);
  });
}

/** SHA-256 of a File in the browser, as lowercase hex (Web Crypto). */
export async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
