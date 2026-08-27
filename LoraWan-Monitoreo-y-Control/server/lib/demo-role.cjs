'use strict';

function isDemoRole(role) {
  return String(role || '')
    .trim()
    .toLowerCase() === 'demo';
}

function normalizeApiPath(pathOrUrl) {
  const raw = String(pathOrUrl || '').split('?')[0];
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed || '/';
}

/** POST/PUT/PATCH/DELETE permitidos para una cuenta demo (el resto es solo lectura). */
const DEMO_WRITE_ALLOW = new Set(['POST /api/auth/refresh', 'POST /api/auth/impersonate/stop']);

/** Lecturas que dumpan secretos o toda la base: no para demo. */
const DEMO_GET_DENY = new Set(['/api/admin/database/export']);

function demoAllowsWrite(method, pathOrUrl) {
  const m = String(method || '').toUpperCase();
  const p = normalizeApiPath(pathOrUrl);
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
    return !DEMO_GET_DENY.has(p);
  }
  if (DEMO_WRITE_ALLOW.has(`${m} ${p}`)) return true;
  return false;
}

module.exports = {
  isDemoRole,
  demoAllowsWrite,
  normalizeApiPath,
};
