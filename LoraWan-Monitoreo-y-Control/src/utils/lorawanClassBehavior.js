/**
 * Comportamiento de downlinks según clase de plantilla (espejo de `server/lib/lorawan-class-behavior.cjs`).
 */

/**
 * Clase forzada por modelo. UC300 es controlador con DO: downlink inmediato (clase C).
 * @param {string|null|undefined} productModelOrModelo
 * @returns {'C'|null}
 */
export function forcedLorawanClassForProductModel(productModelOrModelo) {
  const s = String(productModelOrModelo || '').toUpperCase();
  if (s.includes('UC300')) return 'C';
  return null;
}

/**
 * @param {'A'|'B'|'C'|string|null|undefined} cls
 * @returns {boolean}
 */
export function downlinkDeferUntilUplink(cls) {
  const u = String(cls || 'A')
    .trim()
    .toUpperCase();
  return u !== 'C';
}

/**
 * @param {'A'|'B'|'C'|string|null|undefined} cls
 * @returns {boolean}
 */
export function downlinkUsesClassCImme(cls) {
  return String(cls || '')
    .trim()
    .toUpperCase() === 'C';
}
