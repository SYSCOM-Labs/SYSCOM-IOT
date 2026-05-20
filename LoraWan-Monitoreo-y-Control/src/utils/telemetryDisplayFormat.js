import { parseTelemetryScalar, parseTelemetryBoolish } from './gatewayPayload';

const GPIO_IO_RE = /^gpio_(input|output)_\d+$/i;
const DIGITAL_IO_RE = /^digital_(input|output)_\d+$/i;

/** Catálogo global (Milesight / SYSCOM): valores crudos → etiqueta en widgets. */
const GLOBAL_VALUE_LABELS_BY_FIELD = {
  press: {
    1: 'Short',
    2: 'Long',
    3: 'Double',
    short: 'Short',
    long: 'Long',
    double: 'Double',
    'short press': 'Short press',
    'long press': 'Long press',
    'double press': 'Double press',
  },
  button_event_status: {
    1: 'Short',
    2: 'Long',
    3: 'Double',
    short: 'Short',
    long: 'Long',
    double: 'Double',
    'short press': 'Short press',
    'long press': 'Long press',
    'double press': 'Double press',
  },
  temperature_control_mode: {
    auto: 'Auto',
    heat: 'Heat',
    cool: 'Cool',
    emergency_heat: 'Emergency heat',
    'emergency heat': 'Emergency heat',
  },
  temperature_control_status: {
    on: 'On',
    off: 'Off',
    stage: 'Stage',
    'stage-2': 'Stage 2',
    'stage 2': 'Stage 2',
  },
  fan_mode: {
    auto: 'Auto',
    on: 'On',
    off: 'Off',
    circulate: 'Circulate',
  },
  fan_status: {
    on: 'On',
    off: 'Off',
  },
};

/**
 * @param {string} fieldKey
 * @returns {string}
 */
export function normalizeDisplayFieldKey(fieldKey) {
  const raw = String(fieldKey || '').trim().toLowerCase();
  if (!raw) return '';
  const dotted = raw.replace(/\./g, '_');
  if (dotted === 'button_event_status' || dotted === 'button_event' || dotted === 'press') return dotted;
  if (dotted.includes('button_event') && dotted.includes('status')) return 'button_event_status';
  return dotted;
}

export function isButtonTelemetryFieldKey(fieldKey) {
  const n = normalizeDisplayFieldKey(fieldKey);
  return n === 'press' || n === 'button_event_status' || n === 'button_event';
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
export function mapButtonPressDisplayLabel(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!t) return null;
    if (t === 'short press' || t === 'short') return 'Short';
    if (t === 'long press' || t === 'long') return 'Long';
    if (t === 'double press' || t === 'double') return 'Double';
  }
  const code = parseTelemetryScalar(raw);
  if (code != null && Number.isFinite(Number(code))) {
    const r = Math.round(Number(code));
    if (r === 1) return 'Short';
    if (r === 2) return 'Long';
    if (r === 3) return 'Double';
  }
  return null;
}

/**
 * @param {Record<string, { trueText?: string, falseText?: string, valueLabels?: Record<string, string> }> | null | undefined} hints
 * @param {string} fieldKey
 * @param {unknown} raw
 */
function lookupTemplateValueLabel(hints, fieldKey, raw) {
  if (!hints || typeof hints !== 'object') return null;
  const keys = [
    String(fieldKey || '').trim().toLowerCase(),
    normalizeDisplayFieldKey(fieldKey),
    String(fieldKey || '')
      .trim()
      .toLowerCase()
      .replace(/\./g, '_'),
  ];
  const rawKeys = [];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    rawKeys.push(String(raw), String(Math.round(raw)));
  } else if (typeof raw === 'boolean') {
    rawKeys.push(raw ? '1' : '0', raw ? 'true' : 'false');
  } else {
    const s = String(raw).trim();
    if (s) {
      rawKeys.push(s, s.toLowerCase());
    }
  }
  for (const fk of keys) {
    if (!fk) continue;
    const h = hints[fk];
    const map = h && typeof h === 'object' && h.valueLabels && typeof h.valueLabels === 'object' ? h.valueLabels : null;
    if (!map) continue;
    for (const rk of rawKeys) {
      if (Object.prototype.hasOwnProperty.call(map, rk)) {
        const lab = map[rk];
        if (lab != null && String(lab).trim()) return String(lab).trim();
      }
    }
  }
  return null;
}

function lookupGlobalCatalogLabel(fieldKey, raw) {
  const canon = normalizeDisplayFieldKey(fieldKey);
  const map = GLOBAL_VALUE_LABELS_BY_FIELD[canon];
  if (!map) return null;
  const keys = [];
  if (typeof raw === 'number' && Number.isFinite(raw)) keys.push(String(raw), String(Math.round(raw)));
  else if (typeof raw === 'boolean') keys.push(raw ? '1' : '0');
  else {
    const s = String(raw).trim();
    if (s) keys.push(s, s.toLowerCase());
  }
  for (const rk of keys) {
    if (Object.prototype.hasOwnProperty.call(map, rk)) return map[rk];
  }
  return null;
}

