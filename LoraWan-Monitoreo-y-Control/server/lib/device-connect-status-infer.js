'use strict';

const { isLastDbIngestStale, resolveCommsStaleOfflineMs } = require('../comms-stale-policy');
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
 * Estado de conexión para el listado: cualquier ingesta reciente (join OTAA o uplink) cuenta como en línea.
 * El Join-Accept que el LNS encola es comunicación real con el gateway (actualiza Visto).
 * @param {object} row Fila del listado
 * @param {object} telemetryRow Telemetría mostrada (puede ser fusionada)
 * @param {object|null} [rawLatestRow] Última fila en BD sin fusionar
 * @param {{ nowMs?: number, commsStaleMs?: number }} [opts]
 */
function inferFreshOnlineConnectStatus(row, telemetryRow, rawLatestRow = null, opts = {}) {
  if (!telemetryRow || telemetryRow.timestamp == null) return;
  const now = opts.nowMs != null ? Number(opts.nowMs) : Date.now();
  const commsStaleMs = opts.commsStaleMs != null ? Number(opts.commsStaleMs) : resolveCommsStaleOfflineMs();
  const activityTs = Number(telemetryRow.timestamp);
  if (!Number.isFinite(activityTs)) return;
  if (isLastDbIngestStale(activityTs, now, commsStaleMs)) return;

  row.connectStatus = 'ONLINE';
  row.lastUpdateTime = activityTs;
  delete row.ingestStatus;
}

module.exports = {
  joinOnlyTelemetryHint,
  inferFreshOnlineConnectStatus,
};
