/**
 * Política de contraseña para primer ingreso y cambios obligatorios.
 * Mínimo 8 caracteres, al menos una mayúscula, una minúscula y un carácter que no sea letra ni dígito.
 *
 * La contraseña inicial que pone el administrador (p. ej. 123456) usa
 * `validateProvisionalPassword`: basta con 6 caracteres. El login con esa clave
 * debe funcionar; después el usuario está obligado a definir una clave fuerte.
 */

const PROVISIONAL_MIN_LENGTH = 6;

function validateProvisionalPassword(password) {
  const p = String(password || '').trim();
  if (p.length < PROVISIONAL_MIN_LENGTH) {
    return {
      ok: false,
      error:
        'Contraseña inicial requerida (mínimo 6 caracteres). La cuenta deberá elegir una contraseña segura en el primer acceso.',
    };
  }
  return { ok: true, error: null };
}

function validatePasswordStrength(password) {
  const p = String(password || '');
  if (p.length < 8) {
    return { ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' };
  }
  if (!/\p{Ll}/u.test(p)) {
    return { ok: false, error: 'Incluya al menos una letra minúscula.' };
  }
  if (!/\p{Lu}/u.test(p)) {
    return { ok: false, error: 'Incluya al menos una letra mayúscula.' };
  }
  if (!/[^\p{L}0-9]/u.test(p)) {
    return { ok: false, error: 'Incluya al menos un carácter especial (símbolo; no solo letras ni números).' };
  }
  return { ok: true, error: null };
}

module.exports = { validatePasswordStrength, validateProvisionalPassword, PROVISIONAL_MIN_LENGTH };
