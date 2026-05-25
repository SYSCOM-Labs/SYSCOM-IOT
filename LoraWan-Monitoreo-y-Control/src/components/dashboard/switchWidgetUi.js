/**
 * Etiquetas en vivo del widget Switch (telemetría + estado de red).
 */
import {
  GATEWAY_TOGGLE_KEY_HINTS,
  isLikelyLorawanNetworkMetadataKey,
  parseTelemetryBoolish,
  PROPERTY_INFER_IGNORE_SET,
} from '../../utils/gatewayPayload';
import { tryTelemetryDisplayLabel } from '../../utils/telemetryDisplayFormat';

const SWITCH_TOGGLE_KEY_HINTS = [
  'temperature_control_enable',
  'switch_1',
  'switch_2',
  ...GATEWAY_TOGGLE_KEY_HINTS,
  'relay',
  'output',
  'switch',
  'valve',
  'pump',
  'power',
  'led',
  'socket',
  'digitalOutput',
  'relay1',
  'relay_1',
  'do1',
];

function isTelemetryMetadataFalsePositiveKey(k) {
  const s = String(k || '');
  if (!s) return true;
  const u = s.toUpperCase();
  if (/^(_|LAST|PREV)/.test(u)) return true;
  if (/^(DEV|EUI|ADDR|GW|GATEWAY|TIME|DATE|TS|FCNT|FPORT|MARGIN|DR|DATARATE)/i.test(s)) return true;
  if (/(RSSI|SNR|FCNT|FPORT|FREQ|RFCH|CHANNEL|COUNTER|SEEN|DRIFT)$/i.test(u)) return true;
  return false;
}

function scoreToggleKeyCandidate(k) {
  const s = String(k).toLowerCase();
  let score = 0;
  for (const w of [
    'temperature_control_enable',
    'switch_1',
    'switch_2',
    'switch',
    'relay',
    'output',
    'digital',
    'socket',
    'valve',
    'pump',
    'motor',
    'lock',
    'door',
    'rly',
  ]) {
    if (s.includes(w)) score += 25;
  }
  if (/^ch\d|^out\d|^dio|^r\d|^do\d/.test(s)) score += 18;
  if (s === 'temperature_control_enable') score += 40;
  if (s === 'system_enable' || s === 'device_status' || s === 'system_status') score -= 20;
  if (/_status$/.test(s) && !s.includes('temperature_control') && !s.includes('switch')) score -= 12;
  return score;
}

/**
 * @param {Record<string, unknown> | null | undefined} props
 * @param {string | undefined} [preferredKey] desde `data.switchTelemetryField`
 * @returns {string | null}
 */
export function pickSwitchToggleKey(props, preferredKey) {
  if (!props || typeof props !== 'object') return null;
  const pref = typeof preferredKey === 'string' ? preferredKey.trim() : '';
  if (pref && !PROPERTY_INFER_IGNORE_SET.has(pref) && props[pref] != null && props[pref] !== '') {
    return pref;
  }
  const lowerToActual = new Map();
  for (const key of Object.keys(props)) {
    if (PROPERTY_INFER_IGNORE_SET.has(key)) continue;
    lowerToActual.set(key.toLowerCase(), key);
  }
  for (const k of SWITCH_TOGGLE_KEY_HINTS) {
    const actual = lowerToActual.get(String(k).toLowerCase());
    if (!actual) continue;
    const val = props[actual];
    if (val != null && val !== '') return actual;
  }
  const candidates = [];
  for (const k of Object.keys(props)) {
    if (PROPERTY_INFER_IGNORE_SET.has(k)) continue;
    if (isSwitchTelemetryMetaKey(k)) continue;
    const v = props[k];
    const boolish =
      typeof v === 'boolean' ||
      v === 0 ||
      v === 1 ||
      v === '0' ||
      v === '1' ||
      (typeof v === 'string' && parseTelemetryBoolish(v) !== null);
    if (!boolish) continue;
    candidates.push(k);
  }
  const relayish = candidates.filter((c) => !isTelemetryMetadataFalsePositiveKey(c));
  const pool = relayish.length ? relayish : candidates;
  if (!pool.length) return null;
  pool.sort((a, b) => {
    const d = scoreToggleKeyCandidate(b) - scoreToggleKeyCandidate(a);
    if (d !== 0) return d;
    return String(a).localeCompare(String(b));
  });
  return pool[0];
}

