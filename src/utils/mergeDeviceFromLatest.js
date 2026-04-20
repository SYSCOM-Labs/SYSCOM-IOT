import { applyStaleOfflineConnectStatus } from './deviceConnectionStatus';

/**
 * Fusiona `latest.properties` (p. ej. GET /api/devices/latest) sobre la fila de dispositivo del listado,
 * sin limitarse a conectividad / batería.
 * @param {object} dev
 * @param {{ properties?: object, timestamp?: number }|null|undefined} localUpdate
 */
export function mergeDeviceFromLatestRow(dev, localUpdate) {
  if (!localUpdate?.properties || typeof localUpdate.properties !== 'object') {
    return applyStaleOfflineConnectStatus(dev);
  }
  const props = localUpdate.properties;
  const next = { ...dev };
  for (const k of Object.keys(props)) {
    if (props[k] !== undefined) next[k] = props[k];
  }
  const ts = localUpdate.timestamp;
  if (ts != null && Number(ts) > Number(dev.lastUpdateTime || 0)) {
    next.lastUpdateTime = ts;
  }
  return applyStaleOfflineConnectStatus(next);
}
