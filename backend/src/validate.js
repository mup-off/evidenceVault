'use strict';

// Small input validators. Each returns the cleaned value or throws a 400.

const { HttpError } = require('./errors');

const ROLES = Object.freeze(['administrator', 'investigator', 'custodian', 'auditor']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function body(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return req.body;
}

function string(value, field, { min = 1, max = 200, optional = false } = {}) {
  if (value === undefined || value === null || (optional && value === '')) {
    if (optional) return null;
    throw new HttpError(400, `${field} is required`);
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new HttpError(400, `${field} must be at least ${min} characters`);
  if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return trimmed;
}

function email(value, field = 'email') {
  const cleaned = string(value, field, { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(cleaned)) throw new HttpError(400, `${field} must be a valid email address`);
  return cleaned;
}

function password(value, field = 'password') {
  if (typeof value !== 'string') throw new HttpError(400, `${field} is required`);
  if (value.length < 10) throw new HttpError(400, `${field} must be at least 10 characters`);
  // bcrypt only uses the first 72 bytes.
  if (Buffer.byteLength(value, 'utf8') > 72) throw new HttpError(400, `${field} must be at most 72 bytes`);
  return value;
}

function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function boolean(value, field) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be true or false`);
  return value;
}

function id(value, field = 'id') {
  const n = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${field} must be a positive integer`);
  return n;
}

module.exports = { ROLES, body, string, email, password, oneOf, boolean, id };
