/** Misma tabla que `server/lib/ws501-downlink-legacy.cjs` (canónico WS501: 0810ff / 0811ff). */
const MILESIGHT_ALT_TO_CANONICAL = {
  ff2910: '0810ff',
  ff2911: '0811ff',
};

/**
 * @param {string} hex
 * @param {string} [productModelOrModelo]
 * @returns {string}
 */
export function remapWs501DownlinkHex(hex, productModelOrModelo) {
  const pm = String(productModelOrModelo || '').toUpperCase();
  if (!pm.includes('WS501')) return hex;
  const h = String(hex || '')
    .replace(/\s/g, '')
    .replace(/^0x/i, '')
    .toLowerCase();
  return MILESIGHT_ALT_TO_CANONICAL[h] || h;
}

/**
 * @param {Array<{ name?: string, hex?: string }>} downlinks
 * @param {string} [productModelOrModelo]
 */
export function remapWs501DownlinkList(downlinks, productModelOrModelo) {
  const pm = String(productModelOrModelo || '').toUpperCase();
  if (!pm.includes('WS501')) return downlinks;
  return (Array.isArray(downlinks) ? downlinks : []).map((d) => ({
    ...d,
    hex: remapWs501DownlinkHex(d.hex, pm),
  }));
}
