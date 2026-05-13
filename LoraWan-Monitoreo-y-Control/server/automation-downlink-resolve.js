'use strict';

/**
 * Convierte `commandKey` de reglas de automatización (hex o id de servicio TSL estilo Milesight)
 * en payload hex LoRaWAN de aplicación.
 *
 * El cliente puede guardar ids de servicio porque `POST .../services/call` los traduce; el
 * motor de automatización en servidor solo encolaba hex puro antes de este módulo.
 *
 * Referencia payloads WT201: encoder oficial Milesight (`wt201-encoder.js`), p. ej.
 * `temperature_control_enable` → FF C5 01 / 00.
 */

/** @param {unknown} s */
function stripToHex(s) {
  const t = String(s ?? '')
    .replace(/\s/g, '')
    .toLowerCase()
    .replace(/^0x/, '');
  if (!t || !/^[0-9a-f]+$/i.test(t) || t.length % 2 !== 0) return null;
  return t;
}

/** @param {unknown} s */
function normToken(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s*\(service\)\s*$/i, '')
    .replace(/\s*\(guardado\)\s*$/i, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Claves normalizadas (sin espacios, minúsculas, guiones bajos). */
const KNOWN_SERVICE_HEX = {
  // WT201: setTemperatureControlEnable (Milesight encoder)
  system_on: 'ffc501',
  system_off: 'ffc500',
  temperature_control_enable: 'ffc501',
  temperature_control_disable: 'ffc500',

  reboot: 'ff10ff',
  sync_time: 'ff4aff',
};

/**
 * @param {{ commandKey?: unknown, command_key?: unknown, target?: unknown, targetDeviceId?: unknown }} action
 * @returns {string | null} hex par (minúsculas) o null
 */
function resolveAutomationDownlinkHex(action) {
  const candidates = [action.commandKey, action.command_key, action.target];
  for (const raw of candidates) {
    const h = stripToHex(raw);
    if (h) return h;
  }
  for (const raw of candidates) {
    const tok = normToken(raw);
    if (tok && Object.prototype.hasOwnProperty.call(KNOWN_SERVICE_HEX, tok)) {
      return KNOWN_SERVICE_HEX[tok];
    }
  }
  return null;
}

module.exports = {
  resolveAutomationDownlinkHex,
};
