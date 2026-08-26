'use strict';

const {
  isLastDbIngestStale,
  resolveCommsStaleOfflineMs,
  resolveAppUplinkStaleMs,
} = require('../comms-stale-policy');
const { hasDecodedPeopleCountTelemetry } = require('./vs133-telemetry-aliases');

/** Telemetría generada por el LNS al encolar Join-Accept (sin payload de aplicación / conteo). */
function joinOnlyTelemetryHint(properties) {
  if (!properties || typeof properties !== 'object') return null;
  if (hasDecodedPeopleCountTelemetry(properties)) return null;
  const ev = properties.lorawan_event != null ? String(properties.lorawan_event).trim() : '';
  if (!ev || !/join/i.test(ev)) return null;
  const hex = properties.payload_hex != null ? String(properties.payload_hex).trim() : '';
  if (hex.length > 0) return null;
  return 'Solo join LoRaWAN (sin uplink de aplicación reciente). Espere el próximo reporte del sensor o revise intervalo de envío en el equipo.';
}

/**
 * Estado de conexión para el listado: usa el último paquete en aire (raw) y la edad del último uplink de app.
 * Evita marcar ONLINE al fusionar telemetría vieja cuando el nodo solo envía joins OTAA.
 * Si el último raw es join pero hay uplink de aplicación reciente, se muestra ONLINE (un re-join no tapa el reporte).
 * @param {object} row Fila del listado
 * @param {object} telemetryRow Telemetría mostrada (puede ser fusionada)
 * @param {object|null} [rawLatestRow] Última fila en BD sin fusionar
 * @param {{ nowMs?: number, commsStaleMs?: number, appStaleMs?: number }} [opts]
 */
function inferFreshOnlineConnectStatus(row, telemetryRow, rawLatestRow = null, opts = {}) {
  if (!telemetryRow || telemetryRow.timestamp == null) return;
  const now = opts.nowMs != null ? Number(opts.nowMs) : Date.now();
  const commsStaleMs = opts.commsStaleMs != null ? Number(opts.commsStaleMs) : resolveCommsStaleOfflineMs();
  const appStaleMs = opts.appStaleMs != null ? Number(opts.appStaleMs) : resolveAppUplinkStaleMs();
  const activityTs = Number(telemetryRow.timestamp);
  if (!Number.isFinite(activityTs)) return;
  if (isLastDbIngestStale(activityTs, now, commsStaleMs)) return;

  const displayProps = telemetryRow.properties || {};
  const rawProps =
    rawLatestRow && rawLatestRow.properties && typeof rawLatestRow.properties === 'object'
      ? rawLatestRow.properties
      : displayProps;

  const lastAppTs = Number(displayProps.lastAppUplinkMs);
  const hasAppTs = Number.isFinite(lastAppTs) && lastAppTs > 0;
  const appStale = hasAppTs && isLastDbIngestStale(lastAppTs, now, appStaleMs);
  const appFresh = hasAppTs && !appStale;

  if (joinOnlyTelemetryHint(rawProps)) {
    if (appFresh) {
      row.connectStatus = 'ONLINE';
      delete row.ingestStatus;
      row.lastUpdateTime = Math.max(activityTs, lastAppTs);
      return;
    }
    row.connectStatus = 'JOIN_PENDING';
    row.lastUpdateTime = activityTs;
    row.ingestStatus =
      'Solo join LoRaWAN (sin uplink de aplicación reciente). Espere el próximo reporte del sensor o revise intervalo de envío en el equipo.';
    return;
  }

  if (appStale && joinOnlyTelemetryHint(displayProps)) {
    row.connectStatus = 'JOIN_PENDING';
    row.lastUpdateTime = activityTs;
    row.ingestStatus =
      'Solo join LoRaWAN (sin uplink de aplicación reciente). Espere el próximo reporte del sensor o revise intervalo de envío en el equipo.';
    return;
  }

  const cs = row.connectStatus != null ? String(row.connectStatus).trim() : '';
  const csU = cs.toUpperCase();
  if (csU === 'JOIN' || csU === 'JOIN_PENDING') {
    row.connectStatus = 'ONLINE';
    return;
  }
  if (csU === 'JOINED' || csU === 'CONNECTED' || csU === 'ONLINE' || csU === 'TRUE' || csU === '1') {
    row.connectStatus = 'ONLINE';
    return;
  }
  if (csU === 'OFFLINE' || csU === 'DISCONNECTED') {
    row.connectStatus = 'ONLINE';
    return;
  }
  if (cs) return;
  row.connectStatus = 'ONLINE';
}

module.exports = {
  joinOnlyTelemetryHint,
  inferFreshOnlineConnectStatus,
};
