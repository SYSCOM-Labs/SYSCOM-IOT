/** Texto de ayuda para formularios (misma regla que el servidor). */
export const PASSWORD_POLICY_HINT =
  'Mínimo 8 caracteres, con mayúscula, minúscula y un carácter especial (símbolo).';

export const PROVISIONAL_PASSWORD_HINT =
  'Contraseña temporal: mínimo 6 caracteres (p. ej. 123456). Al entrar, la cuenta deberá definir una contraseña segura.';

export function validateProvisionalPassword(password) {
  const p = String(password || '').trim();
  if (p.length < 6) {
    return {
      ok: false,
      error:
        'La contraseña inicial debe tener al menos 6 caracteres. En el primer acceso la cuenta definirá una contraseña segura.',
    };
  }
  return { ok: true, error: null };
}

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

/** Cumple longitud, mayús., minús. y símbolo (misma regla que `validatePasswordStrength`). */
export function isPasswordPolicySatisfied(password) {
  return validatePasswordStrength(password).ok;
}
