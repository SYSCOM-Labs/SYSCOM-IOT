/**
 * Telemetría procedente de gateways LoRaWAN (p. ej. ChirpStack / TTN) con payload ya decodificado.
 *
 * Milesight UC300 (decoder de referencia): formato TLV en binario; en aplicación suele llegar como JSON plano:
 * - GPIO: gpio_input_1..4 ("on"|"off"), gpio_output_1..2 ("on"|"off"), gpio_counter_* (uint32)
 * - PT100: pt100_1..2 (°C), con bloques estadísticos *_max, *_min, *_avg
 * - Corriente: adc_1..2 (mA, típ. /100 en instantáneo; float16 en estadísticos)
 * - Voltaje: adv_1..2 (V)
 * - Modbus: modbus_chn_N (número según tipo), modbus_chn_N_alarm ("read error")
 * - Meta canal 0xff: ipso_version, hardware_version, firmware_version, tsl_version, sn, lorawan_class,
 *   reset_event, device_status, …
 * - Históricos: channel_history[], modbus_history[] (arrays de objetos; no son series escalares)
 * - Respuesta downlink: collection_interval, report_interval, timestamp, time_zone, jitter_config, gpio_output_*_control
 *
 * Milesight WS101 (decoder de referencia): payload más simple; en JSON suele verse:
 * - battery (0–100 %, canal 0x01 / tipo 0x75)
 * - button_event: { status: "short press"|"long press"|"double press", msgid: number } (anidado; la app expone button_event_status)
 * - Meta 0xff: mismas ideas que UC300; sn en 6 bytes en este modelo
 * - Respuesta downlink: reporting_interval, reboot, query_device_status, led_indicator_enable, buzzer_enable, double_click_enable
 *
 * Esta capa no decodifica bytes; adapta el objeto ya decodificado para gráficos, tarjetas y selectores.
 */

/** Claves de registro / cuenta / red — no son lecturas de proceso (alineado con dashboard). */
const DEVICE_REGISTRY_IGNORE = [
  'assignments',
  'description',
  'registered',
  'superadminGlobalView',
  'rpsStatus',
  'application',
  'licenseStatus',
  'deviceType',
  'tag',
  'deviceId',
  'sn',
  'userId',
  'id',
  'deviceName',
  'timestamp',
  'mac',
  'imei',
  'devEui',
  'devEUI',
  'nwkSKey',
  'appSKey',
  'appsKey',
  'deviceSn',
  'fpt',
  'name',
  'model',
  'hardwareVersion',
  'firmwareVersion',
  'lastUpdateTime',
  'connectStatus',
];

/**
 * Metadatos del decoder Milesight / estructuras no escalares para listados tipo TSL o tarjetas numéricas.
 */
const GATEWAY_DECODER_METADATA = [
  'ipso_version',
  'hardware_version',
  'firmware_version',
  'tsl_version',
  'lorawan_class',
  'reset_event',
  'device_status',
  'text',
  'channel_history',
  'modbus_history',
  'collection_interval',
  'report_interval',
  'reporting_interval',
  'time_zone',
  'jitter_config',
  /** Control programático salida Milesight UC300 (objeto { status, duration }). */
  'gpio_output_1_control',
  'gpio_output_2_control',
  'button_event',
  'reboot',
  'query_device_status',
  'led_indicator_enable',
  'buzzer_enable',
  'double_click_enable',
];

export const PROPERTY_INFER_IGNORE_KEYS = [...DEVICE_REGISTRY_IGNORE, ...GATEWAY_DECODER_METADATA];

export const PROPERTY_INFER_IGNORE_SET = new Set(PROPERTY_INFER_IGNORE_KEYS);

/**
 * Claves típicas de capa LoRaWAN / Network Server / MAC — no son lecturas de proceso/sensor para selectores.
 * Siguen disponibles por «clave manual» si hace falta.
 */
export const LORAWAN_NETWORK_UI_SUPPRESS_KEYS = [
  'awaitingConfirmedDIAck',
  'classBPingPeriodicity',
  'classCPingPeriodicity',
  'datarate',
  'datr',
  'dr',
  'devAddr',
  'devaddr',
  'mhdr',
  'fCnt',
  'fCntDown',
  'fCntUp',
  'fPort',
  'fOpts',
  'fOptsPending',
  'gateways',
  'rxInfo',
  'txInfo',
  'phyPayload',
  'network',
  'mic',
];

export const LORAWAN_NETWORK_UI_SUPPRESS_SET = new Set(
  LORAWAN_NETWORK_UI_SUPPRESS_KEYS.map((k) => String(k).toLowerCase())
);

/**
 * Metadato de red LoRaWAN / MAC en lugar de dato de aplicación (sensor, GPIO, Modbus, etc.).
 */
export function isLikelyLorawanNetworkMetadataKey(rawKey) {
  const k = String(rawKey ?? '').trim();
  if (!k) return false;
  const kl = k.toLowerCase();
  if (LORAWAN_NETWORK_UI_SUPPRESS_SET.has(kl)) return true;
  if (/^(fcnt|fport|fopts|mhdr)$/i.test(k)) return true;
  if (/^(dr|datr|datarate)$/i.test(k)) return true;
  if (/^(devaddr|deveui|devui)$/i.test(k)) return true;
  if (/rxinfo|txinfo|phypayload|macpayload|gatewayid$/i.test(k)) return true;
  if (/pingperiodicity|confirmeddi|pendingjoin|networkversion$/i.test(kl)) return true;
  return false;
}

