/** Texto de ayuda para formularios (misma regla que el servidor). */
export const PASSWORD_POLICY_HINT =
  'Mínimo 8 caracteres, con mayúscula, minúscula y un carácter especial (símbolo).';

export function validatePasswordStrength(password) {
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
