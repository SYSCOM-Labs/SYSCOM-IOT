'use strict';

const PERMISSION_KEYS = ['edit', 'delete', 'downlink', 'assign'];

function emptyPermissions() {
  return { edit: false, delete: false, downlink: false, assign: false };
}

function allPermissions() {
  return { edit: true, delete: true, downlink: true, assign: true };
}

function isTruthyFlag(v) {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

function sanitizePermissions(input) {
  const out = emptyPermissions();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const k of PERMISSION_KEYS) {
    out[k] = isTruthyFlag(input[k]);
  }
  return out;
}

function parsePermissionsJson(raw) {
  if (raw == null || String(raw).trim() === '') {
    return { edit: true, delete: false, downlink: true, assign: false };
  }
  try {
    return sanitizePermissions(JSON.parse(String(raw)));
  } catch {
    return emptyPermissions();
  }
}

function toJson(perms) {
  return JSON.stringify(sanitizePermissions(perms));
}

function intersectPermissions(granted, actorPerms) {
  const g = sanitizePermissions(granted);
  const a = sanitizePermissions(actorPerms);
  const out = emptyPermissions();
  for (const k of PERMISSION_KEYS) {
    out[k] = Boolean(g[k] && a[k]);
  }
  return out;
}

function effectivePermissionsForActor(actor, userDeviceRow) {
  if (actor && String(actor.role || '').toLowerCase() === 'superadmin') return allPermissions();
  if (!userDeviceRow) return emptyPermissions();
  const raw =
    userDeviceRow.assignmentPermissionsJson != null
      ? userDeviceRow.assignmentPermissionsJson
      : userDeviceRow.assignment_permissions_json;
  if (userDeviceRow.assignmentPermissions && typeof userDeviceRow.assignmentPermissions === 'object') {
    return sanitizePermissions(userDeviceRow.assignmentPermissions);
  }
  return parsePermissionsJson(raw);
}

function actorHasDevicePermission(actor, userDeviceRow, key) {
  const k = String(key || '').trim();
  if (!PERMISSION_KEYS.includes(k)) return false;
  return Boolean(effectivePermissionsForActor(actor, userDeviceRow)[k]);
}

/**
 * Middleware: superadmin siempre; resto debe tener el dispositivo asignado y el permiso.
 * Lee `deviceId` de params o del body.
 */
function requireDevicePermission(store, key) {
  return (req, res, next) => {
    const actor = store.getUserById(req.user && req.user.id);
    if (!actor) return res.status(401).json({ error: 'Usuario no encontrado' });
    if (String(actor.role || '').toLowerCase() === 'superadmin') return next();
    const did = String(
      (req.params && req.params.deviceId != null ? decodeURIComponent(String(req.params.deviceId)) : '') ||
        (req.body && req.body.deviceId) ||
        ''
    ).trim();
    if (!did) return res.status(400).json({ error: 'deviceId requerido' });
    const ud = store.getUserDevice(actor.id, did);
    if (!ud) return res.status(403).json({ error: 'Dispositivo no asignado a su cuenta' });
    if (!actorHasDevicePermission(actor, ud, key)) {
      return res.status(403).json({ error: 'Sin permiso en este dispositivo para esta acción' });
    }
    next();
  };
}

module.exports = {
  PERMISSION_KEYS,
  emptyPermissions,
  allPermissions,
  sanitizePermissions,
  parsePermissionsJson,
  toJson,
  intersectPermissions,
  effectivePermissionsForActor,
  actorHasDevicePermission,
  requireDevicePermission,
};
