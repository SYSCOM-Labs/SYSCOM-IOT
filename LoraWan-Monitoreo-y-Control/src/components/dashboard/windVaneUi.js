/**
 * Widget Veleta: dirección del viento (p. ej. Milesight WTS506 → `wind_direction` en grados).
 */
import { parseTelemetryScalar } from '../../utils/gatewayPayload';
import { transformWidgetNumeric } from '../../utils/widgetFormula';
import {
  pickFirstTelemetryScalar,
  resolveTelemetryDisplaySource,
  resolveTextWidgetRawScalar,
} from './widgetConfigUtils';

export const WIND_DIRECTION_FIELD_KEYS = [
  'wind_direction',
  'windDirection',
  'wind_dir',
  'windDir',
  'direction',
];

/** Etiquetas en español (O = oeste), como brújula de la UI. */
export const WIND_CARDINAL_LABELS_ES = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

/**
 * @param {unknown} raw
 * @returns {number | null} grados 0–360 (meteorológico: de donde sopla el viento)
 */
export function parseWindDirectionDegrees(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return normalizeWindDegrees(raw);
  }
  if (typeof raw === 'string') {
    const t = raw.trim().replace(',', '.');
    if (!t) return null;
    const n = parseFloat(t);
    if (Number.isFinite(n)) return normalizeWindDegrees(n);
    const upper = t.toUpperCase();
    const idx = WIND_CARDINAL_LABELS_ES.indexOf(upper);
    if (idx >= 0) return idx * 45;
    const map = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SO: 225, SW: 225, W: 270, O: 270, NW: 315, NO: 315 };
    if (map[upper] != null) return map[upper];
  }
  return null;
}

/** @param {number} deg */
export function normalizeWindDegrees(deg) {
  if (!Number.isFinite(deg)) return null;
  return ((deg % 360) + 360) % 360;
}

/** @param {number | null} deg */
export function degreesToCardinalEs(deg) {
  if (deg == null || !Number.isFinite(deg)) return '—';
  const d = normalizeWindDegrees(deg);
  if (d == null) return '—';
  const idx = Math.round(d / 45) % 8;
  return WIND_CARDINAL_LABELS_ES[idx];
}

/**
 * @param {Record<string, unknown> | null | undefined} telemetryLiveProps
 * @param {string} fkStr
 * @param {Record<string, unknown> | null | undefined} cfg
 */
export function resolveWindDirectionScalar(telemetryLiveProps, fkStr, cfg) {
  const primary = fkStr != null ? String(fkStr).trim() : '';
  if (primary) {
    const v = resolveTextWidgetRawScalar(telemetryLiveProps, primary, cfg);
    if (v !== undefined && v !== null && !(typeof v === 'string' && !String(v).trim())) {
      return v;
    }
    const alt = resolveTelemetryDisplaySource(telemetryLiveProps, primary);
    if (alt !== undefined && alt !== null) return alt;
  }
  const fallback = pickFirstTelemetryScalar(telemetryLiveProps, WIND_DIRECTION_FIELD_KEYS);
  if (fallback !== undefined) return fallback;
  return undefined;
}

function telemetryFieldKeyForFormula(cfg, fkStr) {
  const fe = Boolean(cfg?.data?.formulaEnabled);
  const expr = cfg?.data?.formulaExpression != null ? String(cfg.data.formulaExpression).trim() : '';
  const src = cfg?.data?.formulaSourceKey != null ? String(cfg.data.formulaSourceKey).trim() : '';
  if (fe && expr && src) return src;
  return fkStr;
}

/**
 * @param {(wid: string) => string} dk
 * @param {Record<string, object>} widgetConfigs
 * @param {string} slotWid
 * @param {Record<string, unknown> | null | undefined} telemetryLiveProps
 */
export function computeVeletaWidgetUiForSlot(dk, widgetConfigs, slotWid, telemetryLiveProps) {
  const key = dk(slotWid);
  const cfg = widgetConfigs[key];
  const fkRaw = cfg?.data?.fieldKey;
  const fkStr = fkRaw != null ? String(fkRaw).trim() : '';
  const readFk = telemetryFieldKeyForFormula(cfg, fkStr);
  const rawScalar =
    telemetryLiveProps && typeof telemetryLiveProps === 'object' && !Array.isArray(telemetryLiveProps)
      ? resolveWindDirectionScalar(telemetryLiveProps, readFk, cfg)
      : undefined;
  const useLive = Boolean(readFk) && !readFk.startsWith('__bsd_') && rawScalar !== undefined;
  const lastAtLine = formatLastTelemetryUpdateLine(telemetryLiveProps?.lastUpdateTime);

  if (!useLive) {
    const hint =
      !fkStr || fkStr.startsWith('__bsd_')
        ? 'Configura el campo (p. ej. wind_direction)'
        : 'Sin dato en vivo';
    return { degrees: null, displayDeg: '—', cardinal: '—', hint, lastAtLine };
  }

  let raw = rawScalar;
  const formulaActive =
    Boolean(cfg?.data?.formulaEnabled) && String(cfg?.data?.formulaExpression ?? '').trim() !== '';
  if (formulaActive) {
    const n = parseTelemetryScalar(raw);
    if (n !== null && Number.isFinite(n)) {
      const nd = transformWidgetNumeric(cfg, n);
      if (nd != null && Number.isFinite(nd)) raw = nd;
    }
  }

  const decRaw = cfg?.data?.decimals;
  const dec =
    decRaw != null && decRaw !== '' && Number.isFinite(Number(decRaw))
      ? Math.min(1, Math.max(0, Number(decRaw)))
      : 1;

  const degrees = parseWindDirectionDegrees(raw);
  if (degrees == null) {
    return {
      degrees: null,
      displayDeg: String(raw).trim() || '—',
      cardinal: '—',
      hint: fkStr || 'wind_direction',
      lastAtLine,
    };
  }

  const cardinal = degreesToCardinalEs(degrees);
  const displayDeg = `${degrees.toFixed(dec)}°`;
  return {
    degrees,
    displayDeg,
    cardinal,
    hint: `${displayDeg} · ${cardinal}`,
    lastAtLine,
  };
}

/** @param {number | string | null | undefined} ts */
export function formatLastTelemetryUpdateLine(ts) {
  if (ts == null) return '';
  const n = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!Number.isFinite(n)) return '';
  return `Última actualización: ${new Date(n).toLocaleString()}`;
}