/**
 * Convierte valores típicos de decoders LoRaWAN a número para gráficos y umbrales.
 * Soporta boolean y cadenas "on"/"off" (Milesight GPIO, etc.).
 */
export function parseTelemetryScalar(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (typeof val === 'string') {
    const t = val.trim().toLowerCase();
    if (t === 'on' || t === 'true' || t === 'yes' || t === 'high' || t === '1') return 1;
    if (t === 'off' || t === 'false' || t === 'no' || t === 'low' || t === '0' || t === '') return 0;
    if (t === 'enable') return 1;
    if (t === 'disable') return 0;
    if (t === 'short press') return 1;
    if (t === 'long press') return 2;
    if (t === 'double press') return 3;
    if (t === 'short') return 1;
    if (t === 'long') return 2;
    if (t === 'double') return 3;
    const n = parseFloat(t.replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Solo estados binarios (interruptor / GPIO). No trata "short press" etc. como true.
 */
export function parseTelemetryBoolish(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number' && Number.isFinite(val)) {
    if (val === 0) return false;
    if (val === 1) return true;
    return null;
  }
  if (typeof val === 'string') {
    const t = val.trim().toLowerCase();
    if (/\b(short|long|double)\s+press\b/.test(t)) return null;
    const n = parseTelemetryScalar(val);
    if (n === 0) return false;
    if (n === 1) return true;
  }
  return null;
}

/**
 * Copia superficial y campos derivados para decoders Milesight con objetos anidados (p. ej. WS101 button_event).
 */
export function expandNestedGatewayTelemetry(src) {
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
  /** `button_event_status` es la fuente más reciente del pulsador; alinear `press` evita reglas `press==long` con estado viejo + `short press` nuevo. */
  if (out.button_event_status != null) {
    const s = String(out.button_event_status).toLowerCase().replace(/\s+/g, ' ').trim();
    if (s.includes('short')) out.press = 'short';
    else if (s.includes('long')) out.press = 'long';
    else if (s.includes('double')) out.press = 'double';
  }
  return out;
}

/** Pistas de nombre para enlazar el switch del dashboard a salidas Milesight. */
export const GATEWAY_TOGGLE_KEY_HINTS = ['gpio_output_1', 'gpio_output_2', 'gpio_input_1', 'gpio_input_2'];

/** Prioridad extra en selectores de telemetría para canales UC300 habituales. */
export function telemetryKeyPriorityBonus(key) {
  const k = String(key || '').toLowerCase();
  if (/^gpio_(input|output)_/.test(k)) return 45;
  if (/^modbus_chn_\d+$/.test(k)) return 35;
  if (/^adc_\d+$/.test(k) || /^adv_\d+$/.test(k)) return 30;
  if (/^pt100_\d+$/.test(k)) return 30;
  if (/^gpio_counter_\d+$/.test(k)) return 20;
  if (k === 'battery') return 28;
  if (k === 'button_event_status' || k === 'press') return 40;
  return 0;
}

const DEVICE_ROW_META_KEYS = new Set([
  'deviceId',
  'id',
  'device_id',
  'uuid',
  '_id',
  'name',
  'deviceName',
  'sn',
  'model',
  'productModel',
  'connectStatus',
  'registered',
  'registeredOnly',
  'assignments',
  'superadminGlobalView',
  'tag',
  'notes',
  'deviceSharedPresets',
  'lorawanClass',
  'licenseExpiresAt',
  'licenseValid',
  'licenseDaysLeft',
  'ingestStatus',
  'properties',
  'devEUI',
  'devEui',
  'lastUpdateTime',
]);

function assignScalarTelemetryFields(acc, src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return;
  for (const [k, v] of Object.entries(src)) {
    if (DEVICE_ROW_META_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) continue;
    acc[k] = v;
  }
  const nest = src.properties;
  if (nest && typeof nest === 'object' && !Array.isArray(nest)) {
    for (const [k, v] of Object.entries(nest)) {
      if (DEVICE_ROW_META_KEYS.has(k)) continue;
      if (v === undefined || v === null) continue;
      if (typeof v === 'object' && !Array.isArray(v)) continue;
      acc[k] = v;
    }
  }
}

/**
 * Fusiona fila de listado + capas API/SSE en un objeto plano para widgets (modal dispositivo / BSD).
 * @param {Record<string, unknown> | null | undefined} deviceRow
 * @param {...Record<string, unknown>} extraLayers
 */
export function mergeDeviceTelemetryForWidgets(deviceRow, ...extraLayers) {
  const acc = {};
  assignScalarTelemetryFields(acc, deviceRow);
  for (const layer of extraLayers) {
    assignScalarTelemetryFields(acc, layer);
  }
  const tsCandidates = [
    deviceRow?.lastUpdateTime,
    ...extraLayers.map((l) => l && l.lastUpdateTime),
  ]
    .filter((x) => x != null)
    .map((x) => (typeof x === 'number' ? x : new Date(x).getTime()))
    .filter((n) => Number.isFinite(n));
  if (tsCandidates.length) acc.lastUpdateTime = Math.max(...tsCandidates);
  return expandNestedGatewayTelemetry(acc);
}

/** Ordenar claves para selectores: proceso/sensores habituales primero, luego alfabético. */
export function sortTelemetryPickerKeys(keys) {
  return [...keys].sort((a, b) => {
    const pa = telemetryKeyPriorityBonus(a);
    const pb = telemetryKeyPriorityBonus(b);
    if (pb !== pa) return pb - pa;
    return String(a).localeCompare(String(b));
  });
}
