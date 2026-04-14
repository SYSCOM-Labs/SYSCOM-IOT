/** @typedef {{ id: string; name: string; value: number; color: string }} GaugeRangeRow */

const STORAGE_KEY = 'bsd_value_widgets_v1';
export const VISIBILITY_STORAGE_KEY = 'bsd_dashboard_visible_v1';

/** IDs de widgets fijos del dashboard (Panel / Dispositivo). */
export const DASH_WIDGET = {
  SWITCH: 'dw_switch',
  DOWNLINK: 'dw_downlink',
  EMERGENCY: 'dw_emergency',
  IMAGE: 'dw_image',
  MAP: 'dw_map',
  BUDGET: 'dw_budget',
  TASKS: 'dw_tasks',
  SATISFACTION: 'dw_satisfaction',
  BURNDOWN: 'dw_burndown',
  SOURCES: 'dw_sources',
  TASK_STATUS: 'dw_task_status',
  ALERTS: 'dw_alerts',
  STREAM: 'dw_stream',
  PANEL_DEVICE_BAR: 'dw_panel_device_bar',
  SENSOR_GRID: 'dw_sensor_grid',
};

/** @returns {{ id: string; label: string; panelOnly?: boolean }[]} */
export function getDashboardWidgetMenuEntries() {
  return [
    { id: DASH_WIDGET.PANEL_DEVICE_BAR, label: 'Barra: controles vinculados', panelOnly: true },
    { id: DASH_WIDGET.SWITCH, label: 'Switch' },
    { id: DASH_WIDGET.DOWNLINK, label: 'Downlink' },
    { id: DASH_WIDGET.EMERGENCY, label: 'Emergencia' },
    { id: DASH_WIDGET.IMAGE, label: 'Imagen' },
    { id: DASH_WIDGET.MAP, label: 'Mapa' },
    { id: DASH_WIDGET.BUDGET, label: 'Total Budget' },
    { id: DASH_WIDGET.TASKS, label: 'Tasks Completed' },
    { id: DASH_WIDGET.SATISFACTION, label: 'Team Satisfaction' },
    { id: DASH_WIDGET.BURNDOWN, label: 'Epic Burndown' },
    { id: DASH_WIDGET.SOURCES, label: 'Sources' },
    { id: DASH_WIDGET.TASK_STATUS, label: 'Task Status' },
    { id: DASH_WIDGET.ALERTS, label: 'Threshold Alerts' },
    { id: DASH_WIDGET.STREAM, label: 'Streaming en vivo' },
    { id: DASH_WIDGET.SENSOR_GRID, label: 'Cuadrícula de sensores (valores)' },
  ];
}

export function defaultDashboardVisibility() {
  const m = {};
  for (const { id } of getDashboardWidgetMenuEntries()) m[id] = true;
  return m;
}

/** Listado de pestaña Básicos al editar widgets fijos del tablero BSD. */
export const DASHBOARD_BASICS_WIDGET_OPTIONS = [
  { id: DASH_WIDGET.BUDGET, label: 'Total Budget Widget' },
  { id: DASH_WIDGET.TASKS, label: 'Tasks Completed Widget' },
  { id: DASH_WIDGET.SATISFACTION, label: 'Team Satisfaction Widget' },
  { id: DASH_WIDGET.BURNDOWN, label: 'Epic Burndown Chart Widget' },
  { id: DASH_WIDGET.SOURCES, label: 'Sources Widget' },
  { id: DASH_WIDGET.TASK_STATUS, label: 'Task Status Widget' },
  { id: DASH_WIDGET.SENSOR_GRID, label: 'Multi-Sensor Panel Widget' },
  { id: DASH_WIDGET.ALERTS, label: 'Threshold Alerts Widget' },
  { id: DASH_WIDGET.STREAM, label: 'Real-Time Sensor Streaming Widget' },
  { id: DASH_WIDGET.EMERGENCY, label: 'Botón de emergencia' },
  { id: DASH_WIDGET.MAP, label: 'Mapa' },
  { id: DASH_WIDGET.IMAGE, label: 'Imagen' },
];

/** @param {string | undefined} propertyKey */
export function dashWidgetIdFromPropertyKey(propertyKey) {
  const s = String(propertyKey || '');
  if (!s.startsWith('__bsd_')) return null;
  return s.slice(6) || null;
}

