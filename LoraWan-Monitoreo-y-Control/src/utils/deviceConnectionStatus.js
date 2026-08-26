import { APP_UPLINK_STALE_MS, DEVICE_STALE_OFFLINE_MS, isLastDbIngestStaleForDisplay } from '../constants/commsStaleOfflineMs';
import { isJoinOnlyDeviceRow } from './joinOnlyTelemetry';

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
 * Join OTAA reciente en BD pero sin uplink de aplicación (p. ej. UC300 en bucle de re-join).
 * No equivale a «en línea» operativo ni a telemetría cada 1 min.
 */
function lastAppUplinkMsFromDevice(device) {
  if (!device) return null;
  const raw = device.lastAppUplinkMs ?? device.properties?.lastAppUplinkMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isDeviceJoinPendingOnly(device) {
  const d = applyStaleOfflineConnectStatus(device);
  const ms = lastSeenMsFromDevice(d);
  if (ms == null) return false;
  if (isLastDbIngestStaleForDisplay(ms)) return false;
  const appMs = lastAppUplinkMsFromDevice(d);
  if (appMs != null && !isLastDbIngestStaleForDisplay(appMs, Date.now(), APP_UPLINK_STALE_MS)) {
    return false;
  }
  return isJoinOnlyDeviceRow(d);
}

/**
 * En línea si hay ingesta reciente en BD con telemetría de aplicación (o estado explícito online).
 * Los joins LoRaWAN solos no cuentan como en línea (ToolBox puede seguir en De-Activate).
 */
export function isDeviceVisuallyOnline(device) {
  if (isDeviceJoinPendingOnly(device)) return false;
  const d = applyStaleOfflineConnectStatus(device);
  const ms = lastSeenMsFromDevice(d);
  if (ms == null) return false;
  if (isLastDbIngestStaleForDisplay(ms)) return false;

  const appMs = lastAppUplinkMsFromDevice(d);
  if (appMs != null && !isLastDbIngestStaleForDisplay(appMs, Date.now(), APP_UPLINK_STALE_MS)) {
    return true;
  }

  const raw = d.connectStatus ?? d.status;
  const s = raw == null ? '' : String(raw).trim();
  const u = s.toUpperCase();

  if (!u) return true;

  if (u === 'OFFLINE' || u === 'DISCONNECTED' || u === 'FALSE' || u === '0' || u.includes('SIN TELEMET')) {
    return false;
  }

  if (u === 'JOIN_PENDING' || u === 'JOIN PENDING') return false;

  if (u === 'JOINED' || u === 'CONNECTED' || u === 'ONLINE' || u === 'TRUE' || u === '1') {
    return true;
  }

  return true;
}
