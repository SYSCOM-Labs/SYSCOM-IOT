'use strict';

/**
 * Downlinks canónicos WS501 (plantilla SYSCOM): Encender `0811ff`, Apagar `0810ff`.
 * Normaliza variantes `ff2910` / `ff2911` guardadas en versiones anteriores del catálogo.
 */
const MILESIGHT_ALT_TO_CANONICAL = {
  ff2910: '0810ff',
  ff2911: '0811ff',
};

/**
 * @param {string} hex
 * @param {string} [productModel]
 * @returns {string}
 */
function remapWs501LegacyDownlinkHex(hex, productModel) {
  const pm = String(productModel || '').toUpperCase();
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
function remapWs501DownlinkList(downlinks, productModelOrModelo) {
  const pm = String(productModelOrModelo || '').toUpperCase();
  if (!pm.includes('WS501')) return downlinks;
  return (Array.isArray(downlinks) ? downlinks : []).map((d) => ({
    ...d,
    hex: remapWs501LegacyDownlinkHex(d.hex, pm),
  }));
}

module.exports = {
  remapWs501LegacyDownlinkHex,
  remapWs501DownlinkList,
  MILESIGHT_ALT_TO_CANONICAL,
};
