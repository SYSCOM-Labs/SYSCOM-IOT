/**
 * Comportamiento de downlinks según clase de plantilla (espejo de `server/lib/lorawan-class-behavior.cjs`).
 */

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
