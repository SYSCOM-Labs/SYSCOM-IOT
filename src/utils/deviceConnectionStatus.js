/**
 * Sin telemetría nueva en este margen → desconectado (misma regla en `server/server.js`, env `SYSCOM_DEVICE_STALE_OFFLINE_MS`).
 * Valor fijo: 40 minutos.
 */
export const DEVICE_STALE_OFFLINE_MS = 40 * 60 * 1000;

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
  if (Date.now() - ms > DEVICE_STALE_OFFLINE_MS) {
    return { ...device, connectStatus: 'OFFLINE' };
  }
  return device;
}

export function isDeviceVisuallyOnline(device) {
  const d = applyStaleOfflineConnectStatus(device);
  const s = String(d.connectStatus || '').trim().toUpperCase();
  if (!s || s === 'OFFLINE' || s === 'DISCONNECTED' || s === 'FALSE' || s === '0') return false;
  return ['ONLINE', 'JOINED', 'CONNECTED', 'TRUE', '1'].includes(s);
}
