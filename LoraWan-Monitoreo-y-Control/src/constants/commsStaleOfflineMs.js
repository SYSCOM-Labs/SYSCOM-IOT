/**
 * Criterio «sin comunicación» (misma política que `server/comms-stale-policy.js`).
 * Solo usa el instante de ingesta en BD (`lastUpdateTime` / timestamp de `/api/devices/latest`), no heurísticas locales.
 */
const DEFAULT_COMMS_STALE_OFFLINE_MS = 40 * 60 * 1000;
const DEFAULT_APP_UPLINK_STALE_MS = DEFAULT_COMMS_STALE_OFFLINE_MS;

function parsePositiveMs(s) {
  const n = parseInt(String(s ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolveFromViteEnv(env) {
  const e = env && typeof env === 'object' ? env : {};
  return (
    parsePositiveMs(e.VITE_SYSCOM_COMMS_STALE_OFFLINE_MS) ||
    parsePositiveMs(e.VITE_SYSCOM_DEVICE_STALE_OFFLINE_MS) ||
    DEFAULT_COMMS_STALE_OFFLINE_MS
  );
}

function resolveAppUplinkStaleFromVite(env) {
  const e = env && typeof env === 'object' ? env : {};
  return (
    parsePositiveMs(e.VITE_SYSCOM_APP_UPLINK_STALE_MS) ||
    parsePositiveMs(e.VITE_SYSCOM_COMMS_APP_UPLINK_STALE_MS) ||
    DEFAULT_APP_UPLINK_STALE_MS
  );
}

export const DEVICE_STALE_OFFLINE_MS = resolveFromViteEnv(
  typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {}
);

export const APP_UPLINK_STALE_MS = resolveAppUplinkStaleFromVite(
  typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {}
);

/** Sin nueva ingesta en BD más allá de este margen → tratar como OFFLINE en UI. */
export function isLastDbIngestStaleForDisplay(lastIngestMs, nowMs = Date.now(), staleMs = DEVICE_STALE_OFFLINE_MS) {
  if (lastIngestMs == null || !Number.isFinite(Number(lastIngestMs))) return true;
  return Number(nowMs) - Number(lastIngestMs) > staleMs;
}
