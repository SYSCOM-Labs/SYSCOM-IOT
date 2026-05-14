/**
 * Clases de borde para inputs (p. ej. `input-border--valid` / `input-border--invalid`).
 * Cuenta solo dígitos hex [0-9A-F]; ignora espacios y separadores al medir la longitud.
 * @returns {''|'input-border--valid'|'input-border--invalid'}
 */
export function hexDigitsBorderClass(value, expectedHexLen) {
  const raw = String(value ?? '');
  if (!raw.trim()) return '';
  const h = raw.replace(/[^0-9a-fA-F]/g, '');
  if (h.length === expectedHexLen) return 'input-border--valid';
  return 'input-border--invalid';
}

/**
 * Campo obligatorio con contenido significativo tras trim.
 * Vacío → sin clase; solo espacios → rojo; texto válido → verde.
 * @returns {''|'input-border--valid'|'input-border--invalid'}
 */
export function requiredTrimBorderClass(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  const t = raw.trim();
  if (t.length >= 1) return 'input-border--valid';
  return 'input-border--invalid';
}
