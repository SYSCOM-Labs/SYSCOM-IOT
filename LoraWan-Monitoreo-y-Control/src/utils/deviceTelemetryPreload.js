/**
 * Caché en memoria de telemetría lista para widgets (precarga desde listado BD + /properties).
 * Evita esperar HTTP al abrir el modal de un dispositivo.
 */
import {
  hasMeaningfulAppTelemetry,
  mergeDeviceTelemetryForWidgets,
} from './gatewayPayload';

/** @type {Map<string, { flat: Record<string, unknown>, at: number }>} */
const cache = new Map();

const MAX_ENTRIES = 120;

function pruneCache() {
  if (cache.size <= MAX_ENTRIES) return;
  const sorted = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  const drop = sorted.length - MAX_ENTRIES;
  for (let i = 0; i < drop; i += 1) cache.delete(sorted[i][0]);
}

/**
 * @param {string} deviceId
 * @returns {{ flat: Record<string, unknown>, at: number } | null}
 */
export function getDeviceTelemetryPreload(deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return null;
  return cache.get(id) || null;
}

/**
 * @param {string} deviceId
 * @param {Record<string, unknown>} flat
 */
export function setDeviceTelemetryPreload(deviceId, flat) {
  const id = String(deviceId || '').trim();
  if (!id || !flat || typeof flat !== 'object') return;
  cache.set(id, { flat: { ...flat }, at: Date.now() });
  pruneCache();
}

/**
 * Precarga desde fila del listado (ya incluye última telemetría de GET /api/devices).
 * @param {Record<string, unknown> | null | undefined} deviceRow
 */
export function primeDeviceTelemetryPreloadFromListRow(deviceRow) {
  if (!deviceRow?.deviceId) return;
  const id = String(deviceRow.deviceId).trim();
  const flat = mergeDeviceTelemetryForWidgets(deviceRow);
  const prev = cache.get(id);
  let nextFlat = flat;
  if (prev?.flat) {
    nextFlat = mergeDeviceTelemetryForWidgets(deviceRow, prev.flat, flat);
    if (!hasMeaningfulAppTelemetry(flat) && hasMeaningfulAppTelemetry(prev.flat)) {
      nextFlat = mergeDeviceTelemetryForWidgets(deviceRow, prev.flat);
    }
  }
  cache.set(id, { flat: nextFlat, at: Date.now() });
  pruneCache();
}

/**
 * @param {Record<string, unknown>} deviceRow
 * @param {number} [maxAgeMs]
 */
export function isDeviceTelemetryPreloadFresh(deviceId, maxAgeMs = 120000) {
  const hit = getDeviceTelemetryPreload(deviceId);
  if (!hit) return false;
  if (!hasMeaningfulAppTelemetry(hit.flat)) return false;
  return Date.now() - hit.at < maxAgeMs;
}

/**
 * Fila del listado + caché (si hay) → objeto listo para el modal / BSD.
 * @param {Record<string, unknown>} deviceRow
 */
export function deviceRowWithPreloadedTelemetry(deviceRow) {
  if (!deviceRow) return deviceRow;
  const id = String(deviceRow.deviceId || '').trim();
  const cached = id ? getDeviceTelemetryPreload(id) : null;
  const fromList = mergeDeviceTelemetryForWidgets(deviceRow);
  const flat = cached?.flat
    ? mergeDeviceTelemetryForWidgets(deviceRow, cached.flat, fromList)
    : fromList;
  return {
    ...deviceRow,
    ...flat,
    lastUpdateTime: flat.lastUpdateTime ?? deviceRow.lastUpdateTime ?? null,
  };
}

/**
 * Precarga /properties en segundo plano (SQLite) para abrir el modal sin espera.
 * @param {object[]} deviceRows
 * @param {object} credentials
 * @param {string} token
 * @param {{ limit?: number }} [opts]
 */
export async function prefetchDevicePropertiesBatch(deviceRows, credentials, token, opts = {}) {
  if (!credentials || !token || !Array.isArray(deviceRows) || !deviceRows.length) return;
  const limit = Math.max(1, Math.min(Number(opts.limit) || 24, 48));
  const { fetchDeviceProperties } = await import('../services/api');
  const slice = deviceRows.slice(0, limit);
  await Promise.all(
    slice.map(async (row) => {
      const id = String(row.deviceId || '').trim();
      if (!id) return;
      const hit = getDeviceTelemetryPreload(id);
      if (hit && isDeviceTelemetryPreloadFresh(id, 90000) && hasMeaningfulAppTelemetry(hit.flat)) return;
      try {
        const resp = await fetchDeviceProperties(id, credentials, token);
        const apiData = resp.data?.data || {};
        const live = apiData.properties || resp.data?.properties || {};
        const flat = mergeDeviceTelemetryForWidgets(row, live);
        setDeviceTelemetryPreload(id, flat);
      } catch {
        /* ignore */
      }
    })
  );
}
