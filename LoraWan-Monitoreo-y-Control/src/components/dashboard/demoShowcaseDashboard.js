/**
 * Tablero de demostración del Panel Control (rol demo, solo lectura).
 * Siembra un widget de cada tipo, con datos simulados y colores distintos, en tres pestañas.
 */

import { applyPanelBsdBundle } from '../../utils/panelBsdPreferencesBundle';
import { buildModerateBsdGridTemplateForWidget, dashboardGridLayoutStorageKey, readStoredBsdGridLayout } from './bsdDashboardLayout';
import {
  DASH_WIDGET,
  dashboardWidgetSensorStub,
  dashboardWidgetStorageKey,
  defaultDashboardVisibilityForVariant,
  loadDashboardVisibility,
  mergeWidgetConfig,
  loadPanelWorkspace,
  savePanelWorkspace,
  widgetStorageKey,
  saveWidgetConfig,
} from './widgetConfigUtils';

export const DEMO_SHOWCASE_VERSION = 'v3';
export const DEMO_SHOWCASE_DEVICE_ID = 'demo-showcase';

export const DEMO_SHOWCASE_PANELS = [
  { id: 'main', name: 'Lecturas' },
  { id: 'demo_niveles', name: 'Niveles y gráficos' },
  { id: 'demo_control', name: 'Control y mapas' },
];

/** Chihuahua (sede SYSCOM) para mapa y trayectoria de ejemplo. */
const DEMO_LAT = 28.6353;
const DEMO_LNG = -106.0889;

function demoShowcaseFlagKey(ownerSegment) {
  return `bsd_demo_showcase_${DEMO_SHOWCASE_VERSION}_${ownerSegment}`;
}

function visOnly(widgetIds) {
  const m = defaultDashboardVisibilityForVariant('panel');
  for (const id of widgetIds) m[id] = true;
  return m;
}

function gridItem(id, x, y, size = {}) {
  const tmpl = buildModerateBsdGridTemplateForWidget(id);
  return {
    i: id,
    x,
    y,
    w: size.w != null ? size.w : tmpl.w,
    h: size.h != null ? size.h : tmpl.h,
    ...(tmpl.minW != null ? { minW: tmpl.minW } : {}),
    ...(tmpl.minH != null ? { minH: tmpl.minH } : {}),
  };
}

function widgetCfg(dashWidgetId, patch) {
  return mergeWidgetConfig(dashboardWidgetSensorStub(dashWidgetId), patch || {});
}

/** Tarjetas del multi-sensor: lecturas de proceso, no metadatos LoRaWAN. */
export const DEMO_SHOWCASE_GRID_FIELDS = [
  {
    propertyKey: 'pressure',
    name: 'Presión',
    unit: 'hPa',
    icon: '📊',
    threshold: 1030,
    decimals: 0,
    titleColor: '#0369a1',
    widgetBackgroundColor: '#f0f9ff',
    scaleMin: 980,
    scaleMax: 1040,
    ranges: [
      { id: 'r1', name: 'Baja', value: 1000, color: '#38bdf8' },
      { id: 'r2', name: 'Normal', value: 1025, color: '#22c55e' },
      { id: 'r3', name: 'Alta', value: 1040, color: '#f97316' },
    ],
  },
  {
    propertyKey: 'aqi',
    name: 'Calidad del aire',
    unit: 'AQI',
    icon: '🌫️',
    threshold: 80,
    decimals: 0,
    titleColor: '#6d28d9',
    widgetBackgroundColor: '#f5f3ff',
    scaleMin: 0,
    scaleMax: 150,
    ranges: [
      { id: 'r1', name: 'Buena', value: 50, color: '#22c55e' },
      { id: 'r2', name: 'Moderada', value: 100, color: '#eab308' },
      { id: 'r3', name: 'Alta', value: 150, color: '#ef4444' },
    ],
  },
  {
    propertyKey: 'battery',
    name: 'Batería',
    unit: '%',
    icon: '🔋',
    threshold: 101,
    decimals: 0,
    titleColor: '#c2410c',
    widgetBackgroundColor: '#fff7ed',
    scaleMin: 0,
    scaleMax: 100,
    ranges: [
      { id: 'r1', name: 'Crítica', value: 20, color: '#ef4444' },
      { id: 'r2', name: 'Media', value: 60, color: '#f59e0b' },
      { id: 'r3', name: 'Buena', value: 100, color: '#22c55e' },
    ],
  },
  {
    propertyKey: 'occupancy',
    name: 'Ocupación',
    unit: '%',
    icon: '👥',
    threshold: 90,
    decimals: 0,
    titleColor: '#be185d',
    widgetBackgroundColor: '#fdf2f8',
    scaleMin: 0,
    scaleMax: 100,
    ranges: [
      { id: 'r1', name: 'Baja', value: 40, color: '#a855f7' },
      { id: 'r2', name: 'Media', value: 75, color: '#ec4899' },
      { id: 'r3', name: 'Alta', value: 100, color: '#f43f5e' },
    ],
  },
];

