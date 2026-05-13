'use strict';

/** Sin nueva fila de telemetría en BD (`ts` de ingesta) → sin comunicación LoRa/gateway verificable. */
const DEFAULT_COMMS_STALE_OFFLINE_MS = 40 * 60 * 1000;

function parsePositiveMs(envVal) {
  const n = parseInt(String(envVal ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Umbral «sin comunicación» (dispositivos y gateways).
 * Prioridad: SYSCOM_COMMS_STALE_OFFLINE_MS → SYSCOM_DEVICE_STALE_OFFLINE_MS → 40 min.
 */
function resolveCommsStaleOfflineMs() {
  return (
    parsePositiveMs(process.env.SYSCOM_COMMS_STALE_OFFLINE_MS) ||
    parsePositiveMs(process.env.SYSCOM_DEVICE_STALE_OFFLINE_MS) ||
    DEFAULT_COMMS_STALE_OFFLINE_MS
  );
}

/**
 * @param {number} lastIngestTsMs - `telemetry.ts` (ingesta en servidor), no campos del payload del nodo.
 * @param {number} nowMs
 * @param {number} staleMs
 */
function isLastDbIngestStale(lastIngestTsMs, nowMs, staleMs) {
  if (lastIngestTsMs == null || !Number.isFinite(Number(lastIngestTsMs))) return true;
  return Number(nowMs) - Number(lastIngestTsMs) > staleMs;
}

module.exports = {
  DEFAULT_COMMS_STALE_OFFLINE_MS,
  resolveCommsStaleOfflineMs,
  isLastDbIngestStale,
};
