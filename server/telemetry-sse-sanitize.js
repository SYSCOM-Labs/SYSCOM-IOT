'use strict';

const STRING_MAX = 520;
const KEYS_MAX = 64;
const NEST_JSON_MAX = 480;

/**
 * Copia superficial de propiedades de telemetría para SSE (evita payloads enormes).
 * @param {Record<string, unknown>|null|undefined} properties
 * @returns {Record<string, unknown>|undefined}
 */
function sanitizeTelemetryForSse(properties) {
  if (!properties || typeof properties !== 'object') return undefined;
  const out = {};
  const keys = Object.keys(properties).sort();
  let n = 0;
  for (const key of keys) {
    if (n >= KEYS_MAX) {
      out._truncatedKeys = true;
      break;
    }
    const v = properties[key];
    if (v == null) {
      out[key] = v;
      n += 1;
      continue;
    }
    if (typeof v === 'string') {
      out[key] = v.length > STRING_MAX ? `${v.slice(0, STRING_MAX)}…` : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[key] = v;
    } else if (Array.isArray(v)) {
      out[key] = v.length > 24 ? [...v.slice(0, 24), '…'] : v;
    } else if (typeof v === 'object') {
      try {
        const s = JSON.stringify(v);
        out[key] = s.length > NEST_JSON_MAX ? `${s.slice(0, NEST_JSON_MAX)}…` : JSON.parse(s);
      } catch {
        out[key] = '[no serializable]';
      }
    } else {
      out[key] = String(v).slice(0, STRING_MAX);
    }
    n += 1;
  }
  return out;
}

module.exports = { sanitizeTelemetryForSse };
