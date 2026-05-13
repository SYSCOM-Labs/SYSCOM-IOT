/**
 * Extrae puntos { lat, lng, ts } del historial de telemetría para el widget «Mapa de rastreo».
 * Compatible con decodificadores tipo Milesight AT101: `latitude`/`longitude` en raíz y
 * arrays `history` con { timestamp, latitude, longitude } (timestamp en segundos Unix típico).
 */

/** @param {unknown} v */
function toNum(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} tsRaw */
export function telemetryTimestampToMs(tsRaw) {
  if (tsRaw == null) return null;
  if (typeof tsRaw === 'number' && Number.isFinite(tsRaw)) {
    return tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
  }
  if (typeof tsRaw === 'string' && /^\d+$/.test(tsRaw.trim())) {
    const n = Number(tsRaw);
    return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null;
  }
  const d = new Date(tsRaw);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {Record<string, unknown>} props
 * @param {{ latitudeKey?: string; longitudeKey?: string; historyKey?: string }} keys
 */
function pushFromRoot(props, keys, out) {
  const latK = keys.latitudeKey || 'latitude';
  const lngK = keys.longitudeKey || 'longitude';
  const lat = toNum(props[latK] ?? props.lat);
  const lng = toNum(props[lngK] ?? props.lng ?? props.lon);
  if (lat == null || lng == null) return;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
  const ts =
    telemetryTimestampToMs(props.ts ?? props.timestamp ?? props.time) ??
    telemetryTimestampToMs(props.receivedAt);
  out.push({ lat, lng, ts: ts ?? 0 });
}

/**
 * @param {Record<string, unknown>} props
 * @param {{ historyKey?: string }} keys
 */
function pushFromHistoryArrays(props, keys, out) {
  const hk = keys.historyKey || 'history';
  const arr = props[hk];
  if (!Array.isArray(arr)) return;
  for (const h of arr) {
    if (!h || typeof h !== 'object') continue;
    const lat = toNum(h.latitude ?? h.lat);
    const lng = toNum(h.longitude ?? h.lng ?? h.lon);
    if (lat == null || lng == null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const ts = telemetryTimestampToMs(h.timestamp ?? h.ts ?? h.time) ?? 0;
    out.push({ lat, lng, ts });
  }
}

/** @param {unknown} rows */
export function normalizeTelemetryRows(rows) {
  if (Array.isArray(rows)) return rows;
  if (rows && typeof rows === 'object' && Array.isArray(rows.data)) return rows.data;
  if (rows && typeof rows === 'object' && Array.isArray(rows.records)) return rows.records;
  return [];
}

/**
 * Objeto fuente para lat/lon/history: payload completo o subcampo (objeto o JSON string).
 * @param {Record<string, unknown>} fullProps propiedades de la fila de telemetría
 * @param {string} [sourceKey] vacío = raíz; si no, `fullProps[sourceKey]` como objeto anidado
 * @param {unknown} [rowTs] marca temporal de la fila (uplink)
 */
export function resolveTrackingSourceObject(fullProps, sourceKey, rowTs) {
  if (!fullProps || typeof fullProps !== 'object') return null;
  const sk = String(sourceKey || '').trim();
  if (!sk) {
    return { ...fullProps, ts: rowTs ?? fullProps.ts, timestamp: rowTs ?? fullProps.timestamp };
  }
  const raw = fullProps[sk];
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        return { ...o, ts: rowTs ?? o.ts, timestamp: rowTs ?? o.timestamp };
      }
    } catch {
      return null;
    }
    return null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...raw, ts: rowTs ?? raw.ts, timestamp: rowTs ?? raw.timestamp };
  }
  return null;
}

/**
 * @param {unknown[]} rows filas de queryTelemetry / fetchDeviceHistory (properties + ts)
 * @param {{
 *   trackingTelemetryField?: string;
 *   latitudeKey?: string;
 *   longitudeKey?: string;
 *   historyKey?: string;
 * }} [keys]
 * @returns {{ lat: number; lng: number; ts: number }[]}
 */
export function collectTrackingPointsFromTelemetryRows(rows, keys = {}) {
  const list = normalizeTelemetryRows(rows);
  if (!list.length) return [];
  const srcKey = String(keys.trackingTelemetryField || '').trim();
  /** @type {{ lat: number; lng: number; ts: number }[]} */
  const raw = [];
  for (const row of list) {
    const fullProps =
      row && typeof row === 'object' && row.properties && typeof row.properties === 'object' ? row.properties : row;
    if (!fullProps || typeof fullProps !== 'object') continue;
    const rowTime = row && typeof row === 'object' ? row.ts ?? row.timestamp : undefined;
    const src = resolveTrackingSourceObject(fullProps, srcKey, rowTime);
    if (!src || typeof src !== 'object') continue;
    const merged = { ...src, ts: row.ts ?? src.ts, timestamp: row.timestamp ?? src.timestamp };
    pushFromHistoryArrays(merged, keys, raw);
    pushFromRoot(merged, keys, raw);
  }
  raw.sort((a, b) => a.ts - b.ts);
  /** Dedupe coordenadas idénticas consecutivas */
  const deduped = [];
  for (const p of raw) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.lat === p.lat && prev.lng === p.lng) continue;
    deduped.push(p);
  }
  return deduped;
}

export const TRACKING_TIME_RANGE_MS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/** @param {'day' | 'week' | 'month' | string} range */
export function trackingWindowEndMs(range) {
  const k = range === 'week' || range === 'month' ? range : 'day';
  return TRACKING_TIME_RANGE_MS[k] ?? TRACKING_TIME_RANGE_MS.day;
}
