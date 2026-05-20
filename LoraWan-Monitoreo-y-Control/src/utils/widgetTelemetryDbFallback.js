import { expandNestedGatewayTelemetry } from './gatewayPayload';

const HISTORY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_ROW_LIMIT = 500;

function normalizeTelemetryRows(rows) {
  if (Array.isArray(rows)) return rows;
  if (rows && Array.isArray(rows.data)) return rows.data;
  if (rows && Array.isArray(rows.records)) return rows.records;
  return [];
}

function rowProps(row) {
  let rawProps = row.properties != null ? row.properties : row;
  if (typeof rawProps === 'string') {
    try {
      const p = JSON.parse(rawProps);
      rawProps = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch {
      rawProps = {};
    }
  }
  if (!rawProps || typeof rawProps !== 'object' || Array.isArray(rawProps)) return {};
  return expandNestedGatewayTelemetry(rawProps);
}

function rowTsMs(row) {
  const raw = row.timestamp ?? row.ts ?? row.time;
  if (raw == null) return NaN;
  const n = typeof raw === 'number' ? raw : new Date(raw).getTime();
  if (!Number.isFinite(n)) return NaN;
  return n > 0 && n < 1e11 ? Math.round(n * 1000) : n;
}

/**
 * Último valor por campo desde historial SQLite (un solo query sin propKey).
 * @param {string} deviceId
 * @param {{ fieldKey: string, cfg?: Record<string, unknown> | null, cacheKey: string }[]} entries
 * @param {(deviceId: string, propKey: string | null, startMs: number, endMs: number, limit?: number) => Promise<unknown>} queryTelemetry
 * @param {(props: Record<string, unknown>, fieldKey: string, cfg?: Record<string, unknown> | null) => unknown} resolveScalar misma lógica que `resolveTextWidgetRawScalar`
 * @returns {Promise<Record<string, { raw: unknown, ts: number }>>}
 */
export async function resolveLastScalarsFromTelemetryHistory(deviceId, entries, queryTelemetry, resolveScalar) {
  const out = {};
  if (!deviceId || !entries?.length) return out;
  const now = Date.now();
  let rows = [];
  try {
    rows = normalizeTelemetryRows(
      await queryTelemetry(deviceId, null, now - HISTORY_LOOKBACK_MS, now, HISTORY_ROW_LIMIT)
    );
  } catch {
    return out;
  }
  const parsed = rows
    .map((row) => ({ ts: rowTsMs(row), props: rowProps(row) }))
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => b.ts - a.ts);

  for (const { fieldKey, cfg, cacheKey } of entries) {
    const fk = fieldKey != null ? String(fieldKey).trim() : '';
    if (!fk || fk.startsWith('__bsd_')) continue;
    for (const { ts, props } of parsed) {
      const raw = resolveScalar(props, fk, cfg);
      if (raw === undefined || raw === null) continue;
      if (typeof raw === 'string' && !raw.trim()) continue;
      out[cacheKey] = { raw, ts };
      break;
    }
  }
  return out;
}

/**
 * Fusiona capa de historial solo si en vivo no hay valor para ese campo.
 * @param {Record<string, unknown>} base
 * @param {string | null | undefined} deviceId
 * @param {string} fieldKey
 * @param {Record<string, unknown> | null | undefined} cfg
 * @param {Record<string, { raw: unknown, ts: number }>} dbCache
 * @param {(props: Record<string, unknown>, fieldKey: string, cfg?: Record<string, unknown> | null) => unknown} resolveScalar
 */
export function enrichTelemetryWithDbFallback(base, deviceId, fieldKey, cfg, dbCache, resolveScalar) {
  const fk = fieldKey != null ? String(fieldKey).trim() : '';
  if (!base || typeof base !== 'object' || Array.isArray(base) || !fk || fk.startsWith('__bsd_')) {
    return base;
  }
  if (resolveScalar(base, fk, cfg) !== undefined) return base;
  const devId = deviceId != null ? String(deviceId).trim() : '';
  if (!devId) return base;
  const entry = dbCache[`${devId}|${fk}`];
  if (!entry || entry.raw === undefined || entry.raw === null) return base;
  const layer = { [fk]: entry.raw };
  if (Number.isFinite(entry.ts)) layer.lastUpdateTime = entry.ts;
  return { ...base, ...layer };
}
