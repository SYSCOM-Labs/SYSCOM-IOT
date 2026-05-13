import {
  DEVICE_STALE_OFFLINE_MS,
  isLastDbIngestStaleForDisplay,
} from '../constants/commsStaleOfflineMs';

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
 * En línea si hay ingesta reciente en BD y el payload no dice explícitamente lo contrario.
 * Los uplinks LoRaWAN a menudo omiten `connectStatus`; antes eso marcaba «offline» pese a telemetría cada minuto.
 */
export function isDeviceVisuallyOnline(device) {
  const d = applyStaleOfflineConnectStatus(device);
  const ms = lastSeenMsFromDevice(d);
  if (ms == null) return false;
  if (isLastDbIngestStaleForDisplay(ms)) return false;

  const raw = d.connectStatus ?? d.status;
  const s = raw == null ? '' : String(raw).trim();
  const u = s.toUpperCase();

  if (!u) return true;

  if (u === 'OFFLINE' || u === 'DISCONNECTED' || u === 'FALSE' || u === '0' || u.includes('SIN TELEMET')) {
    return false;
  }

  return true;
}
