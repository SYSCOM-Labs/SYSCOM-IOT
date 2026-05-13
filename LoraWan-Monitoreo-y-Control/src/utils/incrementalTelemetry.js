import { getTelemetryPropertyValue } from './telemetryPropertyPath';

/** @param {unknown} v */
export function coerceCumulativeNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  if (s === '') return null;
  if (!/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Último valor acumulativo numérico en una lista de filas de telemetría (ts ascendente).
 * @param {Array<{ ts?: number, timestamp?: number, properties?: object }>} rows
 * @param {string} propKey
 * @returns {number | null}
 */
export function lastCumulativeInRows(rows, propKey) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let last = null;
  for (const row of rows) {
    const rawTs = Number(row.ts ?? row.timestamp);
    if (!Number.isFinite(rawTs)) continue;
    const v = coerceCumulativeNumber(getTelemetryPropertyValue(row.properties || {}, propKey));
    if (v !== null) last = v;
  }
  return last;
}

/**
 * Serie incremental muestra a muestra dentro del periodo: Δᵢ = cumᵢ − cumᵢ₋₁;
 * la primera muestra usa como referencia el último acumulado antes de `windowStartMs` si existe.
 *
 * @param {Array<{ rawTs: number, properties: object }>} sortedInWindow ts ascendente
 * @param {string} propKey
 * @param {number | null} baselineBeforeWindow último acumulado estrictamente antes del periodo (o null)
 * @returns {{ rawTs: number; timestamp: string; value: unknown; valueNum: number | null; cumulativeRaw: number | null }[]}
 */
export function perSampleIncrementalSeries(sortedInWindow, propKey, baselineBeforeWindow) {
  const out = [];
  let prevCum = baselineBeforeWindow;
  for (const row of sortedInWindow) {
    const rawTs = row.rawTs;
    const cum = coerceCumulativeNumber(getTelemetryPropertyValue(row.properties || {}, propKey));
    const timestamp = Number.isFinite(rawTs) ? new Date(rawTs).toLocaleString() : '';
    if (cum === null) {
      out.push({
        rawTs,
        timestamp,
        value: undefined,
        valueNum: null,
        cumulativeRaw: null,
      });
      continue;
    }
    let inc;
    if (prevCum === null || prevCum === undefined) {
      inc = cum;
    } else {
      inc = cum - prevCum;
    }
    prevCum = cum;
    out.push({
      rawTs,
      timestamp,
      value: inc,
      valueNum: inc,
      cumulativeRaw: cum,
    });
  }
  return out;
}

/**
 * Totales por día local (suma de incrementales muestra a muestra dentro de cada día).
 * Requiere filas en ventana ordenadas por ts y baseline antes del primer ts del día de trabajo.
 *
 * @param {Array<{ rawTs: number; properties: object }>} sortedInWindow
 * @param {string} propKey
 * @param {number | null} baselineBeforeWindow
 * @returns {{ dayKey: string; dayLabel: string; rawTsEnd: number; totalIncremental: number }[]}
 */
export function dailyIncrementalTotals(sortedInWindow, propKey, baselineBeforeWindow) {
  /** @type {Map<string, { sum: number; lastTs: number; label: string }>} */
  const map = new Map();
  let prevCum = baselineBeforeWindow;

  for (const sample of sortedInWindow) {
    const rawTs = sample.rawTs;
    if (!Number.isFinite(rawTs)) continue;
    const cum = coerceCumulativeNumber(getTelemetryPropertyValue(sample.properties || {}, propKey));
    if (cum === null) continue;
    let inc;
    if (prevCum === null || prevCum === undefined) inc = cum;
    else inc = cum - prevCum;
    prevCum = cum;

    const d = new Date(rawTs);
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const agg = map.get(dayKey) || { sum: 0, lastTs: rawTs, label };
    agg.sum += inc;
    agg.lastTs = rawTs;
    agg.label = label;
    map.set(dayKey, agg);
  }

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({
      dayKey: key,
      dayLabel: v.label,
      rawTsEnd: v.lastTs,
      totalIncremental: Math.round(v.sum * 1e9) / 1e9,
    }));
}

/**
 * Total incremental en el intervalo = último acumulado en ventana − baseline antes del periodo.
 * Si no hay baseline pero sí muestras, usa el primer acumulado de la ventana como consumo total (primer día de datos).
 *
 * @param {number | null} lastInWindow
 * @param {number | null} baselineBefore
 */
export function periodIncrementalTotal(lastInWindow, baselineBefore) {
  if (lastInWindow === null || lastInWindow === undefined) return null;
  if (baselineBefore === null || baselineBefore === undefined) return lastInWindow;
  return lastInWindow - baselineBefore;
}
