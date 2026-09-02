/**
 * Contadores acumulativos (p. ej. Milesight VS133 `total_in` / `total_out`).
 * En Hora/Día/Semana/Mes el gráfico lineal debe mostrar el incremento del periodo, no el total de por vida.
 */
export function isLikelyCumulativeCounterFieldKey(fk) {
  const k = String(fk || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!k) return false;
  if (
    k.includes('period_') ||
    k.startsWith('period') ||
    k.includes('occupancy') ||
    k.includes('ocupacion') ||
    k.includes('ocupación')
  ) {
    return false;
  }
  if (k === 'total_in' || k === 'total_out' || k === 'totalin' || k === 'totalout') return true;
  if (k.endsWith('_total_in') || k.endsWith('_total_out')) return true;
  if (/(^|_)(total_in|total_out)(_|$)/.test(k)) return true;
  if (k === 'people_in' || k === 'people_out' || k === 'person_in' || k === 'person_out') return true;
  if (k.includes('people_counter') || k.includes('person_counter')) return true;
  if (k.includes('acumulad')) return true;
  return false;
}

/** Serie del gráfico lineal: incremento en la ventana (Hora/Día/Semana/Mes), no el acumulado crudo. */
export function streamSeriesUsesPeriodIncrement(meta) {
  if (!meta) return false;
  if (meta.valueMode === 'delta') return true;
  return isLikelyCumulativeCounterFieldKey(meta.fieldKey);
}

/**
 * Convierte un acumulado en incremento desde el primer punto (00:00 → ahora ≈ entradas del día).
 * Si el contador se reinicia, suma solo tramos positivos.
 * @param {{ ts: number, val: number }[]} points
 * @returns {{ ts: number, val: number }[]}
 */
export function applyPeriodIncrementPoints(points) {
  if (!Array.isArray(points) || !points.length) return [];
  const sorted = points
    .filter((p) => p && Number.isFinite(p.ts) && Number.isFinite(p.val))
    .sort((a, b) => a.ts - b.ts);
  if (!sorted.length) return [];
  const out = [];
  let running = 0;
  let prev = sorted[0].val;
  for (const p of sorted) {
    const d = p.val - prev;
    if (d >= 0) running += d;
    else running += Math.max(0, p.val);
    prev = p.val;
    out.push({ ts: p.ts, val: running });
  }
  return out;
}
