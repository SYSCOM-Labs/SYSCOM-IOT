'use strict';

/**
 * Payloads de aplicación WT201 (Milesight wt201-encoder.js).
 * Canal típico FPort 85.
 */

const MODE = { heat: 0, em_heat: 1, cool: 2, auto: 3 };

/**
 * @param {number} mode 0–3
 * @param {number} target °C entero o con 0.5 (se redondea)
 * @param {0|1} [unit] 0 celsius, 1 fahrenheit
 * @returns {string}
 */
function encodeTemperatureControl(mode, target, unit = 0) {
  const m = Number(mode);
  const t = Math.round(Number(target) * 2) / 2;
  if (!Number.isFinite(m) || m < 0 || m > 3) return null;
  if (!Number.isFinite(t) || t < 0 || t > 127) return null;
  const tempByte = unit === 1 ? (Math.round(t) | 0x80) : Math.round(t) & 0x7f;
  return `ffb7${m.toString(16).padStart(2, '0')}${tempByte.toString(16).padStart(2, '0')}`;
}

/** @param {0|1} enable */
function encodeTemperatureControlEnable(enable) {
  const v = Number(enable) === 1 ? 1 : 0;
  return `ffc5${v.toString(16).padStart(2, '0')}`;
}

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

/**
 * @param {unknown} raw hex o id de servicio / alias
 * @returns {string | null}
 */
function resolveWt201DownlinkHex(raw) {
  const h = String(raw ?? '')
    .replace(/\s/g, '')
    .toLowerCase()
    .replace(/^0x/, '');
  if (h && /^[0-9a-f]+$/.test(h) && h.length % 2 === 0 && h.length >= 4) {
    return h;
  }

  const tok = normToken(raw);
  if (!tok) return null;

  if (
    tok === 'temperature_control_enable' ||
    tok === 'system_on' ||
    tok === 'encender' ||
    tok === 'on' ||
    tok === 'enable'
  ) {
    return encodeTemperatureControlEnable(1);
  }
  if (
    tok === 'temperature_control_disable' ||
    tok === 'system_off' ||
    tok === 'apagar' ||
    tok === 'off' ||
    tok === 'disable'
  ) {
    return encodeTemperatureControlEnable(0);
  }

  let m = tok.match(/^(?:wt201_)?(?:temp|temperature|target)(?:_|-)?(\d{1,3})(?:_c)?$/);
  if (!m) m = tok.match(/^(?:set_)?temp(?:erature)?[_-]?(\d{1,3})$/);
  if (m) {
    const t = parseInt(m[1], 10);
    const modeTok = tok.includes('cool') ? MODE.cool : tok.includes('heat') ? MODE.heat : MODE.auto;
    return encodeTemperatureControl(modeTok, t, 0);
  }

  if (tok === 'temp_22' || tok === '22c' || tok === '22_c') return encodeTemperatureControl(MODE.auto, 22, 0);
  if (tok === 'temp_23' || tok === '23c' || tok === '23_c') return encodeTemperatureControl(MODE.auto, 23, 0);

  return null;
}

module.exports = {
  encodeTemperatureControl,
  encodeTemperatureControlEnable,
  resolveWt201DownlinkHex,
  WT201_DOWNLINK_PRESETS: [
    { name: 'Encender (control temperatura)', hex: encodeTemperatureControlEnable(1) },
    { name: 'Apagar (control temperatura)', hex: encodeTemperatureControlEnable(0) },
    { name: 'Consigna 22 °C (auto)', hex: encodeTemperatureControl(MODE.auto, 22, 0) },
    { name: 'Consigna 23 °C (auto)', hex: encodeTemperatureControl(MODE.auto, 23, 0) },
    { name: 'Consigna 22 °C (frío)', hex: encodeTemperatureControl(MODE.cool, 22, 0) },
    { name: 'Consigna 23 °C (frío)', hex: encodeTemperatureControl(MODE.cool, 23, 0) },
    { name: 'Reiniciar dispositivo', hex: 'ff10ff' },
    { name: 'Consultar estado', hex: 'ff28ff' },
  ],
};
