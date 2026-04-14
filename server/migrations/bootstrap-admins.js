'use strict';

/**
 * Superadministradores creados por la migración `0010_seed_bootstrap_superadmins`
 * si aún no existen en `users`. No pueden degradarse de rol desde la API (ver server.js).
 *
 * | Nombre              | Correo                          |
 * |---------------------|---------------------------------|
 * | Michelle Güereque   | michelle.guereque@syscom.mx     |
 * | Joanna Molina       | joanna.molina@syscom.mx         |
 */
const BOOTSTRAP_SUPERADMINS = [
  { email: 'michelle.guereque@syscom.mx', profileName: 'Michelle Güereque' },
  { email: 'joanna.molina@syscom.mx', profileName: 'Joanna Molina' },
];

const LOWER_EMAIL_SET = new Set(BOOTSTRAP_SUPERADMINS.map((r) => String(r.email).trim().toLowerCase()));

function isEnsuredSuperadminEmail(email) {
  if (email == null) return false;
  return LOWER_EMAIL_SET.has(String(email).trim().toLowerCase());
}

/** Lista de correos (para exports y comprobaciones) */
const ENSURED_SUPERADMIN_EMAILS = BOOTSTRAP_SUPERADMINS.map((r) => r.email);

/** Compatibilidad: primer correo de la lista (antes solo existía uno fijo). */
const ENSURED_SUPERADMIN_EMAIL = BOOTSTRAP_SUPERADMINS[0].email;

module.exports = {
  BOOTSTRAP_SUPERADMINS,
  ENSURED_SUPERADMIN_EMAILS,
  ENSURED_SUPERADMIN_EMAIL,
  isEnsuredSuperadminEmail,
};
