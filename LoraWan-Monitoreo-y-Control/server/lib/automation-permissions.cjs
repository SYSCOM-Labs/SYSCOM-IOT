'use strict';

const navPerm = require('../navPermissions');

/** Downlinks, agenda completa, etc. */
function canRunAutomationsForUser(user) {
  if (!user) return false;
  if (navPerm.isDemoRole(user.role)) return false;
  if (user.role === 'superadmin') return true;
  return navPerm.userHasNav(user, 'Automations');
}

/**
 * Cualquier subcuenta activa puede disparar acciones «email» usando el SMTP global
 * configurado por superadmin (no necesita permiso Ajustes ni ser superadmin).
 */
function canUseGlobalNotificationEmailForUser(user) {
  if (!user) return false;
  const role = String(user.role || '').trim();
  if (role === 'superadmin') return true;
  if (navPerm.isDemoRole(role)) return false;
  if (role === 'user' || role === 'admin' || role === 'viewer') return true;
  return false;
}

function automationPermitsForUser(user) {
  return {
    allowFull: canRunAutomationsForUser(user),
    allowEmail: canUseGlobalNotificationEmailForUser(user),
  };
}

/** @param {object} action @param {{ allowFull: boolean, allowEmail: boolean }} perm */
function isAutomationActionPermitted(action, perm) {
  const type = action && action.type != null ? String(action.type) : '';
  if (type === 'email') return Boolean(perm && perm.allowEmail);
  if (type === 'downlink') return Boolean(perm && perm.allowFull);
  return Boolean(perm && perm.allowFull);
}

module.exports = {
  canRunAutomationsForUser,
  canUseGlobalNotificationEmailForUser,
  automationPermitsForUser,
  isAutomationActionPermitted,
};