/**
 * Tarjetas del widget Multi-sensor para la cuenta demo (valores vivos).
 * @param {Record<string, unknown> | null | undefined} tel
 */
export function buildDemoShowcaseSensors(tel = {}) {
  return DEMO_SHOWCASE_GRID_FIELDS.map((f, i) => {
    const raw = tel?.[f.propertyKey];
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw);
    return {
      id: i + 1,
      name: f.name,
      value: Number.isFinite(n) ? n : 0,
      unit: f.unit,
      icon: f.icon,
      threshold: f.threshold,
      propertyKey: f.propertyKey,
      sourceDeviceId: DEMO_SHOWCASE_DEVICE_ID,
    };
  });
}

function sensorCardStorageKey(field) {
  return widgetStorageKey('panel', DEMO_SHOWCASE_DEVICE_ID, field);
}

function sensorCardCfg(fieldDef) {
  return mergeWidgetConfig(
    {
      name: fieldDef.name,
      value: 0,
      unit: fieldDef.unit,
      icon: fieldDef.icon,
      threshold: fieldDef.threshold,
      propertyKey: fieldDef.propertyKey,
      sourceDeviceId: DEMO_SHOWCASE_DEVICE_ID,
    },
    {
      basics: { title: fieldDef.name },
      data: { fieldKey: fieldDef.propertyKey, unit: fieldDef.unit, decimals: fieldDef.decimals },
      appearance: {
        titleColor: fieldDef.titleColor,
        widgetBackgroundColor: fieldDef.widgetBackgroundColor,
      },
      gauge: {
        indicatorType: 'circular',
        scaleMin: fieldDef.scaleMin,
        scaleMax: fieldDef.scaleMax,
        ranges: fieldDef.ranges,
      },
    }
  );
}

function storageKey(seg, panelId, widgetId) {
  return dashboardWidgetStorageKey('panel', null, widgetId, panelId, seg);
}

