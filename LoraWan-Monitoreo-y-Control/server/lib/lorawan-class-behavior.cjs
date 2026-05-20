'use strict';

const { normalizeDeviceClass } = require('./resolve-downlink-class.cjs');

/**
 * Comportamiento de downlinks según clase LoRaWAN (definida en plantilla / decode-config).
 * C: TX inmediata (`imme`), no esperar uplink.
 * A/B: ventana RX tras uplink; si falla, cola diferida hasta próximo uplink.
 */

/**
 * @param {unknown} raw
 * @returns {'A'|'B'|'C'}
 */
function normalizeLorawanClassLetter(raw) {
  return normalizeDeviceClass(raw);
}

/**
 * @param {'A'|'B'|'C'|string} cls
 * @returns {boolean}
 */
function downlinkDeferUntilUplink(cls) {
  return normalizeLorawanClassLetter(cls) !== 'C';
}

/**
 * @param {'A'|'B'|'C'|string} cls
 * @returns {boolean}
 */
function downlinkUsesClassCImme(cls) {
  return normalizeLorawanClassLetter(cls) === 'C';
}

module.exports = {
  normalizeLorawanClassLetter,
  downlinkDeferUntilUplink,
  downlinkUsesClassCImme,
};
