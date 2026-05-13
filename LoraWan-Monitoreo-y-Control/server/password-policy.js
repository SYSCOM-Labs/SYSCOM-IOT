/**
 * Política de contraseña para primer ingreso y cambios obligatorios.
 * Mínimo 8 caracteres, al menos una mayúscula, una minúscula y un carácter que no sea letra ni dígito.
 */

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

module.exports = { validatePasswordStrength };
