const { isDemoRole } = require('./lib/demo-role.cjs');

/**
 * Permisos de navegación / módulos (alineados con IDs de página en la app React).
 * Solo `superadmin` (y `demo` en solo lectura) ven `Templates` como true.
 */

const NAV_KEYS = [
  'Dashboard',
  'Devices',
  'Gateway',
  'Automations',
  'History',
  'SpecialReport',
  'Users',
  'Templates',
  'Settings',
];

function emptyNav() {
  return Object.fromEntries(NAV_KEYS.map((k) => [k, false]));
}

function allNavTrue() {
  return Object.fromEntries(NAV_KEYS.map((k) => [k, true]));
}

/** Antes admin: todo excepto plantillas (comportamiento previo). */
function defaultNavLegacyAdmin() {
  const n = allNavTrue();
  n.Templates = false;
  return n;
}

/** Antes usuario estándar: solo vistas básicas. */
function defaultNavLegacyUser() {
  const n = emptyNav();
  n.Dashboard = true;
  n.Devices = true;
  n.History = true;
  n.SpecialReport = true;
  return n;
}

function parseNavJson(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  try {
    const o = JSON.parse(String(raw));
    if (!o || typeof o !== 'object') return null;
    const out = emptyNav();
    for (const k of NAV_KEYS) {
      if (Object.prototype.hasOwnProperty.call(o, k) && o[k] === true) out[k] = true;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {{ role?: string|null, navPermissions?: Record<string, boolean>|null }} user
 * @returns {Record<string, boolean>}
 */
function effectiveNavForUser(user) {
  const role = user && user.role != null ? String(user.role) : '';
  /** Todos los superadmin son equivalentes: acceso total al sistema (ignora filas parciales en BD). */
  if (role === 'superadmin') {
    return allNavTrue();
  }
  /** Demo: recorre todos los módulos; las escrituras se bloquean en API. */
  if (isDemoRole(role)) {
    return allNavTrue();
  }
  let base = parseNavJson(user && user.navPermissionsJson != null ? user.navPermissionsJson : null);
  if (!base) {
    if (role === 'admin') base = defaultNavLegacyAdmin();
    else base = defaultNavLegacyUser();
  } else {
    base = { ...base };
  }
  base.Templates = false;
  return base;
}

function userHasNav(userRow, key) {
  if (!userRow) return false;
  if (userRow.role === 'superadmin' || isDemoRole(userRow.role)) return true;
  const nav = effectiveNavForUser(userRow);
  return Boolean(nav[key]);
}

/**
 * Restringe permisos solicitados a los que el asignador puede otorgar.
 * @param {Record<string, boolean>} assignerNav effective
 * @param {Record<string, boolean>|null|undefined} requested
 */
function sanitizeNavAssignment(assignerRow, requested) {
  const assigner = effectiveNavForUser(assignerRow);
  const out = emptyNav();
  const req = requested && typeof requested === 'object' ? requested : {};
  for (const k of NAV_KEYS) {
    if (assigner[k] === true && req[k] === true) out[k] = true;
  }
  if (assignerRow && assignerRow.role !== 'superadmin') {
    out.Templates = false;
  }
  return out;
}

function navToJson(nav) {
  return JSON.stringify(nav && typeof nav === 'object' ? nav : emptyNav());
}

module.exports = {
  NAV_KEYS,
  emptyNav,
  allNavTrue,
  defaultNavLegacyAdmin,
  defaultNavLegacyUser,
  effectiveNavForUser,
  userHasNav,
  sanitizeNavAssignment,
  navToJson,
  parseNavJson,
  isDemoRole,
};
