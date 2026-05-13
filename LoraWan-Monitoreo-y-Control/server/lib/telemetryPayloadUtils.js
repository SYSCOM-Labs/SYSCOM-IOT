'use strict';

/**
 * Aplanado y expansión mínima de telemetría (alineado con `src/utils/gatewayPayload.js` y `server/server.js`).
 * Usado al fusionar filas históricas para exponer la última lectura conocida por clave aunque el último uplink sea parcial.
 */

const TSL_IGNORE = new Set([
  'rpsStatus',
  'model',
  'hardwareVersion',
  'firmwareVersion',
  'lastUpdateTime',
  'application',
  'licenseStatus',
  'deviceType',
  'tag',
  'devEUI',
  'connectStatus',
  'deviceId',
  'sn',
  'userId',
  'id',
  'deviceName',
  'timestamp',
  'mac',
  'imei',
  'devEui',
  'deviceSn',
  'fpt',
  'nwkSKey',
  'appSKey',
  'appsKey',
]);

function expandNestedGatewayTelemetry(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return src;
  const out = { ...src };
  const be = out.button_event;
  if (be && typeof be === 'object' && !Array.isArray(be) && be.status != null) {
    out.button_event_status = be.status;
  } else if (out.press != null && out.button_event_status == null) {
    const p = String(out.press).toLowerCase();
    const m = { short: 'short press', long: 'long press', double: 'double press' };
    out.button_event_status = m[p] || String(out.press);
  }
  if (out.button_event_status != null) {
    const s = String(out.button_event_status)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (s.includes('short')) out.press = 'short';
    else if (s.includes('long')) out.press = 'long';
    else if (s.includes('double')) out.press = 'double';
  }
  return out;
}

/** Claves anidadas tipo `a.b` para selectores de widget / TSL */
function flattenTelemetryProps(obj) {
  const out = {};
  function walk(o, prefix) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    if (Buffer.isBuffer(o) || o instanceof Uint8Array) return;
    for (const [k, v] of Object.entries(o)) {
      if (TSL_IGNORE.has(k)) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        if (Buffer.isBuffer(v) || v instanceof Uint8Array) continue;
        if (v.type === 'Buffer' && Array.isArray(v.data)) continue;
        walk(v, key);
      } else {
        out[key] = v;
      }
    }
  }
  walk(obj, '');
  return out;
}

function isMeaningfulTelemetryMergeValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return false;
  return true;
}

module.exports = {
  expandNestedGatewayTelemetry,
  flattenTelemetryProps,
  isMeaningfulTelemetryMergeValue,
};