/** @param {Record<string, unknown> | null | undefined} props @param {string | null} toggleKey */
export function readSwitchOnFromTelemetry(props, toggleKey) {
  if (!toggleKey || !props || typeof props !== 'object') return false;
  const v = props[toggleKey];
  const b = parseTelemetryBoolish(v);
  if (b !== null) return b;
  if (typeof v === 'number' && Number.isFinite(v)) return v !== 0;
  if (typeof v === 'string') {
    const n = Number(String(v).trim().replace(',', '.'));
    if (Number.isFinite(n)) return n !== 0;
  }
  return false;
}

/** Claves que no deben usarse como interruptor ON/OFF. */
export function isSwitchTelemetryMetaKey(key) {
  const k = String(key ?? '').trim();
  if (!k) return true;
  const kl = k.toLowerCase();
  if (isLikelyLorawanNetworkMetadataKey(k)) return true;
  if (/awaiting|confirmeddl|pendingdl|macack|ingeststatus|connectstatus|lastupdate/i.test(kl)) return true;
  if (kl === 'lorawan_event' || kl === 'payload_hex' || kl === 'msgid') return true;
  return false;
}

/** @param {string} key */
export function humanizeSwitchFieldKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  const map = {
    switch_1: 'Salida 1',
    switch_2: 'Salida 2',
    temperature_control_enable: 'Control de temperatura',
    temperature_control_status: 'Estado HVAC',
    system_enable: 'Sistema',
    system_status: 'Estado del sistema',
    device_status: 'Estado del dispositivo',
    fan_status: 'Ventilador',
    relay: 'Relé',
    output: 'Salida',
    awaitingConfirmedDlAck: 'Downlink confirmado',
  };
  if (map[k]) return map[k];
  return k
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * @param {string} toggleKey
 * @param {unknown} raw
 * @param {string | null | undefined} deviceModel
 * @param {Record<string, unknown> | null | undefined} hintMap
 */
export function formatSwitchTelemetryValue(toggleKey, raw, deviceModel, hintMap) {
  if (raw === undefined || raw === null) return '—';
  const friendly = tryTelemetryDisplayLabel(deviceModel, toggleKey, raw, hintMap);
  if (friendly != null && String(friendly).trim()) return String(friendly).trim();
  const b = parseTelemetryBoolish(raw);
  if (b === true) return 'Encendido';
  if (b === false) return 'Apagado';
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw === 0 ? 'Apagado' : 'Encendido';
  const s = String(raw).trim();
  return s || '—';
}

/**
 * @param {Record<string, unknown> | null | undefined} telemetry
 * @param {boolean} isOn estado del interruptor (clic manual o regla de automatización)
 * @param {boolean} busy
 * @param {boolean} [telemetryOn] lectura en vivo (solo panel de detalle)
 * @param {string | null} toggleKey
 * @param {string | null | undefined} deviceModel
 * @param {Record<string, unknown> | null | undefined} hintMap
 */
export function buildSwitchWidgetLiveUi({
  telemetry,
  isOn,
  busy,
  telemetryOn,
  toggleKey,
  deviceModel,
  hintMap,
}) {
  const lines = [];
  const primaryState = busy ? 'Enviando…' : isOn ? 'Encendido' : 'Apagado';
  const primaryTone = busy ? 'busy' : isOn ? 'on' : 'off';
  const liveOn =
    telemetryOn !== undefined && telemetryOn !== null
      ? Boolean(telemetryOn)
      : toggleKey && telemetry
        ? readSwitchOnFromTelemetry(telemetry, toggleKey)
        : null;

  if (toggleKey && liveOn !== null) {
    const raw = telemetry && typeof telemetry === 'object' ? telemetry[toggleKey] : undefined;
    const liveLabel = formatSwitchTelemetryValue(toggleKey, raw, deviceModel, hintMap);
    lines.push({
      kind: 'field',
      label: humanizeSwitchFieldKey(toggleKey),
      value: liveLabel,
    });
    if (liveOn !== isOn && !busy) {
      lines.push({
        kind: 'telemetry',
        value: `En equipo: ${liveLabel}`,
      });
    }
  } else if (!toggleKey) {
    lines.push({
      kind: 'hint',
      value: 'Sin campo ON/OFF en telemetría (configura switch_1, temperature_control_enable, etc.)',
    });
  }

  if (telemetry && typeof telemetry === 'object') {
    const ack = telemetry.awaitingConfirmedDlAck ?? telemetry.awaitingConfirmedDIAck;
    if (ack === true || ack === 1 || ack === '1' || ack === 'true') {
      lines.push({
        kind: 'network',
        value: 'Esperando confirmación del dispositivo',
      });
    }
  }

  if (busy) {
    lines.push({ kind: 'busy', value: 'Comando downlink en curso' });
  }

  return { primaryState, primaryTone, lines };
}
