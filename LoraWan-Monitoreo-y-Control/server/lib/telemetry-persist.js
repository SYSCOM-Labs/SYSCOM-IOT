'use strict';

/**
 * Normaliza y deduplica telemetría antes de persistir en SQLite.
 * Quita campos de sesión LNS que no aportan a widgets/historial y evita filas repetidas (join, mismo FCnt/payload).
 */

const STRIP_BEFORE_PERSIST = new Set([
  'fcntUp',
  'fcntDown',
  'pendingMacAck',
  'awaitingConfirmedDlAck',
  'lastUplinkWallMs',
  'lastRxTmst',
  'lastRxFreq',
  'lastRxDatr',
  'lastRxCodr',
  'lastRxRfch',
  'classBPingPeriodicity',
  'classBDataRate',
  'rxDelaySec',
  'deviceClass',
  'join_cflist_hex',
  'join_dl_settings',
  'join_rx_delay',
  'last_update',
]);

const DEDUP_IGNORE_KEYS = new Set([
  ...STRIP_BEFORE_PERSIST,
  'gateway_id',
  'gateway_mac',
  'rssi',
  'lora_snr',
  'loraSNR',
  'snr',
  'lsnr',
  'freq',
  'freq_mhz',
  'datr',
  'datarate',
  'dr',
  'tmst',
  'received_at',
  'lastUpdateTime',
  'connectStatus',
  'status',
  'source',
  'uplink_id',
]);

function envMs(name, fallback) {
  const n = parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function isJoinOnlyProperties(props) {
  if (!props || typeof props !== 'object') return false;
  const ev = props.lorawan_event != null ? String(props.lorawan_event).trim() : '';
  if (!ev || !/join/i.test(ev)) return false;
  const hex = props.payload_hex != null ? String(props.payload_hex).trim() : '';
  const b64 = props.payload_b64 != null ? String(props.payload_b64).trim() : '';
  return hex.length === 0 && b64.length === 0;
}

/**
 * @param {Record<string, unknown>} properties
 * @returns {Record<string, unknown>}
 */
function preparePropertiesForPersistence(properties) {
  if (!properties || typeof properties !== 'object') return {};
  const out = { ...properties };
  for (const k of STRIP_BEFORE_PERSIST) {
    if (k in out) delete out[k];
  }
  return out;
}

/**
 * Huella estable para deduplicar (ignora RSSI/GW/timestamps que cambian en cada paquete).
 * @param {Record<string, unknown>} properties
 */
function telemetryIngestFingerprint(properties) {
  if (!properties || typeof properties !== 'object') return '';
  const parts = [];
  const keys = Object.keys(properties).sort();
  for (const k of keys) {
    if (DEDUP_IGNORE_KEYS.has(k)) continue;
    const v = properties[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      try {
        parts.push(`${k}=${JSON.stringify(v)}`);
      } catch {
        parts.push(`${k}=[object]`);
      }
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.join('|');
}

/**
 * @param {{ getLastTelemetryRow?: (uid: string, did: string) => { properties_json: string, ts: number } | undefined }} store
 */
function shouldSkipTelemetryInsert(store, userId, deviceId, properties) {
  const uid = String(userId);
  const did = String(deviceId);
  const prepared = preparePropertiesForPersistence(properties);
  const fp = telemetryIngestFingerprint(prepared);

  const row =
    typeof store.getLastTelemetryRow === 'function'
      ? store.getLastTelemetryRow(uid, did)
      : store.st?.lastTelemetrySameProps?.get(uid, did);

  if (!row) return { skip: false, prepared };

  let prevProps = {};
  try {
    prevProps = JSON.parse(row.properties_json || '{}');
  } catch {
    prevProps = {};
  }

  const prevTs = Number(row.ts);
  const ageMs = Number.isFinite(prevTs) ? Date.now() - prevTs : Infinity;

  if (String(prepared.deviceType || '').toUpperCase() === 'GATEWAY') {
    const gwDedupMs = envMs('SYSCOM_TELEMETRY_GATEWAY_DEDUP_MS', 300_000);
    const gw = String(prepared.gateway_id || prepared.gatewayEui || prepared.devEUI || '').toLowerCase();
    const prevGw = String(prevProps.gateway_id || prevProps.gatewayEui || prevProps.devEUI || '').toLowerCase();
    if (ageMs < gwDedupMs && gw && gw === prevGw) {
      return { skip: true, reason: 'gateway_duplicate', prepared };
    }
  }

  if (isJoinOnlyProperties(prepared)) {
    const joinDedupMs = envMs('SYSCOM_TELEMETRY_JOIN_DEDUP_MS', 120_000);
    if (ageMs < joinDedupMs && isJoinOnlyProperties(prevProps)) {
      return { skip: true, reason: 'join_duplicate', prepared };
    }
    return { skip: false, prepared };
  }

  const dedupMs = Math.min(300_000, envMs('SYSCOM_TELEMETRY_DEDUP_MS', 12_000));
  const prevHex = prevProps.payload_hex != null ? String(prevProps.payload_hex).trim().toUpperCase() : '';
  const nextHex = prepared.payload_hex != null ? String(prepared.payload_hex).trim().toUpperCase() : '';
  if (prevHex && nextHex && prevHex !== nextHex) {
    return { skip: false, prepared };
  }
  if (ageMs >= dedupMs) return { skip: false, prepared };

  const prevFp = telemetryIngestFingerprint(preparePropertiesForPersistence(prevProps));
  if (fp && fp === prevFp) {
    return { skip: true, reason: 'fingerprint_duplicate', prepared };
  }

  const nextJson = JSON.stringify(prepared);
  if (row.properties_json === nextJson) {
    return { skip: true, reason: 'json_duplicate', prepared };
  }

  return { skip: false, prepared };
}

module.exports = {
  preparePropertiesForPersistence,
  telemetryIngestFingerprint,
  shouldSkipTelemetryInsert,
  isJoinOnlyProperties,
  STRIP_BEFORE_PERSIST,
};
