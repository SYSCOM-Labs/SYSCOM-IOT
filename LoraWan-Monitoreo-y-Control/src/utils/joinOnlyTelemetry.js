/**
 * Última fila solo join LNS (sin payload de aplicación decodificable).
 * Alineado con server.js `joinOnlyTelemetryHint` / telemetry-persist `isJoinOnlyProperties`.
 */
export function isJoinOnlyTelemetryProperties(props) {
  if (!props || typeof props !== 'object') return false;
  const ev = props.lorawan_event != null ? String(props.lorawan_event).trim() : '';
  if (!ev || !/join/i.test(ev)) return false;
  const hex = props.payload_hex != null ? String(props.payload_hex).trim() : '';
  return hex.length === 0;
}

/** @param {object} device Fila de listado o merge con properties aplanadas */
export function isJoinOnlyDeviceRow(device) {
  if (!device) return false;
  if (device.ingestStatus && String(device.ingestStatus).includes('Solo join')) return true;
  return isJoinOnlyTelemetryProperties(device);
}