/** @param {Record<string, unknown> | null | undefined} sensor */
export function isDashboardFixedWidgetSensor(sensor) {
  return Boolean(sensor?.sourceDeviceId === 'dashboard' && dashWidgetIdFromPropertyKey(sensor?.propertyKey));
}

/**
 * @param {string} dashWidgetId ej. DASH_WIDGET.BUDGET → dw_budget
 * @returns {{ id: number; name: string; propertyKey: string; value: number; unit: string; threshold: number; sourceDeviceId: string }}
 */
export function dashboardWidgetSensorStub(dashWidgetId) {
  const opt = DASHBOARD_BASICS_WIDGET_OPTIONS.find((o) => o.id === dashWidgetId);
  const name = opt
    ? String(opt.label)
        .replace(/\s+Widget\s*$/i, '')
        .trim() || opt.label
    : String(dashWidgetId);
  return {
    id: 0,
    name,
    propertyKey: `__bsd_${dashWidgetId}`,
    value: 0,
    unit: '',
    threshold: 1,
    sourceDeviceId: 'dashboard',
  };
}

/**
 * Opciones del select; si el widget abierto no está en la lista (p. ej. Switch), se añade arriba.
 * @param {Record<string, unknown> | null | undefined} sensor
 */
export function basicsWidgetOptionsForSensor(sensor) {
  const current = dashWidgetIdFromPropertyKey(sensor?.propertyKey);
  const allowed = new Set(DASHBOARD_BASICS_WIDGET_OPTIONS.map((o) => o.id));
  const out = [...DASHBOARD_BASICS_WIDGET_OPTIONS];
  if (current && !allowed.has(current)) {
    out.unshift({ id: current, label: String(sensor?.name || current) });
  }
  return out;
}

/** `variant|dashboard|dw_*` → `dw_*` */
export function dashboardWidgetIdFromStorageKey(storageKey) {
  const parts = String(storageKey || '').split('|');
  if (parts.length < 3 || parts[1] !== 'dashboard') return null;
  return parts[2] || null;
}

/** @param {'panel' | 'device'} variant */
export function loadDashboardVisibility(variant) {
  try {
    const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    const root = raw ? JSON.parse(raw) : {};
    const branch = root[variant];
    return { ...defaultDashboardVisibility(), ...(branch && typeof branch === 'object' ? branch : {}) };
  } catch {
    return defaultDashboardVisibility();
  }
}

/** @param {'panel' | 'device'} variant @param {Record<string, boolean>} map */
export function saveDashboardVisibility(variant, map) {
  try {
    let root = {};
    const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') root = p;
    }
    root[variant] = { ...map };
    localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify(root));
  } catch {
    /* ignore */
  }
}

export const INDICATOR_TYPE_OPTIONS = [
  { value: 'none', label: 'Ninguno' },
  { value: 'linear', label: 'Lineal' },
  { value: 'vertical', label: 'Vertical' },
  { value: 'circular', label: 'Circular' },
  { value: 'fill', label: 'Nivel de llenado' },
  { value: 'battery', label: 'Batería' },
  { value: 'compass', label: 'Brújula' },
  { value: 'numeric', label: 'Numérico' },
];

/** Tipos de widget / visualización (pestaña Básicos) — sincroniza con gauge.indicatorType */
export const WIDGET_TYPE_OPTIONS = INDICATOR_TYPE_OPTIONS;

export const WIDGET_PRESETS = [
  { value: 'none', label: 'Ninguno (predeterminado)' },
  { value: 'temperature', label: 'Temperatura' },
  { value: 'humidity', label: 'Humedad' },
  { value: 'current', label: 'Corriente / consumo' },
  { value: 'pressure', label: 'Presión' },
];

export const COMMON_TIMEZONES = [
  { value: 'America/Mexico_City', label: 'Hora central (México)' },
  { value: 'America/Tijuana', label: 'Pacífico (México)' },
  { value: 'America/New_York', label: 'Este (EE.UU.)' },
  { value: 'America/Los_Angeles', label: 'Pacífico (EE.UU.)' },
  { value: 'Europe/Madrid', label: 'España' },
  { value: 'UTC', label: 'UTC' },
];

/** Agrupación del historial (intervalo) para sensores / indicadores lineales. */
export const HISTORY_GRANULARITY_OPTIONS = [
  { value: '', label: 'Todo el intervalo' },
  { value: 'minute', label: 'Minuto' },
  { value: 'hour', label: 'Hora' },
  { value: 'day', label: 'Día' },
  { value: 'month', label: 'Mes' },
  { value: 'year', label: 'Año' },
];