/**
 * Etiqueta legible para telemetría conocida (Milesight / patrones habituales).
 * Devuelve null para seguir con el formateo numérico o crudo del caller.
 *
 * @param {string | null | undefined} model Reservado para tablas por modelo; hoy las reglas son por nombre de campo.
 * @param {string} fieldKey
 * @param {unknown} raw
 * @param {Record<string, { trueText?: string, falseText?: string, valueLabels?: Record<string, string> }> | null | undefined} [hintMap] Plantilla vinculada («Ajustar»).
 * @returns {string | null}
 */
export function tryTelemetryDisplayLabel(model, fieldKey, raw, hintMap) {
  void model;
  const fk = String(fieldKey || '').trim().toLowerCase();

  const fromTpl = lookupTemplateValueLabel(hintMap, fieldKey, raw);
  if (fromTpl != null) return fromTpl;

  const fromCatalog = lookupGlobalCatalogLabel(fieldKey, raw);
  if (fromCatalog != null) return fromCatalog;

  const hints = hintMap && typeof hintMap === 'object' && !Array.isArray(hintMap) ? hintMap : null;
  const fieldHint = hints && hints[fk] && typeof hints[fk] === 'object' ? hints[fk] : null;
  if (fieldHint && (fieldHint.trueText || fieldHint.falseText)) {
    const b = parseTelemetryBoolish(raw);
    if (b === true && fieldHint.trueText) return String(fieldHint.trueText);
    if (b === false && fieldHint.falseText) return String(fieldHint.falseText);
  }

  if (isButtonTelemetryFieldKey(fieldKey)) {
    const mapped = mapButtonPressDisplayLabel(raw);
    if (mapped != null) return mapped;
  }

  if (fk === 'press' || fk === 'button_event_status') {
    const mapped = mapButtonPressDisplayLabel(raw);
    if (mapped != null) return mapped;
  }

  if (fk === 'switch_1' || fk === 'switch_2' || /^switch_\d+$/.test(fk)) {
    const b = parseTelemetryBoolish(raw);
    if (b === true) return 'On';
    if (b === false) return 'Off';
    if (typeof raw === 'string') {
      const t = raw.trim().toLowerCase();
      if (t === 'on') return 'On';
      if (t === 'off') return 'Off';
    }
    return null;
  }

  if (GPIO_IO_RE.test(fk) || DIGITAL_IO_RE.test(fk)) {
    const b = parseTelemetryBoolish(raw);
    if (b === true) return 'Encendido';
    if (b === false) return 'Apagado';
    return null;
  }

  if (/_enable$/.test(fk) || fk.endsWith('_status')) {
    const b = parseTelemetryBoolish(raw);
    if (b === true) return 'Enable';
    if (b === false) return 'Disable';
    if (typeof raw === 'string') {
      const t = raw.trim().toLowerCase();
      if (t === 'enable') return 'Enable';
      if (t === 'disable') return 'Disable';
    }
  }

  if (fk.endsWith('_alarm') && typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'read error' || t.includes('read error')) return 'Error de lectura';
    if (t === 'alarm_triggered' || t === 'alarm triggered') return 'Alarma activa';
    if (t === 'alarm_released' || t === 'alarm released') return 'Alarma liberada';
  }

  if (typeof raw === 'string' && raw.trim()) {
    const t = raw.trim().toLowerCase();
    if (t === 'enable') return 'Enable';
    if (t === 'disable') return 'Disable';
    if (t === 'yes') return 'Yes';
    if (t === 'no') return 'No';
  }

  return null;
}

/**
 * Texto listo para widgets (Texto, medidor, tarjetas): etiqueta procesada o número con unidad.
 *
 * @param {{
 *   model?: string | null,
 *   fieldKey?: string,
 *   raw?: unknown,
 *   hintMap?: Record<string, unknown> | null,
 *   decimals?: number,
 *   unit?: string,
 *   formulaActive?: boolean,
 * }} opts
 * @returns {{ display: string, usedProcessedLabel: boolean }}
 */
export function formatWidgetTelemetryDisplay(opts = {}) {
  const {
    model = null,
    fieldKey = '',
    raw,
    hintMap = null,
    decimals = 2,
    unit = '',
    formulaActive = false,
  } = opts;
  const fkStr = fieldKey != null ? String(fieldKey).trim() : '';
  const dec =
    decimals != null && decimals !== '' && Number.isFinite(Number(decimals))
      ? Math.min(20, Math.max(0, Number(decimals)))
      : 2;
  const u = String(unit || '').trim();

  if (raw === undefined || raw === null) {
    return { display: '—', usedProcessedLabel: false };
  }

  if (!formulaActive) {
    const friendly = tryTelemetryDisplayLabel(model, fkStr, raw, hintMap);
    if (friendly != null && String(friendly).trim()) {
      return { display: String(friendly).trim(), usedProcessedLabel: true };
    }
  }

  const n = parseTelemetryScalar(raw);
  if (n !== null && Number.isFinite(n)) {
    return { display: `${n.toFixed(dec)}${u ? ` ${u}` : ''}`.trim(), usedProcessedLabel: false };
  }
  if (typeof raw === 'boolean') {
    return { display: raw ? 'Sí' : 'No', usedProcessedLabel: true };
  }
  if (typeof raw === 'object') {
    try {
      return { display: JSON.stringify(raw), usedProcessedLabel: false };
    } catch {
      return { display: String(raw), usedProcessedLabel: false };
    }
  }
  const s = String(raw).trim();
  return { display: s.length ? s : '—', usedProcessedLabel: false };
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
