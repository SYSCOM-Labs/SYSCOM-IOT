import { DEVICE_STALE_OFFLINE_MS, isLastDbIngestStaleForDisplay } from '../constants/commsStaleOfflineMs';

export { DEVICE_STALE_OFFLINE_MS };

export function lastSeenMsFromDevice(device) {
  if (!device) return null;
  const raw = device.lastUpdateTime ?? device.lastTimestamp ?? device.timestamp;
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : new Date(raw).getTime();
  return Number.isFinite(n) ? n : null;
}

export function applyStaleOfflineConnectStatus(device) {
  if (!device) return device;
  const ms = lastSeenMsFromDevice(device);
  if (ms == null) return device;
  if (isLastDbIngestStaleForDisplay(ms)) {
    return { ...device, connectStatus: 'OFFLINE' };
  }
  return device;
}

/**
 * Join OTAA reciente: el listado lo trata como en línea (hay radio con el gateway).
 * Conservado por si alguna vista quiere el matiz; el estado visible usa `isDeviceVisuallyOnline`.
 */
export function isDeviceJoinPendingOnly(_device) {
  return false;
}

/**
 * En línea si hay ingesta reciente en BD (uplink de aplicación o join OTAA / Join-Accept).
 */
export function isDeviceVisuallyOnline(device) {
  const d = applyStaleOfflineConnectStatus(device);
  const ms = lastSeenMsFromDevice(d);
  if (ms == null) return false;
  if (isLastDbIngestStaleForDisplay(ms)) return false;

  const raw = d.connectStatus ?? d.status;
  const s = raw == null ? '' : String(raw).trim();
  const u = s.toUpperCase();
  if (u.includes('SIN TELEMET')) return false;
  return true;
}