/**
 * Ajusta el intervalo temporal según la resolución y activa agregación (promedio por defecto).
 * @param {Record<string, unknown>} draft
 * @param {string} granularity '' | minute | hour | day | month | year
 */
export function applyHistoryGranularityPreset(draft, granularity) {
  draft.timeframe = draft.timeframe || {};
  if (!granularity) {
    draft.timeframe.granularity = '';
    return;
  }
  const now = Date.now();
  let fromMs = now;
  switch (granularity) {
    case 'minute':
      fromMs = now - 3600000;
      break;
    case 'hour':
      fromMs = now - 86400000 * 7;
      break;
    case 'day':
      fromMs = now - 86400000 * 90;
      break;
    case 'month':
      fromMs = now - 86400000 * 730;
      break;
    case 'year':
      fromMs = now - 86400000 * 3650;
      break;
    default:
      draft.timeframe.granularity = '';
      return;
  }
  draft.timeframe.mode = 'interval';
  draft.timeframe.from = new Date(fromMs).toISOString();
  draft.timeframe.to = new Date(now).toISOString();
  draft.timeframe.granularity = granularity;
  if (!draft.timeframe.operation) draft.timeframe.operation = 'avg';
}

function startOfLocalDayMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * @param {number} value
 * @param {Array<{ value: number; color?: string }>} ranges sorted optional
 * @param {number} scaleMin
 * @param {number} scaleMax
 * @returns {string | null}
 */
/** Normaliza HEX para comparar o guardar (sin espacios, minúsculas). */
export function normalizeDownlinkHex(hex) {
  return String(hex || '')
    .replace(/\s/g, '')
    .toLowerCase();
}

/** Colores por defecto para series del widget Streaming (multi-serie). */
export const STREAM_SERIES_PALETTE = ['#f5a623', '#4299e1', '#9f7aea', '#48bb78', '#ed8936', '#06b6d4'];

/**
 * Normaliza `data` del widget Streaming a series listas para el gráfico (soporta `fieldKey` legacy).
 * @param {Record<string, unknown> | undefined} data
 */
export function normalizeStreamSeriesConfig(data) {
  const palette = STREAM_SERIES_PALETTE;
  const toRow = (s, i) => {
    const fieldKey = String(s?.fieldKey || '').trim();
    if (!fieldKey) return null;
    const chartType = ['line', 'area', 'bar'].includes(s?.chartType) ? s.chartType : 'line';
    const valueMode = s?.valueMode === 'delta' ? 'delta' : 'absolute';
    const interpolation = s?.interpolation === 'step' ? 'step' : 'linear';
    const yAxis = s?.yAxis === '2' || s?.yAxis === 'y2' ? 'y2' : 'y';
    const color =
      typeof s?.color === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.color.trim())
        ? s.color.trim()
        : palette[i % palette.length];
    const label = String(s?.label || fieldKey || `Serie ${i + 1}`).trim();
    return {
      id: String(s?.id || `s_${i}`),
      fieldKey,
      valueMode,
      label,
      chartType,
      color,
      interpolation,
      yAxis,
    };
  };
  const raw = data?.streamSeries;
  if (Array.isArray(raw) && raw.length) {
    return raw.map(toRow).filter(Boolean);
  }
  const fk = data?.fieldKey;
  if (fk && String(fk).trim() && !String(fk).startsWith('__bsd_')) {
    const k = String(fk).trim();
    return [
      {
        id: 'legacy',
        fieldKey: k,
        valueMode: 'absolute',
        label: k,
        chartType: 'line',
        color: '#06b6d4',
        interpolation: 'linear',
        yAxis: 'y',
      },
    ];
  }
  return [];
}

