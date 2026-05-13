import { parseTelemetryScalar, parseTelemetryBoolish } from './gatewayPayload';

const GPIO_IO_RE = /^gpio_(input|output)_\d+$/i;
const DIGITAL_IO_RE = /^digital_(input|output)_\d+$/i;

/**
 * Etiqueta legible para telemetría conocida (Milesight / patrones habituales).
 * Devuelve null para seguir con el formateo numérico o crudo del caller.
 *
 * @param {string | null | undefined} model Reservado para tablas por modelo; hoy las reglas son por nombre de campo.
 * @param {string} fieldKey
 * @param {unknown} raw
 * @param {Record<string, { trueText?: string, falseText?: string }> | null | undefined} [hintMap] Pistas desde plantilla («Ajustar»): p. ej. Input 1 On / Off.
 * @returns {string | null}
 */
export function tryTelemetryDisplayLabel(model, fieldKey, raw, hintMap) {
  void model;
  const fk = String(fieldKey || '').trim().toLowerCase();

  const hints = hintMap && typeof hintMap === 'object' && !Array.isArray(hintMap) ? hintMap : null;
  const fieldHint = hints && hints[fk] && typeof hints[fk] === 'object' ? hints[fk] : null;
  if (fieldHint && (fieldHint.trueText || fieldHint.falseText)) {
    const b = parseTelemetryBoolish(raw);
    if (b === true && fieldHint.trueText) return String(fieldHint.trueText);
    if (b === false && fieldHint.falseText) return String(fieldHint.falseText);
  }

  if (fk === 'press' || fk === 'button_event_status') {
    const code = parseTelemetryScalar(raw);
    if (code != null && Number.isFinite(Number(code))) {
      const r = Math.round(Number(code));
      if (r === 1) return 'Short';
      if (r === 2) return 'Long';
      if (r === 3) return 'Double';
    }
    return null;
  }

  if (GPIO_IO_RE.test(fk) || DIGITAL_IO_RE.test(fk)) {
    const b = parseTelemetryBoolish(raw);
    if (b === true) return 'Encendido';
    if (b === false) return 'Apagado';
    return null;
  }

  if (fk.endsWith('_alarm') && typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'read error' || t.includes('read error')) return 'Error de lectura';
  }

  return null;
}

/**
 * Nombre del tramo de escala (`gauge.ranges[].name`) donde cae el valor, si hay rangos con nombre.
 *
 * @param {number} value
 * @param {Array<{ value?: number; name?: string }> | null | undefined} ranges
 * @param {number | string | null | undefined} scaleMin
 * @param {number | string | null | undefined} scaleMax
 * @returns {string | null}
 */
export function gaugeSegmentLabel(value, ranges, scaleMin, scaleMax) {
  const min0 = Number(scaleMin);
  const max0 = Number(scaleMax);
  const minOk = Number.isFinite(min0) ? min0 : 0;
  const maxOk = Number.isFinite(max0) && max0 > minOk ? max0 : minOk + 1;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const list = Array.isArray(ranges) ? [...ranges].sort((a, b) => Number(a.value) - Number(b.value)) : [];
  if (!list.length) return null;
  const clamped = Math.min(maxOk, Math.max(minOk, v));
  let prev = minOk;
  for (let i = 0; i < list.length; i++) {
    const end = Math.min(maxOk, Number(list[i].value));
    if (!Number.isFinite(end)) continue;
    if (clamped <= end && clamped >= prev) {
      const name = list[i].name != null ? String(list[i].name).trim() : '';
      return name || null;
    }
    prev = end;
  }
  const last = list[list.length - 1];
  const lastName = last?.name != null ? String(last.name).trim() : '';
  return lastName || null;
}

/**
 * Texto para tooltips de gráficos (barras / línea): etiquetas de telemetría conocidas,
 * nombre de tramo del gauge, o valor numérico con unidad.
 *
 * @param {number | null | undefined} value
 * @param {string} fieldKey
 * @param {string | null | undefined} model
 * @param {Record<string, unknown> | null | undefined} hintMap
 * @param {{ unit?: string; decimals?: number; ranges?: unknown[]; scaleMin?: number | string | null; scaleMax?: number | string | null }} [options]
 */
export function formatTelemetryChartTooltipValue(value, fieldKey, model, hintMap, options) {
  const {
    unit = '',
    decimals,
    ranges = null,
    scaleMin = null,
    scaleMax = null,
  } = options || {};
  if (value == null || !Number.isFinite(Number(value))) return 'sin dato';
  const v = Number(value);
  const mapped = tryTelemetryDisplayLabel(model, fieldKey, v, hintMap);
  if (mapped != null) return mapped;
  const seg = gaugeSegmentLabel(v, ranges, scaleMin, scaleMax);
  if (seg) return seg;
  const dec =
    decimals != null && decimals !== '' && Number.isFinite(Number(decimals))
      ? Math.min(6, Math.max(0, Math.round(Number(decimals))))
      : Math.abs(v) >= 100
        ? 1
        : Math.abs(v) >= 10
          ? 2
          : Math.abs(v) >= 1
            ? 2
            : 3;
  const u = String(unit || '').trim();
  return `${v.toFixed(dec)}${u ? ` ${u}` : ''}`;
}

/**
 * Valor de fila en resúmenes (modal dispositivo, etc.): mapeo conocido o `formatScalar` del caller.
 */
export function formatTelemetryForSummaryRow(model, fieldKey, raw, formatScalar, hintMap) {
  const mapped = tryTelemetryDisplayLabel(model, fieldKey, raw, hintMap);
  if (mapped != null) return mapped;
  return formatScalar(raw);
}
