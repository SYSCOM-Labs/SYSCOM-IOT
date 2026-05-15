import { osmEmbedLayerParam } from './mapWidgetLayers';

/** @param {unknown} v */
export function toFloatCoord(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(String(v).replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** @returns {{ lat: number; lng: number } | null} */
export function pickMapCoordinates(props) {
  if (!props || typeof props !== 'object') return null;
  const latKeys = ['latitude', 'lat', 'gpsLat', 'gps_lat', 'Latitude', 'LAT', 'coordLat'];
  const lngKeys = ['longitude', 'lng', 'lon', 'long', 'gpsLng', 'gps_lng', 'Longitude', 'LON', 'coordLng'];
  let lat = null;
  let lng = null;
  for (const k of latKeys) {
    if (Object.prototype.hasOwnProperty.call(props, k)) {
      lat = toFloatCoord(props[k]);
      if (lat != null) break;
    }
  }
  for (const k of lngKeys) {
    if (Object.prototype.hasOwnProperty.call(props, k)) {
      lng = toFloatCoord(props[k]);
      if (lng != null) break;
    }
  }
  if (lat == null || lng == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Coordenadas fijas en config del widget o telemetría en vivo. */
export function resolveMapCoords(liveProps, mapCfg) {
  const lat = toFloatCoord(mapCfg?.data?.savedLatitude) ?? toFloatCoord(mapCfg?.data?.savedLat);
  const lng = toFloatCoord(mapCfg?.data?.savedLongitude) ?? toFloatCoord(mapCfg?.data?.savedLng);
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
  return pickMapCoordinates(liveProps);
}

export function openStreetMapEmbedUrl(lat, lng, layerId) {
  const pad = 0.04;
  const minLon = lng - pad;
  const minLat = lat - pad;
  const maxLon = lng + pad;
  const maxLat = lat + pad;
  const layer = osmEmbedLayerParam(layerId);
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(`${minLon},${minLat},${maxLon},${maxLat}`)}&layer=${encodeURIComponent(layer)}&marker=${encodeURIComponent(`${lat},${lng}`)}`;
}