/** Fila nueva en el editor de series del Streaming. */
export function defaultStreamSeriesRow(index = 0) {
  const palette = STREAM_SERIES_PALETTE;
  return {
    id: `ss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    fieldKey: '',
    valueMode: 'absolute',
    label: `Serie ${index + 1}`,
    chartType: index % 2 === 0 ? 'area' : 'line',
    color: palette[index % palette.length],
    interpolation: 'linear',
    yAxis: '1',
  };
}

/** Garantiza `streamSeries` al abrir el editor del widget Streaming (migra `fieldKey`). */
export function ensureStreamSeriesDraftData(data) {
  const d = data && typeof data === 'object' ? { ...data } : {};
  if (Array.isArray(d.streamSeries) && d.streamSeries.length > 0) return d;
  const fk = d.fieldKey;
  const fkOk = fk && String(fk).trim() && !String(fk).startsWith('__bsd_');
  return {
    ...d,
    streamSeries: fkOk
      ? [
          {
            id: `ss_${Date.now()}`,
            fieldKey: String(fk).trim(),
            valueMode: 'absolute',
            label: String(fk).trim(),
            chartType: 'area',
            color: STREAM_SERIES_PALETTE[0],
            interpolation: 'linear',
            yAxis: '1',
          },
        ]
      : [defaultStreamSeriesRow(0)],
  };
}

export function colorForValueInRanges(value, ranges, scaleMin, scaleMax) {
  const min = Number(scaleMin) || 0;
  const max = Number(scaleMax) > min ? Number(scaleMax) : min + 1;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const list = Array.isArray(ranges) ? [...ranges].sort((a, b) => Number(a.value) - Number(b.value)) : [];
  if (!list.length) return null;
  const clamped = Math.min(max, Math.max(min, v));
  let prev = min;
  for (let i = 0; i < list.length; i++) {
    const end = Math.min(max, Number(list[i].value));
    if (clamped <= end && clamped >= prev) return list[i].color || null;
    prev = end;
  }
  return list[list.length - 1]?.color || null;
}

/** Fusiona config guardada con valores por defecto (nuevas claves). */
export function mergeWidgetConfig(sensor, stored) {
  const base = defaultWidgetConfig(sensor);
  if (!stored || typeof stored !== 'object') return base;
  const s = JSON.parse(JSON.stringify(stored));
  return {
    basics: { ...base.basics, ...(s.basics || {}) },
    data: { ...base.data, ...(s.data || {}) },
    appearance: { ...base.appearance, ...(s.appearance || {}) },
    gauge: {
      ...base.gauge,
      ...(s.gauge || {}),
      ranges: Array.isArray(s.gauge?.ranges) ? s.gauge.ranges : base.gauge.ranges,
    },
    timeframe: { ...base.timeframe, ...(s.timeframe || {}) },
  };
}

/**
 * Aplica un preset al draft (muta copia).
 * @param {Record<string, unknown>} draft
 * @param {string} presetId
 */
export function applyWidgetPresetToDraft(draft, presetId) {
  if (!presetId || presetId === 'none') {
    draft.basics = draft.basics || {};
    draft.basics.preset = 'none';
    return;
  }
  draft.basics = draft.basics || {};
  draft.basics.preset = presetId;
  draft.data = draft.data || {};
  draft.gauge = draft.gauge || {};
  const g = draft.gauge;
  if (presetId === 'temperature') {
    draft.data.unit = '°C';
    draft.data.fieldKey = draft.data.fieldKey || 'temperature';
    g.scaleMin = 0;
    g.scaleMax = 50;
    g.ranges = [
      { id: 'r1', name: 'Frío', value: 15, color: '#3b82f6' },
      { id: 'r2', name: 'Normal', value: 28, color: '#48bb78' },
      { id: 'r3', name: 'Calor', value: 50, color: '#f56565' },
    ];
  } else if (presetId === 'humidity') {
    draft.data.unit = '%';
    draft.data.fieldKey = draft.data.fieldKey || 'humidity';
    g.scaleMin = 0;
    g.scaleMax = 100;
    g.ranges = [
      { id: 'r1', name: '', value: 40, color: '#48bb78' },
      { id: 'r2', name: '', value: 70, color: '#ed8936' },
      { id: 'r3', name: '', value: 100, color: '#f56565' },
    ];
  } else if (presetId === 'current') {
    draft.data.unit = draft.data.unit || 'A';
    draft.data.fieldKey = draft.data.fieldKey || 'current';
    g.scaleMin = 0;
    g.scaleMax = 50;
    g.indicatorType = 'circular';
    g.ranges = [
      { id: 'r1', name: '', value: 10, color: '#48bb78' },
      { id: 'r2', name: '', value: 20, color: '#48bb78' },
      { id: 'r3', name: '', value: 30, color: '#ed8936' },
      { id: 'r4', name: '', value: 50, color: '#f56565' },
    ];
  } else if (presetId === 'pressure') {
    draft.data.unit = 'hPa';
    draft.data.fieldKey = draft.data.fieldKey || 'pressure';
    g.scaleMin = 980;
    g.scaleMax = 1040;
    g.ranges = [
      { id: 'r1', name: '', value: 1000, color: '#48bb78' },
      { id: 'r2', name: '', value: 1020, color: '#ed8936' },
      { id: 'r3', name: '', value: 1040, color: '#f56565' },
    ];
  }
}

/** @returns {Record<string, unknown>} */
export function defaultWidgetConfig(sensor) {
  const pk = sensor.propertyKey || 'value';
  const baseMax =
    typeof sensor.threshold === 'number' && sensor.threshold > 0
      ? Math.max(sensor.threshold * 1.2, sensor.value * 1.1 || sensor.threshold)
      : 50;
  const step = baseMax / 5;
  return {
    basics: {
      title: sensor.name || pk,
      preset: 'none',
      titleTranslations: [],
    },
    data: {
      fieldKey: pk,
      unit: sensor.unit || '',
      decimals: 2,
    },
    appearance: {
      titleColor: '#f97316',
    },
    gauge: {
      indicatorType: 'numeric',
      scaleMin: 0,
      scaleMax: Math.round(baseMax * 10) / 10,
      ranges: [
        { id: 'r1', name: '', value: Math.round(step * 10) / 10, color: '#48bb78' },
        { id: 'r2', name: '', value: Math.round(step * 2 * 10) / 10, color: '#48bb78' },
        { id: 'r3', name: '', value: Math.round(step * 3 * 10) / 10, color: '#48bb78' },
        { id: 'r4', name: '', value: Math.round(step * 4 * 10) / 10, color: '#ed8936' },
        { id: 'r5', name: '', value: Math.round(baseMax * 10) / 10, color: '#f56565' },
      ],
    },
    timeframe: {
      mode: 'current',
      operation: '',
      from: 'now',
      to: 'now',
      granularity: '',
      timezone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC',
    },
  };
}

export function widgetStorageKey(variant, sourceDeviceId, propertyKey) {
  const dev = sourceDeviceId != null ? String(sourceDeviceId) : 'none';
  const pk = propertyKey != null ? String(propertyKey) : 'unknown';
  return `${variant}|${dev}|${pk}`;
}

export function loadAllWidgetConfigs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

export function saveWidgetConfig(storageKey, config) {
  const all = loadAllWidgetConfigs();
  all[storageKey] = config;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/**
 * @param {string} str
 * @param {number} nowMs
 * @param {'from' | 'to' | 'auto'} [role]
 */
export function parseRelativeTime(str, nowMs, role = 'auto') {
  const s = String(str || '').trim().toLowerCase();
  if (!s || s === 'now' || s === 'ahora') return nowMs;
  if (s === 'hoy' || s === 'today') {
    if (role === 'to') return nowMs;
    return startOfLocalDayMs(nowMs);
  }
  if (s === 'ayer' || s === 'yesterday') {
    return startOfLocalDayMs(nowMs) - 86400000;
  }
  if (s === 'anteayer') {
    return startOfLocalDayMs(nowMs) - 2 * 86400000;
  }
  const esDays = s.match(/^(\d+)\s*d[ií]as?\s+atr[aá]s$/);
  if (esDays) {
    const n = parseInt(esDays[1], 10);
    return nowMs - n * 86400000;
  }
  const m = s.match(/^(\d+)\s*(day|days|hour|hours|minute|minutes|min)\s+ago$/);
  if (m) {
    const n = parseInt(m[1], 10);
    let ms = 86400000;
    if (m[2].startsWith('hour')) ms = 3600000;
    if (m[2].startsWith('minute') || m[2] === 'min') ms = 60000;
    return nowMs - n * ms;
  }
  const d = Date.parse(str);
  if (!Number.isNaN(d)) return d;
  return null;
}

export function formatRangePreview(fromStr, toStr, nowMs, timeZone) {
  const a = parseRelativeTime(fromStr, nowMs, 'from');
  const b = parseRelativeTime(toStr, nowMs, 'to');
  if (a == null || b == null) return '';
  try {
    const opts = timeZone ? { timeZone } : undefined;
    return `${new Date(a).toLocaleString(undefined, opts)} → ${new Date(b).toLocaleString(undefined, opts)}`;
  } catch {
    return '';
  }
}