const DEMO_IMAGE_SVG =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#4f46e5"/>
          <stop offset="45%" stop-color="#06b6d4"/>
          <stop offset="100%" stop-color="#f97316"/>
        </linearGradient>
      </defs>
      <rect width="800" height="480" rx="28" fill="url(#g)"/>
      <text x="400" y="210" text-anchor="middle" fill="#fff" font-family="Segoe UI,sans-serif" font-size="46" font-weight="700">SYSCOM IoT</text>
      <text x="400" y="268" text-anchor="middle" fill="rgba(255,255,255,.9)" font-family="Segoe UI,sans-serif" font-size="22">Vista de demostración · LoRaWAN</text>
    </svg>`
  );

function buildPanelBundles(seg) {
  const lecturasWidgets = {
    [storageKey(seg, 'main', DASH_WIDGET.TEXT)]: widgetCfg(DASH_WIDGET.TEXT, {
      basics: { title: 'Temperatura' },
      data: {
        fieldKey: 'temperature',
        unit: '°C',
        decimals: 1,
        metricSubtitle: 'Ambiente interior',
      },
      appearance: { titleColor: '#0e7490', widgetBackgroundColor: '#ecfeff' },
    }),
    [storageKey(seg, 'main', DASH_WIDGET.METRIC_CIRCULAR)]: widgetCfg(DASH_WIDGET.METRIC_CIRCULAR, {
      basics: { title: 'Humedad' },
      data: {
        fieldKey: 'humidity',
        unit: '%',
        decimals: 0,
        metricSubtitle: 'Ambiente',
        metricGradient: 'thermal',
      },
      appearance: { titleColor: '#0f766e', widgetBackgroundColor: '#f0fdfa' },
      gauge: {
        scaleMin: 0,
        scaleMax: 100,
        ranges: [
          { id: 'r1', name: 'Seco', value: 30, color: '#38bdf8' },
          { id: 'r2', name: 'Ideal', value: 60, color: '#22c55e' },
          { id: 'r3', name: 'Húmedo', value: 80, color: '#eab308' },
          { id: 'r4', name: 'Alto', value: 100, color: '#ef4444' },
        ],
      },
    }),
    [storageKey(seg, 'main', DASH_WIDGET.VEleta)]: widgetCfg(DASH_WIDGET.VEleta, {
      basics: { title: 'Dirección del viento' },
      data: { fieldKey: 'wind_direction', unit: '°', decimals: 0 },
      appearance: { titleColor: '#1d4ed8', widgetBackgroundColor: '#eff6ff' },
    }),
    [storageKey(seg, 'main', DASH_WIDGET.SENSOR_GRID)]: widgetCfg(DASH_WIDGET.SENSOR_GRID, {
      basics: { title: 'Otras lecturas' },
      appearance: { titleColor: '#7c3aed', widgetBackgroundColor: '#faf5ff' },
    }),
    ...Object.fromEntries(DEMO_SHOWCASE_GRID_FIELDS.map((f) => [sensorCardStorageKey(f.propertyKey), sensorCardCfg(f)])),
  };

  const nivelesWidgets = {
    [storageKey(seg, 'demo_niveles', DASH_WIDGET.SATISFACTION)]: widgetCfg(DASH_WIDGET.SATISFACTION, {
      basics: { title: 'Ocupación' },
      data: { fieldKey: 'occupancy', unit: '%', decimals: 0 },
      appearance: { titleColor: '#c026d3', widgetBackgroundColor: '#fdf4ff' },
      gauge: {
        scaleMin: 0,
        scaleMax: 100,
        ranges: [
          { id: 'r1', name: 'Baja', value: 40, color: '#a855f7' },
          { id: 'r2', name: 'Media', value: 70, color: '#ec4899' },
          { id: 'r3', name: 'Alta', value: 100, color: '#f43f5e' },
        ],
      },
    }),
    [storageKey(seg, 'demo_niveles', DASH_WIDGET.CONTAINER)]: widgetCfg(DASH_WIDGET.CONTAINER, {
      basics: { title: 'Tanque' },
      data: { fieldKey: 'tank_level', unit: '%', decimals: 0 },
      appearance: { titleColor: '#047857', widgetBackgroundColor: '#ecfdf5' },
      gauge: {
        scaleMin: 0,
        scaleMax: 100,
        ranges: [
          { id: 'r1', name: 'Bajo', value: 25, color: '#f97316' },
          { id: 'r2', name: 'Medio', value: 70, color: '#22c55e' },
          { id: 'r3', name: 'Lleno', value: 100, color: '#0ea5e9' },
        ],
      },
    }),
    [storageKey(seg, 'demo_niveles', DASH_WIDGET.BATTERY_LEVEL)]: widgetCfg(DASH_WIDGET.BATTERY_LEVEL, {
      basics: { title: 'Batería' },
      data: { fieldKey: 'battery', unit: '%', decimals: 0 },
      appearance: { titleColor: '#c2410c', widgetBackgroundColor: '#fff7ed' },
      gauge: {
        scaleMin: 0,
        scaleMax: 100,
        ranges: [
          { id: 'r1', name: 'Crítica', value: 20, color: '#ef4444' },
          { id: 'r2', name: 'Media', value: 60, color: '#f59e0b' },
          { id: 'r3', name: 'Buena', value: 100, color: '#22c55e' },
        ],
      },
    }),
    [storageKey(seg, 'demo_niveles', DASH_WIDGET.STREAM)]: widgetCfg(DASH_WIDGET.STREAM, {
      basics: { title: 'Temperatura y humedad' },
      data: {
        fieldKey: 'temperature',
        unit: '°C',
        decimals: 1,
        historyRangePreset: 'live',
        streamSeries: [
          {
            id: 's_temp',
            fieldKey: 'temperature',
            label: 'Temperatura',
            chartType: 'area',
            color: '#06b6d4',
            valueMode: 'absolute',
            interpolation: 'linear',
            yAxis: 'y',
          },
          {
            id: 's_hum',
            fieldKey: 'humidity',
            label: 'Humedad',
            chartType: 'line',
            color: '#a855f7',
            valueMode: 'absolute',
            interpolation: 'linear',
            yAxis: 'y2',
          },
        ],
      },
      appearance: { titleColor: '#4338ca', widgetBackgroundColor: '#eef2ff' },
    }),
    [storageKey(seg, 'demo_niveles', DASH_WIDGET.BAR_CHART)]: widgetCfg(DASH_WIDGET.BAR_CHART, {
      basics: { title: 'Temperatura por hora' },
      data: {
        fieldKey: 'temperature',
        unit: '°C',
        decimals: 1,
        barChartTarget: '28',
        barLegendActual: 'Temperatura',
        barLegendTarget: 'Umbral',
      },
      appearance: { titleColor: '#be185d', widgetBackgroundColor: '#fdf2f8' },
      timeframe: {
        mode: 'interval',
        operation: 'avg',
        from: '12 horas atrás',
        to: 'now',
        granularity: 'hour',
      },
    }),
  };

  const controlWidgets = {
    [storageKey(seg, 'demo_control', DASH_WIDGET.MAP)]: widgetCfg(DASH_WIDGET.MAP, {
      basics: { title: 'Ubicación' },
      data: {
        savedLatitude: String(DEMO_LAT),
        savedLongitude: String(DEMO_LNG),
        mapBaseLayer: 'street',
      },
      appearance: { titleColor: '#0369a1', widgetBackgroundColor: '#f0f9ff' },
    }),
    [storageKey(seg, 'demo_control', DASH_WIDGET.TRACKING_MAP)]: widgetCfg(DASH_WIDGET.TRACKING_MAP, {
      basics: { title: 'Rastreo' },
      data: { trackingTimeRange: 'day', mapBaseLayer: 'street' },
      appearance: { titleColor: '#a16207', widgetBackgroundColor: '#fefce8' },
    }),
    [storageKey(seg, 'demo_control', DASH_WIDGET.IMAGE)]: widgetCfg(DASH_WIDGET.IMAGE, {
      basics: { title: 'Imagen' },
      data: { staticImageUrl: DEMO_IMAGE_SVG },
      appearance: { titleColor: '#be185d', widgetBackgroundColor: '#fdf2f8' },
    }),
    [storageKey(seg, 'demo_control', DASH_WIDGET.SWITCH)]: widgetCfg(DASH_WIDGET.SWITCH, {
      basics: { title: 'Bomba de riego' },
      appearance: { titleColor: '#b45309', widgetBackgroundColor: '#fffbeb' },
    }),
    [storageKey(seg, 'demo_control', DASH_WIDGET.DOWNLINK)]: widgetCfg(DASH_WIDGET.DOWNLINK, {
      basics: { title: 'Comandos' },
      data: {
        downlinkButtons: [
          { id: 'dlb_on', hex: '0101', label: 'Encender', buttonColor: '#16a34a' },
          { id: 'dlb_off', hex: '0100', label: 'Apagar', buttonColor: '#dc2626' },
          { id: 'dlb_rst', hex: 'ff00', label: 'Reiniciar', buttonColor: '#2563eb' },
        ],
        downlinkDefaultHex: '0101',
      },
      appearance: { titleColor: '#6d28d9', widgetBackgroundColor: '#f5f3ff' },
    }),
  };

  return {
    main: {
      valueWidgets: lecturasWidgets,
      visibility: visOnly([
        DASH_WIDGET.TEXT,
        DASH_WIDGET.METRIC_CIRCULAR,
        DASH_WIDGET.VEleta,
        DASH_WIDGET.SENSOR_GRID,
      ]),
      gridLayout: [
        gridItem(DASH_WIDGET.TEXT, 0, 0, { w: 4, h: 11 }),
        gridItem(DASH_WIDGET.METRIC_CIRCULAR, 4, 0, { w: 4, h: 11 }),
        gridItem(DASH_WIDGET.VEleta, 8, 0, { w: 4, h: 11 }),
        gridItem(DASH_WIDGET.SENSOR_GRID, 0, 11, { w: 12, h: 12 }),
      ],
    },
    demo_niveles: {
      valueWidgets: nivelesWidgets,
      visibility: visOnly([
        DASH_WIDGET.SATISFACTION,
        DASH_WIDGET.CONTAINER,
        DASH_WIDGET.BATTERY_LEVEL,
        DASH_WIDGET.STREAM,
        DASH_WIDGET.BAR_CHART,
      ]),
      gridLayout: [
        gridItem(DASH_WIDGET.SATISFACTION, 0, 0, { w: 4 }),
        gridItem(DASH_WIDGET.CONTAINER, 4, 0, { w: 4 }),
        gridItem(DASH_WIDGET.BATTERY_LEVEL, 8, 0, { w: 4 }),
        gridItem(DASH_WIDGET.STREAM, 0, 9),
        gridItem(DASH_WIDGET.BAR_CHART, 6, 9),
      ],
    },
    demo_control: {
      valueWidgets: controlWidgets,
      visibility: visOnly([
        DASH_WIDGET.MAP,
        DASH_WIDGET.TRACKING_MAP,
        DASH_WIDGET.IMAGE,
        DASH_WIDGET.SWITCH,
        DASH_WIDGET.DOWNLINK,
      ]),
      gridLayout: [
        gridItem(DASH_WIDGET.MAP, 0, 0),
        gridItem(DASH_WIDGET.TRACKING_MAP, 4, 0),
        gridItem(DASH_WIDGET.IMAGE, 8, 0),
        gridItem(DASH_WIDGET.SWITCH, 0, 9),
        gridItem(DASH_WIDGET.DOWNLINK, 3, 9, { w: 9 }),
      ],
    },
  };
}

/**
 * Telemetría simulada (oscila con el tiempo) para que los widgets demo no queden vacíos.
 * @param {number} [now]
 */
export function buildDemoShowcaseLiveTelemetry(now = Date.now()) {
  const t = Number(now) / 1000;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const temperature = Number((22.8 + Math.sin(t / 18) * 3.4).toFixed(1));
  const humidity = Math.round(clamp(54 + Math.cos(t / 22) * 14, 20, 95));
  const pressure = Math.round(1012 + Math.sin(t / 40) * 5);
  const aqi = Math.round(clamp(36 + Math.sin(t / 30) * 16, 8, 120));
  const battery = Math.round(clamp(82 + Math.sin(t / 55) * 11, 15, 100));
  const tank_level = Math.round(clamp(61 + Math.sin(t / 28) * 22, 8, 98));
  const occupancy = Math.round(clamp(71 + Math.cos(t / 25) * 18, 12, 98));
  const wind_direction = Math.round(((215 + Math.sin(t / 16) * 48) % 360 + 360) % 360);
  return {
    temperature,
    humidity,
    pressure,
    aqi,
    battery,
    tank_level,
    occupancy,
    wind_direction,
    latitude: DEMO_LAT + Math.sin(t / 42) * 0.004,
    longitude: DEMO_LNG + Math.cos(t / 36) * 0.005,
    lastUpdateTime: now,
  };
}

/**
 * Historial sintético para gráfico lineal / barras.
 * @param {number} fromMs
 * @param {number} toMs
 * @param {number} [stepMs]
 */
export function buildDemoShowcaseHistoryRows(fromMs, toMs, stepMs) {
  const start = Number(fromMs);
  const end = Number(toMs);
  const step = Math.max(60_000, Number(stepMs) || 3_600_000);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const rows = [];
  for (let ts = start; ts <= end; ts += step) {
    const tel = buildDemoShowcaseLiveTelemetry(ts);
    rows.push({ ts, timestamp: ts, properties: tel });
  }
  if (!rows.length || rows[rows.length - 1].ts < end - step / 2) {
    const tel = buildDemoShowcaseLiveTelemetry(end);
    rows.push({ ts: end, timestamp: end, properties: tel });
  }
  return rows;
}

/**
 * Recorrido GPS de ejemplo alrededor de Chihuahua.
 * @param {number} fromMs
 * @param {number} toMs
 */
export function buildDemoShowcaseTrackingRows(fromMs, toMs) {
  const n = 28;
  const span = Math.max(1, Number(toMs) - Number(fromMs));
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ts = Number(fromMs) + Math.round((span * i) / (n - 1));
    const a = (i / (n - 1)) * Math.PI * 1.65;
    rows.push({
      ts,
      timestamp: ts,
      properties: {
        latitude: DEMO_LAT + Math.sin(a) * 0.014,
        longitude: DEMO_LNG + Math.cos(a) * 0.018,
        ts,
      },
    });
  }
  return rows;
}

export function normalizeDemoShowcasePanelId(panelId) {
  const pid = panelId != null ? String(panelId).trim() : 'main';
  if (DEMO_SHOWCASE_PANELS.some((p) => p.id === pid)) return pid;
  return 'main';
}

export function demoShowcaseWorkspace(activePanelId) {
  return {
    panels: DEMO_SHOWCASE_PANELS.map((p) => ({ ...p })),
    activePanelId: normalizeDemoShowcasePanelId(activePanelId),
  };
}

/**
 * Snapshot en memoria (no depende de localStorage) para pintar el tablero demo.
 * @param {string} ownerSegment
 * @param {string} [panelInstanceId]
 */
export function readDemoShowcasePanel(ownerSegment, panelInstanceId) {
  const seg = ownerSegment != null ? String(ownerSegment).trim() : 'demo';
  const pid = normalizeDemoShowcasePanelId(panelInstanceId);
  const bundles = buildPanelBundles(seg);
  const b = bundles[pid] || bundles.main;
  return {
    panelId: pid,
    workspace: demoShowcaseWorkspace(pid),
    visibility: { ...b.visibility },
    gridLayout: (b.gridLayout || []).map((it) => ({ ...it })),
    valueWidgets: b.valueWidgets,
  };
}

function isDemoShowcaseComplete(seg) {
  try {
    const ws = loadPanelWorkspace(seg);
    if (!ws?.panels?.some((p) => p.id === 'demo_niveles') || !ws?.panels?.some((p) => p.id === 'demo_control')) {
      return false;
    }
    const vis = loadDashboardVisibility('panel', null, 'main', seg);
    if (vis[DASH_WIDGET.TEXT] !== true) return false;
    const gk = dashboardGridLayoutStorageKey('panel', null, 'main', seg);
    const layout = readStoredBsdGridLayout(gk);
    if (!Array.isArray(layout) || !layout.some((it) => String(it.i) === DASH_WIDGET.TEXT)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Escribe workspace, visibilidad, rejilla y configs si aún no está la versión actual.
 * @param {string} ownerSegment
 * @returns {boolean} true si escribió en esta llamada
 */
export function applyDemoShowcaseIfNeeded(ownerSegment) {
  if (typeof localStorage === 'undefined') return false;
  const seg = ownerSegment != null ? String(ownerSegment).trim() : '';
  if (!seg) return false;
  const flag = demoShowcaseFlagKey(seg);
  try {
    if (localStorage.getItem(flag) === '1' && isDemoShowcaseComplete(seg)) return false;
  } catch {
    /* seguir y reescribir */
  }

  savePanelWorkspace(demoShowcaseWorkspace('main'), seg);

  const bundles = buildPanelBundles(seg);
  applyPanelBsdBundle(seg, 'main', bundles.main);
  applyPanelBsdBundle(seg, 'demo_niveles', bundles.demo_niveles);
  applyPanelBsdBundle(seg, 'demo_control', bundles.demo_control);
  for (const f of DEMO_SHOWCASE_GRID_FIELDS) {
    try {
      saveWidgetConfig(sensorCardStorageKey(f.propertyKey), sensorCardCfg(f));
    } catch {
      /* quota */
    }
  }

  try {
    localStorage.setItem(flag, '1');
  } catch {
    /* quota */
  }
  return true;
}
