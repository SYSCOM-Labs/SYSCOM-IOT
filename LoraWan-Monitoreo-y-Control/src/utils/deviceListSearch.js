/** Coincidencia por modelo, DevEUI/sn/deviceId, nombre, etiqueta (insensible a mayúsculas; hex sin separadores). */
export function deviceMatchesListSearch(device, query) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return true;
  const parts = [
    device.deviceId,
    device.sn,
    device.name,
    device.model,
    device.productModel,
    device.deviceType,
    device.devEUI,
    device.devEui,
    device.tag,
  ]
    .filter((x) => x != null && String(x).trim() !== '')
    .map((x) => String(x).toLowerCase());
  const blob = parts.join(' | ');
  if (blob.includes(raw)) return true;
  const needleHex = raw.replace(/[^0-9a-f]/g, '');
  if (needleHex.length < 3) return false;
  const blobHex = parts.join('').replace(/[^0-9a-f]/g, '');
  return blobHex.includes(needleHex);
}

export function deviceDevEuiDisplay(device) {
  if (!device) return '';
  return String(device.sn || device.devEUI || device.devEui || device.deviceId || '').trim();
}
