import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
import { RefreshCw, Zap, AlertTriangle, Image as ImageIcon, Pencil, LayoutGrid, MapPin, Trash2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { fetchDevices, fetchDeviceProperties, fetchDeviceHistory, sendDownlink } from '../../services/api';
import { getLatestDeviceData, queryTelemetry } from '../../services/localAuth';
import {
  parseTelemetryScalar,
  parseTelemetryBoolish,
  expandNestedGatewayTelemetry,
  PROPERTY_INFER_IGNORE_SET,
  GATEWAY_TOGGLE_KEY_HINTS,
} from '../../utils/gatewayPayload';
import { applyStaleOfflineConnectStatus, isDeviceVisuallyOnline } from '../../utils/deviceConnectionStatus';
import { SYSCOM_REALTIME_TELEMETRY } from '../../constants/realtimeEvents';
import WidgetEditModal from './WidgetEditModal';
import ValueIndicator from './ValueIndicator';
import { normalizeIndicatorType } from './valueIndicatorUtils';
import {
  DASH_WIDGET,
  loadAllWidgetConfigs,
  saveWidgetConfig,
  widgetStorageKey,
  parseRelativeTime,
  loadDashboardVisibility,
  saveDashboardVisibility,
  getDashboardWidgetMenuEntries,
  colorForValueInRanges,
  dashboardWidgetIdFromStorageKey,
  mergeWidgetConfig,
  dashboardWidgetSensorStub,
  normalizeDownlinkHex,
  normalizeStreamSeriesConfig,
} from './widgetConfigUtils';
import './BudgetSensorsDashboard.css';

const BUDGETS = { 2025: 3800, 2026: 4050, 2027: 4350, 2028: 4700 };
const KPIS = { 2025: 98, 2026: 105, 2027: 112, 2028: 118 };

const IGNORE = new Set([...PROPERTY_INFER_IGNORE_SET]);

/** Refresco de telemetría en widgets del panel / dispositivo (downlinks y datos en vivo). */
const WIDGET_LIVE_REFRESH_MS = 5000;

const DEFAULT_SENSORS = [
  { id: 1, name: 'Temperatura', value: 23.5, unit: '°C', icon: '🌡️', threshold: 30, propertyKey: 'temperature', sourceDeviceId: 'demo' },
  { id: 2, name: 'Humedad', value: 65, unit: '%', icon: '💧', threshold: 80, propertyKey: 'humidity', sourceDeviceId: 'demo' },
  { id: 3, name: 'Presión', value: 1013, unit: 'hPa', icon: '📊', threshold: 1020, propertyKey: 'pressure', sourceDeviceId: 'demo' },
  { id: 4, name: 'Calidad Aire', value: 42, unit: 'AQI', icon: '🌫️', threshold: 100, propertyKey: 'aqi', sourceDeviceId: 'demo' },
];

const SOURCES_DATA = { Engagement: 85, Project: 72, Workflow: 68, Collaboration: 79 };

/** Rangos del widget Real-Time Streaming: consulta telemetría en SQLite vía API. */
const STREAM_TIME_PRESETS = [
  { id: 'live', label: 'En vivo', ms: null },
  { id: '15m', label: '15 min', ms: 15 * 60 * 1000 },
  { id: '1h', label: '1 h', ms: 60 * 60 * 1000 },
  { id: '1d', label: '1 día', ms: 24 * 60 * 60 * 1000 },
  { id: '1w', label: '1 sem', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '1mo', label: '1 mes', ms: 30 * 24 * 60 * 60 * 1000 },
];

const STREAM_CHART_MAX_POINTS = 140;

function downsampleStreamPoints(points, maxPts = STREAM_CHART_MAX_POINTS) {
  if (!points.length || points.length <= maxPts) return points;
  const step = (points.length - 1) / (maxPts - 1);
  const out = [];
  for (let i = 0; i < maxPts; i++) {
    const idx = Math.min(points.length - 1, Math.round(i * step));
    out.push(points[idx]);
  }
  return out;
}

function formatStreamChartLabel(tsMs, presetId) {
  const d = new Date(tsMs);
  if (!Number.isFinite(d.getTime())) return '';
  if (presetId === '15m' || presetId === '1h') {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (presetId === '1d') {
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function streamHexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ''));
  if (!m) return `rgba(6, 182, 212, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

function applyDeltaHistoryPoints(points) {
  if (!points.length) return [];
  return points.map((p, i) => ({
    ts: p.ts,
    val: i === 0 ? 0 : p.val - points[i - 1].val,
  }));
}

function nearestPointValue(points, tMs) {
  if (!points.length) return null;
  let best = points[0].val;
  let bestD = Math.abs(points[0].ts - tMs);
  for (let i = 1; i < points.length; i++) {
    const d = Math.abs(points[i].ts - tMs);
    if (d < bestD) {
      bestD = d;
      best = points[i].val;
    }
  }
  return best;
}

function buildStreamChartDatasets(seriesList) {
  return seriesList.map((s) => {
    const bar = s.chartType === 'bar';
    const fill = s.chartType === 'area';
    const stepped = s.interpolation === 'step';
    return {
      type: bar ? 'bar' : 'line',
      label: s.label,
      data: [],
      borderColor: s.color,
      backgroundColor: streamHexToRgba(s.color, fill ? 0.22 : 0.06),
      fill,
      tension: stepped ? 0 : 0.35,
      stepped: stepped ? 'before' : false,
      yAxisID: s.yAxis === 'y2' ? 'y2' : 'y',
      order: bar ? 2 : 1,
      pointRadius: 2,
      pointBackgroundColor: s.color,
    };
  });
}

function applyStreamingHistoryChartMulti(chart, seriesPrepared, presetId) {
  if (!chart || !seriesPrepared.length) return;
  const n = Math.min(seriesPrepared.length, chart.data.datasets.length);
  if (!seriesPrepared[0].points.length) {
    chart.data.labels = [];
    for (let i = 0; i < chart.data.datasets.length; i++) chart.data.datasets[i].data = [];
    chart.options.scales.y.min = undefined;
    chart.options.scales.y.max = undefined;
    if (chart.options.scales.y2) {
      chart.options.scales.y2.min = undefined;
      chart.options.scales.y2.max = undefined;
    }
    chart.update();
    return;
  }
  const primary = seriesPrepared[0].points;
  const sampledPrimary = downsampleStreamPoints(primary);
  const labelTs = sampledPrimary.map((p) => p.ts);
  chart.data.labels = labelTs.map((ts) => formatStreamChartLabel(ts, presetId));

  const y1Vals = [];
  const y2Vals = [];
  for (let i = 0; i < n; i++) {
    const sp = seriesPrepared[i];
    const vals = labelTs.map((t) => nearestPointValue(sp.points, t));
    chart.data.datasets[i].data = vals;
    vals.forEach((v) => {
      if (v == null || !Number.isFinite(v)) return;
      if (sp.meta.yAxis === 'y2') y2Vals.push(v);
      else y1Vals.push(v);
    });
  }
  for (let i = n; i < chart.data.datasets.length; i++) chart.data.datasets[i].data = [];

  const applyAxis = (vals, scaleKey) => {
    if (!vals.length) {
      chart.options.scales[scaleKey].min = undefined;
      chart.options.scales[scaleKey].max = undefined;
      return;
    }
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = hi - lo;
    const pad = span > 0 ? span * 0.12 : Math.abs(hi || 1) * 0.08 || 1;
    chart.options.scales[scaleKey].min = lo - pad;
    chart.options.scales[scaleKey].max = hi + pad;
  };
  applyAxis(y1Vals, 'y');
  if (chart.options.scales.y2) {
    if (y2Vals.length) applyAxis(y2Vals, 'y2');
    else {
      chart.options.scales.y2.min = undefined;
      chart.options.scales.y2.max = undefined;
    }
  }
  chart.update();
}

function clearStreamingChart(chart) {
  if (!chart) return;
  chart.data.labels = [];
  chart.data.datasets.forEach((ds) => {
    ds.data = [];
  });
  chart.options.scales.y.min = undefined;
  chart.options.scales.y.max = undefined;
  if (chart.options.scales.y2) {
    chart.options.scales.y2.min = undefined;
    chart.options.scales.y2.max = undefined;
  }
  chart.update();
}

function initStreamingMultiState(len) {
  return {
    buffers: Array.from({ length: len }, () => []),
    lastRaw: Array(len).fill(null),
  };
}

function inferIcon(key) {
  const k = String(key).toLowerCase();
  if (k.includes('button_event')) return '🔘';
  if (k.includes('gpio')) return '🔌';
  if (k.startsWith('modbus_chn')) return '📟';
  if (k.startsWith('adc_')) return '⚡';
  if (k.startsWith('adv_')) return '🔋';
  if (k.startsWith('pt100')) return '🌡️';
  if (k.includes('temp')) return '🌡️';
  if (k.includes('humid')) return '💧';
  if (k.includes('press')) return '📊';
  if (k.includes('air') || k.includes('co2') || k.includes('aqi')) return '🌫️';
  if (k.includes('electric') || k.includes('battery')) return '🔋';
  if (k.includes('rssi') || k.includes('signal')) return '📶';
  return '📟';
}

function inferUnit(key) {
  const k = String(key).toLowerCase();
  if (k.startsWith('pt100')) return '°C';
  if (k.startsWith('adc_')) return 'mA';
  if (k.startsWith('adv_')) return 'V';
  if (k.startsWith('gpio_')) return '';
  if (k.includes('temp')) return '°C';
  if (k.includes('humid')) return '%';
  if (k.includes('electric') || k.includes('battery')) return '%';
  if (k.includes('rssi')) return 'dBm';
  if (k.includes('press')) return 'hPa';
  return '';
}

function inferThreshold(key) {
  const k = String(key).toLowerCase();
  if (k.includes('button_event')) return 2;
  if (k.includes('temp') || k.startsWith('pt100')) return 30;
  if (k.includes('humid')) return 80;
  if (k.includes('press')) return 1020;
  if (k.includes('aqi') || k.includes('air')) return 100;
  if (k.includes('electric') || k.includes('battery')) return 20;
  if (k.startsWith('adc_')) return 20;
  return 100;
}

function parseNumeric(val) {
  return parseTelemetryScalar(val);
}

function propertiesToSensors(obj, startId = 1, namePrefix = '', sourceDeviceId = null) {
  if (!obj || typeof obj !== 'object') return [];
  const flat = expandNestedGatewayTelemetry(obj);
  const out = [];
  let id = startId;
  for (const [key, raw] of Object.entries(flat)) {
    if (IGNORE.has(key)) continue;
    if (String(key).endsWith('_alarm')) continue;
    const v = parseNumeric(raw);
    if (v === null) continue;
    const label = key.replace(/_/g, ' ');
    const base = label.charAt(0).toUpperCase() + label.slice(1);
    out.push({
      id: id++,
      name: namePrefix ? `${namePrefix}: ${base}` : base,
      value: v,
      unit: inferUnit(key),
      icon: inferIcon(key),
      threshold: inferThreshold(key),
      propertyKey: key,
      sourceDeviceId: sourceDeviceId != null ? String(sourceDeviceId) : null,
    });
  }
  return out;
}

function updateSensorStatus(sensor, valueOverride) {
  const v =
    valueOverride != null && Number.isFinite(Number(valueOverride)) ? Number(valueOverride) : sensor.value;
  if (v > sensor.threshold * 1.2) return 'critical';
  if (v > sensor.threshold) return 'warning';
  return 'normal';
}

function normalizeId(v) {
  return v === undefined || v === null ? '' : String(v).trim().toLowerCase();
}

function findLocalEntry(device, latestData) {
  if (!device || !Array.isArray(latestData)) return null;
  const candidates = new Set(
    [
      normalizeId(device.deviceId),
      normalizeId(device.sn),
      normalizeId(device.devEUI),
      normalizeId(device.devEui),
      normalizeId(device.name),
    ].filter(Boolean)
  );
  return (
    latestData.find((entry) => {
      const ec = [
        normalizeId(entry.deviceId),
        normalizeId(entry.deviceName),
        normalizeId(entry.properties?.deviceId),
        normalizeId(entry.properties?.deviceName),
        normalizeId(entry.properties?.sn),
        normalizeId(entry.properties?.devEUI),
      ];
      return ec.some((c) => c && candidates.has(c));
    }) || null
  );
}

function buildPanelSensors(devices, latestData) {
  const list = [];
  let nextId = 1;
  for (const dev of devices.slice(0, 6)) {
    const entry = findLocalEntry(dev, latestData || []);
    const props = entry?.properties || {};
    const prefix = dev.name || dev.sn || String(dev.deviceId || '').slice(0, 8);
    const chunk = propertiesToSensors(props, nextId, prefix, dev.deviceId);
    for (const s of chunk) {
      list.push(s);
      if (list.length >= 8) return list;
    }
    nextId += chunk.length + 1;
  }
  return list.length > 0 ? list : DEFAULT_SENSORS.map((s, i) => ({ ...s, id: i + 1 }));
}

const TOGGLE_KEY_HINTS = [
  ...GATEWAY_TOGGLE_KEY_HINTS,
  'relay',
  'output',
  'switch',
  'valve',
  'pump',
  'power',
  'led',
  'socket',
  'digitalOutput',
  'relay1',
  'relay_1',
  'do1',
];

const EMERGENCY_KEYS = [
  'emergency',
  'panic',
  'alarm',
  'sos',
  'botonEmergencia',
  'emergencyButton',
  'buttonEmergency',
  'emergencia',
];

const IMAGE_PROP_KEYS = ['imageUrl', 'image', 'photo', 'picture', 'snapshot', 'cam', 'thumbnail', 'urlImagen'];

function pickToggleKey(props) {
  if (!props || typeof props !== 'object') return null;
  for (const k of TOGGLE_KEY_HINTS) {
    if (Object.prototype.hasOwnProperty.call(props, k) && props[k] != null && props[k] !== '') return k;
  }
  for (const k of Object.keys(props)) {
    if (IGNORE.has(k)) continue;
    const v = props[k];
    if (typeof v === 'boolean') return k;
    if (v === 0 || v === 1 || v === '0' || v === '1') return k;
    if (typeof v === 'string' && parseTelemetryBoolish(v) !== null) return k;
  }
  return null;
}

function pickEmergencyRaw(props) {
  if (!props) return undefined;
  for (const k of EMERGENCY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(props, k)) return props[k];
  }
  return undefined;
}

function pickImageUrl(props) {
  if (!props) return null;
  for (const k of IMAGE_PROP_KEYS) {
    const v = props[k];
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  for (const v of Object.values(props)) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim()) && v.trim().length < 2048) return v.trim();
  }
  return null;
}

function toFloatCoord(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(String(v).replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** @returns {{ lat: number; lng: number } | null} */
function pickMapCoordinates(props) {
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

function openStreetMapEmbedUrl(lat, lng) {
  const pad = 0.04;
  const minLon = lng - pad;
  const minLat = lat - pad;
  const maxLon = lng + pad;
  const maxLat = lat + pad;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(`${minLon},${minLat},${maxLon},${maxLat}`)}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lng}`)}`;
}

/** Coordenadas fijas guardadas en config del widget Mapa o telemetría. */
function resolveMapCoords(liveProps, mapCfg) {
  const lat =
    toFloatCoord(mapCfg?.data?.savedLatitude) ?? toFloatCoord(mapCfg?.data?.savedLat);
  const lng =
    toFloatCoord(mapCfg?.data?.savedLongitude) ?? toFloatCoord(mapCfg?.data?.savedLng);
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
  return pickMapCoordinates(liveProps);
}

/** Imagen subida (data URL) o URL en telemetría. */
function resolveImageDisplayUrl(liveProps, imageCfg) {
  const u = imageCfg?.data?.uploadedImageDataUrl;
  if (typeof u === 'string' && u.startsWith('data:image/')) return u;
  return pickImageUrl(liveProps);
}

function normalizeTelemetryList(rows) {
  if (Array.isArray(rows)) return rows;
  if (rows && Array.isArray(rows.data)) return rows.data;
  if (rows && Array.isArray(rows.records)) return rows.records;
  return [];
}

function telemetryValuePoints(rows, field) {
  const list = normalizeTelemetryList(rows);
  const out = [];
  for (const r of list) {
    const tsRaw = r.timestamp ?? r.ts ?? r.time;
    const ts =
      typeof tsRaw === 'number'
        ? tsRaw
        : tsRaw != null
          ? new Date(tsRaw).getTime()
          : NaN;
    const props = r.properties && typeof r.properties === 'object' ? r.properties : r;
    const val = parseNumeric(props?.[field]);
    if (val === null || !Number.isFinite(ts)) continue;
    out.push({ ts, val });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function bucketKeyUtc(tsMs, granularity) {
  const d = new Date(tsMs);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  if (granularity === 'minute') return `${y}-${mo}-${day}-${h}-${mi}`;
  if (granularity === 'hour') return `${y}-${mo}-${day}-${h}`;
  if (granularity === 'day') return `${y}-${mo}-${day}`;
  if (granularity === 'month') return `${y}-${mo}`;
  if (granularity === 'year') return `${y}`;
  return null;
}

function aggregateHistoryFromPoints(points, granularity, op) {
  if (!points.length) return { aggregate: null, series: [] };
  const applyOp = (vals) => {
    if (op === 'min') return Math.min(...vals);
    if (op === 'max') return Math.max(...vals);
    if (op === 'sum') return vals.reduce((a, b) => a + b, 0);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  if (!granularity) {
    const vals = points.map((p) => p.val);
    return { aggregate: applyOp(vals), series: [] };
  }
  const map = new Map();
  for (const p of points) {
    const k = bucketKeyUtc(p.ts, granularity);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(p.val);
  }
  const keys = [...map.keys()].sort();
  const series = keys.map((k) => applyOp(map.get(k)));
  const maxPts = 72;
  const trimmed = series.length > maxPts ? series.slice(-maxPts) : series;
  const aggregate = trimmed.length ? trimmed[trimmed.length - 1] : null;
  return { aggregate, series: trimmed };
}

function loadDownlinksFromStorage(deviceId) {
  if (!deviceId) return [];
  try {
    const raw = localStorage.getItem(`downlinks_${deviceId}`);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((d) => d && d.name && d.hex) : [];
  } catch {
    return [];
  }
}

function coalesceMaxSeenMs(...vals) {
  const ms = vals
    .filter((x) => x != null)
    .map((x) => (typeof x === 'number' ? x : new Date(x).getTime()))
    .filter((n) => Number.isFinite(n));
  return ms.length ? Math.max(...ms) : null;
}

async function mergeDeviceLive(dev, credentials, token) {
  if (!dev?.deviceId) return {};
  try {
    const [propsResp, latest] = await Promise.all([
      fetchDeviceProperties(dev.deviceId, credentials, token),
      getLatestDeviceData(),
    ]);
    const apiData = propsResp.data?.data || {};
    const liveFromAPI = apiData.properties || propsResp.data?.properties || {};
    const entry = findLocalEntry(dev, latest || []);
    const liveFromLocal = entry?.properties || {};
    const lastSeen = coalesceMaxSeenMs(apiData.lastTimestamp, entry?.timestamp, dev.lastUpdateTime);
    let merged = { ...dev, ...liveFromAPI, ...liveFromLocal };
    if (lastSeen != null) merged = { ...merged, lastUpdateTime: lastSeen };
    return applyStaleOfflineConnectStatus(merged);
  } catch {
    return applyStaleOfflineConnectStatus({ ...dev });
  }
}

function downlinkErrorMessage(err) {
  const status = err.response?.status;
  const msg = err.response?.data?.errMsg || err.response?.data?.error || err.message || '';
  if (!navigator.onLine || msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch')) {
    return 'Error de conexión. Revisa tu red.';
  }
  if (status === 401 || msg.toLowerCase().includes('unauthorized')) return 'Sesión expirada. Vuelve a entrar.';
  if (status === 404 || msg.toLowerCase().includes('not found')) return 'Dispositivo no encontrado o sin downlink.';
  if (msg.toLowerCase().includes('offline') || msg.toLowerCase().includes('desconect')) return 'Dispositivo fuera de línea.';
  if (msg.toLowerCase().includes('hex') || msg.toLowerCase().includes('invalid')) return 'Comando inválido.';
  if (status === 501) return 'Downlink no disponible en este modo.';
  return msg || 'Error al enviar comando.';
}

const INITIAL_ALERTS = [
  {
    id: 1,
    type: 'warning',
    title: 'Sensor de temperatura elevado',
    description: 'Sala de servidores',
    value: '38°C / 35°C',
    icon: '🌡️',
    timestamp: 'Hace 5 min',
  },
  {
    id: 2,
    type: 'info',
    title: 'Mantenimiento programado',
    description: 'Actualización del sistema',
    value: '2 horas',
    icon: '🔧',
    timestamp: 'Hace 15 min',
  },
];

/**
 * @param {{ variant?: 'panel' | 'device', device?: object | null, embedded?: boolean, loadingExternal?: boolean, onRefresh?: () => void, refreshing?: boolean }} props
 */
export default function BudgetSensorsDashboard({
  variant = 'panel',
  device = null,
  embedded = false,
  loadingExternal = false,
  onRefresh,
  refreshing = false,
}) {
  const { credentials, token, isAdmin, canEditDashboard } = useAuth();
  const { t } = useLanguage();
  const gradId = useId().replace(/:/g, '');

  const [panelLoading, setPanelLoading] = useState(variant === 'panel');
  const [activeYear, setActiveYear] = useState('2026');
  const [tasksCompleted] = useState(63);
  const [tasksPlan] = useState(60);
  const [satisfactionPct, setSatisfactionPct] = useState(83);
  const [sensors, setSensors] = useState(DEFAULT_SENSORS);
  const [alerts, setAlerts] = useState(INITIAL_ALERTS);

  const addWidgetDetailsRef = useRef(null);
  const burndownRef = useRef(null);
  const taskStatusRef = useRef(null);
  const streamingRef = useRef(null);
  const satisfactionArcRef = useRef(null);
  const burndownChartRef = useRef(null);
  const taskStatusChartRef = useRef(null);
  const streamingChartRef = useRef(null);
  const streamingMultiRef = useRef(initStreamingMultiState(1));
  const lastStreamRef = useRef(23.5);
  const sensorsRef = useRef(sensors);
  const [streamDisplay, setStreamDisplay] = useState(23.5);
  const [streamTimePreset, setStreamTimePreset] = useState('live');
  const [streamHistoryLoading, setStreamHistoryLoading] = useState(false);
  const [streamHistoryError, setStreamHistoryError] = useState(null);
  const [streamHistoryFetchedAt, setStreamHistoryFetchedAt] = useState(null);

  const [panelDevices, setPanelDevices] = useState([]);
  const panelDevicesRef = useRef(panelDevices);
  /** Refrescos puntuales vía SSE (sin esperar al intervalo). */
  const deviceLiveTickRef = useRef(() => Promise.resolve());
  const panelListTickRef = useRef(() => Promise.resolve());
  const [controlDeviceId, setControlDeviceId] = useState(null);
  const [liveProps, setLiveProps] = useState({});
  const telemetryLiveProps = useMemo(() => {
    if (!liveProps || typeof liveProps !== 'object' || Array.isArray(liveProps)) return {};
    return expandNestedGatewayTelemetry(liveProps);
  }, [liveProps]);
  const [downlinkList, setDownlinkList] = useState([]);
  const [switchProcessing, setSwitchProcessing] = useState(false);
  const [downlinkWidgetBusy, setDownlinkWidgetBusy] = useState(false);

  useEffect(() => {
    panelDevicesRef.current = panelDevices;
  }, [panelDevices]);

  const [widgetConfigs, setWidgetConfigs] = useState(() => loadAllWidgetConfigs());
  const [editModalCtx, setEditModalCtx] = useState(null);
  /** Incrementa al abrir el modal para remount limpio (evita reset vía useEffect y cumple reglas de hooks). */
  const [widgetEditSession, setWidgetEditSession] = useState(0);
  const openWidgetEditModal = useCallback((ctx) => {
    setWidgetEditSession((n) => n + 1);
    setEditModalCtx(ctx);
  }, []);
  const [aggregateByKey, setAggregateByKey] = useState({});
  const [dashboardEditMode, setDashboardEditMode] = useState(false);
  const dashboardLayoutLocked = !canEditDashboard || !dashboardEditMode;
  const [visibilityMap, setVisibilityMap] = useState(() => loadDashboardVisibility(variant));
  const [aggregateSeriesByKey, setAggregateSeriesByKey] = useState({});
  const [mapPinLat, setMapPinLat] = useState('');
  const [mapPinLng, setMapPinLng] = useState('');
  /** Tarjetas de sensor ocultas solo en la vista (no borran telemetría). */
  const [hiddenSensorCardKeys, setHiddenSensorCardKeys] = useState(() => new Set());

  const streamSeriesNormalized = useMemo(
    () => normalizeStreamSeriesConfig(widgetConfigs[widgetStorageKey(variant, 'dashboard', DASH_WIDGET.STREAM)]?.data),
    [widgetConfigs, variant]
  );
  const streamSeriesChartKey = useMemo(
    () =>
      JSON.stringify(
        streamSeriesNormalized.map((s) => [s.fieldKey, s.chartType, s.color, s.yAxis, s.interpolation, s.valueMode, s.label])
      ),
    [streamSeriesNormalized]
  );

  useEffect(() => {
    setVisibilityMap(loadDashboardVisibility(variant));
  }, [variant]);

  useEffect(() => {
    setHiddenSensorCardKeys(new Set());
  }, [variant, variant === 'device' ? device?.deviceId : controlDeviceId]);

  useEffect(() => {
    if (!canEditDashboard) {
      setDashboardEditMode(false);
      setEditModalCtx(null);
    }
  }, [canEditDashboard]);

  useEffect(() => {
    sensorsRef.current = sensors;
  }, [sensors]);

  const configKeyForSensor = useCallback(
    (s) => widgetStorageKey(variant, s.sourceDeviceId || 'demo', s.propertyKey),
    [variant]
  );

  const getWidgetConfig = useCallback(
    (s) => {
      const k = configKeyForSensor(s);
      return widgetConfigs[k] || null;
    },
    [widgetConfigs, configKeyForSensor]
  );

  const getDisplayValue = useCallback(
    (s) => {
      const cfg = getWidgetConfig(s);
      const pk = s.propertyKey;
      const field = cfg?.data?.fieldKey || pk;
      const sid = s.sourceDeviceId;
      if (
        cfg?.timeframe?.mode === 'interval' &&
        cfg.timeframe?.operation &&
        sid &&
        sid !== 'demo'
      ) {
        const ak = `${sid}|${pk}`;
        const agg = aggregateByKey[ak];
        if (agg != null && Number.isFinite(agg)) return agg;
      }
      const eff = variant === 'device' ? device?.deviceId : controlDeviceId;
      if (
        sid &&
        sid !== 'demo' &&
        eff != null &&
        String(sid) === String(eff) &&
        telemetryLiveProps &&
        typeof telemetryLiveProps === 'object'
      ) {
        const alt = parseNumeric(telemetryLiveProps[field]);
        if (alt != null) return alt;
      }
      return s.value;
    },
    [getWidgetConfig, aggregateByKey, telemetryLiveProps, variant, device, controlDeviceId]
  );

  const isVis = useCallback((id) => visibilityMap[id] !== false, [visibilityMap]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      const nextSeries = {};
      for (const s of sensors) {
        const sid = s.sourceDeviceId;
        const pk = s.propertyKey;
        const ak = `${sid}|${pk}`;
        const cfg = widgetConfigs[configKeyForSensor(s)];
        if (!sid || sid === 'demo' || !cfg || cfg.timeframe?.mode !== 'interval' || !cfg.timeframe?.operation) {
          continue;
        }
        const now = Date.now();
        const fromMs = parseRelativeTime(cfg.timeframe.from, now, 'from') ?? now - 86400000;
        const toMs = parseRelativeTime(cfg.timeframe.to, now, 'to') ?? now;
        try {
          const rows = await queryTelemetry(sid, pk, fromMs, toMs);
          const field = cfg.data?.fieldKey || pk;
          const points = telemetryValuePoints(rows, field);
          if (!points.length) {
            next[ak] = null;
            nextSeries[ak] = [];
            continue;
          }
          const op = cfg.timeframe.operation;
          const gran = cfg.timeframe.granularity || '';
          const { aggregate, series } = aggregateHistoryFromPoints(points, gran, op);
          next[ak] = aggregate;
          nextSeries[ak] = series;
        } catch {
          next[ak] = null;
          nextSeries[ak] = [];
        }
      }
      if (!cancelled) {
        setAggregateByKey(next);
        setAggregateSeriesByKey(nextSeries);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sensors, widgetConfigs, configKeyForSensor]);

  const donutBurndown = useMemo(() => {
    const normal = sensors.filter((s) => updateSensorStatus(s) === 'normal').length;
    const warn = sensors.filter((s) => updateSensorStatus(s) === 'warning').length;
    const crit = sensors.filter((s) => updateSensorStatus(s) === 'critical').length;
    const total = normal + warn + crit;
    if (total === 0) return { completed: 63, pending: 61, added: 37 };
    return { completed: normal, pending: warn, added: Math.max(crit, 1) };
  }, [sensors]);

  const taskStatusPercents = useMemo(() => {
    const { completed, pending, added } = donutBurndown;
    const t = completed + pending + added;
    if (!t) return [23, 56, 21];
    return [
      Math.round((completed / t) * 100),
      Math.round((pending / t) * 100),
      100 - Math.round((completed / t) * 100) - Math.round((pending / t) * 100),
    ];
  }, [donutBurndown]);

  useEffect(() => {
    if (variant !== 'panel') return;
    let cancelled = false;
    (async () => {
      setPanelLoading(true);
      try {
        const [resp, latest] = await Promise.all([fetchDevices(credentials, token), getLatestDeviceData()]);
        if (cancelled) return;
        const rawList = resp.data?.data?.content || resp.data?.content || [];
        const deviceList = rawList.map((d) => applyStaleOfflineConnectStatus(d));
        setPanelDevices(deviceList);
        const savedPanelDev = localStorage.getItem('bsd_panel_control_device');
        const initialControl =
          savedPanelDev && deviceList.some((d) => String(d.deviceId) === String(savedPanelDev))
            ? String(savedPanelDev)
            : deviceList[0]?.deviceId != null
              ? String(deviceList[0].deviceId)
              : null;
        setControlDeviceId(initialControl);
        const built = buildPanelSensors(deviceList, latest || []);
        setSensors(built.map((s) => ({ ...s })));
        const online = deviceList.filter((d) => isDeviceVisuallyOnline(d)).length;
        const sat = deviceList.length ? Math.round((online / deviceList.length) * 100) : 83;
        setSatisfactionPct(Math.min(100, Math.max(0, sat)));
      } catch (e) {
        console.warn('[BudgetSensorsDashboard] panel load', e);
        setPanelDevices([]);
        setControlDeviceId(null);
        setSensors(DEFAULT_SENSORS.map((s, i) => ({ ...s, id: i + 1 })));
      } finally {
        if (!cancelled) setPanelLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [variant, credentials, token]);

  useEffect(() => {
    if (variant !== 'device' || !device) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const merged = await mergeDeviceLive(device, credentials, token);
        if (cancelled) return;
        const built = propertiesToSensors(merged, 1, '', String(device.deviceId));
        setSensors(built.length ? built : DEFAULT_SENSORS.map((s, i) => ({ ...s, id: i + 1 })));
        const online = isDeviceVisuallyOnline(merged);
        setSatisfactionPct(online ? 100 : 0);
        setLiveProps(merged);
        setDownlinkList(loadDownlinksFromStorage(device.deviceId));
      } catch (e) {
        console.warn('[BudgetSensorsDashboard] device load', e);
        if (cancelled) return;
        const merged = { ...device };
        const built = propertiesToSensors(merged, 1, '', String(device.deviceId));
        setSensors(built.length ? built : DEFAULT_SENSORS.map((s, i) => ({ ...s, id: i + 1 })));
        setLiveProps(merged);
        setDownlinkList(loadDownlinksFromStorage(device.deviceId));
      }
    };
    deviceLiveTickRef.current = tick;
    tick();
    const id = setInterval(tick, WIDGET_LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [variant, device, credentials, token]);

  useEffect(() => {
    if (variant !== 'panel' || panelLoading) return;
    if (!controlDeviceId) {
      setLiveProps({});
      setDownlinkList([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const list = panelDevicesRef.current || [];
      const dev = list.find((d) => String(d.deviceId) === String(controlDeviceId));
      if (!dev) return;
      const merged = await mergeDeviceLive(dev, credentials, token);
      if (cancelled) return;
      setLiveProps(merged);
      setDownlinkList(loadDownlinksFromStorage(controlDeviceId));
    };
    tick();
    const id = setInterval(tick, WIDGET_LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [variant, panelLoading, controlDeviceId, credentials, token]);

  /** Lista del panel + sensores agregados: misma cadencia que los widgets en vivo. */
  useEffect(() => {
    if (variant !== 'panel' || panelLoading) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [resp, latest] = await Promise.all([fetchDevices(credentials, token), getLatestDeviceData()]);
        if (cancelled) return;
        const deviceList = (resp.data?.data?.content || resp.data?.content || []).map((d) =>
          applyStaleOfflineConnectStatus(d)
        );
        setPanelDevices(deviceList);
        const online = deviceList.filter((d) => isDeviceVisuallyOnline(d)).length;
        const sat = deviceList.length ? Math.round((online / deviceList.length) * 100) : 83;
        setSatisfactionPct(Math.min(100, Math.max(0, sat)));
        const built = buildPanelSensors(deviceList, latest || []);
        setSensors(built.map((s) => ({ ...s })));
      } catch (e) {
        console.warn('[BudgetSensorsDashboard] panel refresh tick', e);
      }
    };
    panelListTickRef.current = tick;
    const id = setInterval(tick, WIDGET_LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [variant, panelLoading, credentials, token]);

  useEffect(() => {
    const onTel = (e) => {
      const id = e.detail?.deviceId;
      if (variant === 'device' && device && id != null && String(id) === String(device.deviceId)) {
        deviceLiveTickRef.current();
      }
      if (variant === 'panel' && !panelLoading) {
        panelListTickRef.current();
      }
    };
    window.addEventListener(SYSCOM_REALTIME_TELEMETRY, onTel);
    return () => window.removeEventListener(SYSCOM_REALTIME_TELEMETRY, onTel);
  }, [variant, device, panelLoading]);

  /** Team Satisfaction: anillo y texto desde telemetría si hay campo configurado (no __bsd_*). */
  const satisfactionUi = useMemo(() => {
    const key = widgetStorageKey(variant, 'dashboard', DASH_WIDGET.SATISFACTION);
    const cfg = widgetConfigs[key];
    const fkRaw = cfg?.data?.fieldKey;
    const fkStr = fkRaw != null ? String(fkRaw).trim() : '';
    const useLive =
      Boolean(fkStr) &&
      !fkStr.startsWith('__bsd_') &&
      telemetryLiveProps &&
      typeof telemetryLiveProps === 'object' &&
      telemetryLiveProps[fkStr] !== undefined;
    const n = useLive ? parseNumeric(telemetryLiveProps[fkStr]) : null;

    if (n !== null && Number.isFinite(n)) {
      const decRaw = cfg?.data?.decimals;
      const dec =
        decRaw != null && decRaw !== '' && Number.isFinite(Number(decRaw))
          ? Math.min(20, Math.max(0, Number(decRaw)))
          : 2;
      const unit = cfg?.data?.unit != null ? String(cfg.data.unit) : '';
      const min = Number(cfg?.gauge?.scaleMin);
      const max = Number(cfg?.gauge?.scaleMax);
      const lo = Number.isFinite(min) ? min : 0;
      const hi = Number.isFinite(max) && max > lo ? max : lo + 100;
      const span = hi - lo;
      const t = span !== 0 ? (n - lo) / span : 0;
      const pct = Math.round(Math.min(100, Math.max(0, t * 100)));
      const label = `${n.toFixed(dec)}${unit ? ` ${unit}` : ''}`.trim();
      return { ringPct: pct, centerLabel: label, usesLiveField: true, rawValue: n };
    }

    const fallback = satisfactionPct;
    return {
      ringPct: fallback,
      centerLabel: `${fallback}%`,
      usesLiveField: false,
      rawValue: null,
    };
  }, [widgetConfigs, variant, satisfactionPct, telemetryLiveProps]);

  useEffect(() => {
    const c = 439.8;
    const pct = satisfactionUi.ringPct;
    const offset = c - (pct / 100) * c;
    const el = satisfactionArcRef.current;
    if (el) el.style.strokeDashoffset = String(offset);
  }, [satisfactionUi.ringPct]);

  useEffect(() => {
    if (!burndownRef.current) return;
    const { completed, pending, added } = donutBurndown;
    if (burndownChartRef.current) burndownChartRef.current.destroy();
    burndownChartRef.current = new Chart(burndownRef.current, {
      type: 'doughnut',
      data: {
        labels: ['Completed', 'Pending', 'Added'],
        datasets: [
          {
            data: [completed, pending, added],
            backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
      },
    });
    return () => {
      if (burndownChartRef.current) {
        burndownChartRef.current.destroy();
        burndownChartRef.current = null;
      }
    };
  }, [donutBurndown]);

  useEffect(() => {
    if (!taskStatusRef.current) return;
    const [a, b, c] = taskStatusPercents;
    if (taskStatusChartRef.current) taskStatusChartRef.current.destroy();
    taskStatusChartRef.current = new Chart(taskStatusRef.current, {
      type: 'doughnut',
      data: {
        labels: ['Completed', 'Pending', 'Added'],
        datasets: [
          {
            data: [a, b, c],
            backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
      },
    });
    return () => {
      if (taskStatusChartRef.current) {
        taskStatusChartRef.current.destroy();
        taskStatusChartRef.current = null;
      }
    };
  }, [taskStatusPercents]);

  useEffect(() => {
    const tempLike = sensors.find((s) => String(s.propertyKey || s.name).toLowerCase().includes('temp')) || sensors[0];
    if (tempLike && typeof tempLike.value === 'number') {
      lastStreamRef.current = tempLike.value;
      setStreamDisplay(tempLike.value);
    }
  }, [sensors]);

  useEffect(() => {
    if (!streamingRef.current) return;
    if (streamingChartRef.current) streamingChartRef.current.destroy();
    const list = streamSeriesNormalized;
    const n = list.length;
    const showLegend = n > 1;
    const useY2 = list.some((s) => s.yAxis === 'y2');
    const datasets =
      n === 0
        ? [
            {
              type: 'line',
              label: '—',
              data: [],
              borderColor: 'rgba(99,102,241,0.35)',
              backgroundColor: 'transparent',
              fill: false,
              tension: 0.35,
              pointRadius: 0,
            },
          ]
        : buildStreamChartDatasets(list);
    streamingMultiRef.current = initStreamingMultiState(Math.max(n, 1));

    streamingChartRef.current = new Chart(streamingRef.current, {
      type: 'line',
      data: { labels: [], datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: showLegend,
            position: 'bottom',
            labels: { color: 'rgba(200,200,220,0.95)', boxWidth: 10, padding: 8, font: { size: 11 } },
          },
        },
        scales: {
          y: {
            min: 0,
            max: 50,
            grid: { color: 'rgba(99,102,241,0.1)' },
            ticks: { color: 'rgba(161,161,170,0.9)' },
          },
          ...(useY2
            ? {
                y2: {
                  position: 'right',
                  grid: { drawOnChartArea: false },
                  ticks: { color: 'rgba(161,161,170,0.85)' },
                },
              }
            : {}),
          x: { grid: { display: false }, ticks: { color: 'rgba(161,161,170,0.85)', maxRotation: 45 } },
        },
      },
    });
    return () => {
      if (streamingChartRef.current) {
        streamingChartRef.current.destroy();
        streamingChartRef.current = null;
      }
    };
  }, [streamSeriesChartKey]);

  const tickStreaming = useCallback(() => {
    const chart = streamingChartRef.current;
    const series = streamSeriesNormalized;
    const n = series.length || 1;
    const st = streamingMultiRef.current;
    if (st.buffers.length !== n) {
      streamingMultiRef.current = initStreamingMultiState(n);
    }
    const st2 = streamingMultiRef.current;

    for (let i = 0; i < n; i++) {
      const change = (Math.random() - 0.5) * 2;
      const buf = st2.buffers[i];
      const prev = buf.length ? buf[buf.length - 1] : lastStreamRef.current;
      let nv = Number.isFinite(prev) ? prev + change : 20 + change;
      nv = Math.min(45, Math.max(15, nv));
      buf.push(nv);
      if (buf.length > 20) buf.shift();
    }
    const b0 = st2.buffers[0];
    if (b0.length) {
      lastStreamRef.current = b0[b0.length - 1];
      setStreamDisplay(b0[b0.length - 1]);
    }

    if (chart && chart.data.datasets.length) {
      const maxLen = Math.max(...st2.buffers.map((b) => b.length), 0);
      chart.data.labels = [...Array(maxLen)].map((_, j) => `${j}`);
      const allVals = [];
      for (let i = 0; i < Math.min(n, chart.data.datasets.length); i++) {
        chart.data.datasets[i].data = [...st2.buffers[i]];
        st2.buffers[i].forEach((v) => {
          if (Number.isFinite(v)) allVals.push(v);
        });
      }
      if (allVals.length) {
        const lo = Math.min(...allVals);
        const hi = Math.max(...allVals);
        const span = hi - lo;
        const pad = span > 0 ? span * 0.15 : Math.abs(hi || 1) * 0.08 || 1;
        chart.options.scales.y.min = lo - pad;
        chart.options.scales.y.max = hi + pad;
      }
      chart.update();
    }

    setSensors((prev) => {
      const next = prev.map((s) => ({ ...s }));
      if (next.length === 0) return prev;
      const idx = Math.floor(Math.random() * next.length);
      const randomChange = (Math.random() - 0.5) * 2;
      const s = next[idx];
      next[idx] = {
        ...s,
        value: Math.max(0, Math.min(s.threshold * 1.5, s.value + randomChange)),
      };
      return next;
    });
  }, [streamSeriesNormalized]);

  const streamDeviceId = useMemo(() => {
    if (variant === 'device') return device?.deviceId != null ? String(device.deviceId) : null;
    return controlDeviceId != null ? String(controlDeviceId) : null;
  }, [variant, device?.deviceId, controlDeviceId]);

  useEffect(() => {
    if (streamTimePreset !== 'live') return undefined;
    const series = streamSeriesNormalized;
    const id = setInterval(() => {
      const chart = streamingChartRef.current;
      const n = series.length;
      if (!chart || !chart.data.datasets.length) return;

      let usedLive = false;
      if (n > 0 && telemetryLiveProps && typeof telemetryLiveProps === 'object') {
        let st = streamingMultiRef.current;
        if (st.buffers.length !== n) {
          streamingMultiRef.current = initStreamingMultiState(n);
          st = streamingMultiRef.current;
        }
        let any = false;
        for (let i = 0; i < n; i++) {
          const fk = series[i].fieldKey;
          if (telemetryLiveProps[fk] === undefined) continue;
          const raw = parseNumeric(telemetryLiveProps[fk]);
          if (raw == null || !Number.isFinite(raw)) continue;
          any = true;
          let val = raw;
          if (series[i].valueMode === 'delta') {
            const prev = st.lastRaw[i];
            st.lastRaw[i] = raw;
            val = prev == null ? 0 : raw - prev;
          }
          st.buffers[i].push(val);
          if (st.buffers[i].length > 20) st.buffers[i].shift();
        }
        if (any) {
          usedLive = true;
          const raw0 = parseNumeric(telemetryLiveProps[series[0].fieldKey]);
          const b0 = st.buffers[0];
          if (series[0].valueMode !== 'delta' && raw0 != null && Number.isFinite(raw0)) {
            lastStreamRef.current = raw0;
            setStreamDisplay(raw0);
          } else if (b0.length) {
            lastStreamRef.current = b0[b0.length - 1];
            setStreamDisplay(b0[b0.length - 1]);
          }
          const maxLen = Math.max(...st.buffers.map((b) => b.length), 0);
          chart.data.labels = [...Array(maxLen)].map((_, j) => `${j}`);
          const allVals = [];
          for (let i = 0; i < Math.min(n, chart.data.datasets.length); i++) {
            chart.data.datasets[i].data = [...st.buffers[i]];
            st.buffers[i].forEach((v) => {
              if (Number.isFinite(v)) allVals.push(v);
            });
          }
          if (allVals.length) {
            const lo = Math.min(...allVals);
            const hi = Math.max(...allVals);
            const span = hi - lo;
            const pad = span > 0 ? span * 0.15 : Math.abs(hi || 1) * 0.08 || 1;
            chart.options.scales.y.min = lo - pad;
            chart.options.scales.y.max = hi + pad;
          }
          chart.update('none');
        }
      }
      if (!usedLive) tickStreaming();
    }, WIDGET_LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [streamTimePreset, tickStreaming, streamSeriesNormalized, telemetryLiveProps]);

  /** Al volver a «En vivo», restaurar el gráfico desde el buffer local. */
  useEffect(() => {
    if (streamTimePreset !== 'live') return undefined;
    setStreamHistoryLoading(false);
    setStreamHistoryError(null);
    const chart = streamingChartRef.current;
    if (!chart) return undefined;
    const series = streamSeriesNormalized;
    const n = series.length;
    const st = streamingMultiRef.current;
    if (n === 0) {
      clearStreamingChart(chart);
      return undefined;
    }
    if (st.buffers.length !== n) {
      streamingMultiRef.current = initStreamingMultiState(n);
    }
    const st2 = streamingMultiRef.current;
    const maxLen = Math.max(...st2.buffers.map((b) => b.length), 0);
    if (maxLen) {
      chart.data.labels = [...Array(maxLen)].map((_, i) => `${i}`);
      const allVals = [];
      for (let i = 0; i < Math.min(n, chart.data.datasets.length); i++) {
        chart.data.datasets[i].data = [...st2.buffers[i]];
        st2.buffers[i].forEach((v) => {
          if (Number.isFinite(v)) allVals.push(v);
        });
      }
      if (allVals.length) {
        const lo = Math.min(...allVals);
        const hi = Math.max(...allVals);
        const span = hi - lo;
        const pad = span > 0 ? span * 0.15 : Math.abs(hi || 1) * 0.08 || 1;
        chart.options.scales.y.min = lo - pad;
        chart.options.scales.y.max = hi + pad;
      }
    } else {
      chart.data.labels = [];
      for (let i = 0; i < chart.data.datasets.length; i++) chart.data.datasets[i].data = [];
      chart.options.scales.y.min = 0;
      chart.options.scales.y.max = 50;
    }
    chart.update('none');
    return undefined;
  }, [streamTimePreset, streamSeriesChartKey]);

  /** Rangos históricos: telemetría local y, si hace falta, historial en API. */
  useEffect(() => {
    if (streamTimePreset === 'live') return undefined;

    let cancelled = false;
    const preset = STREAM_TIME_PRESETS.find((p) => p.id === streamTimePreset);
    const windowMs = preset?.ms ?? 0;
    const now = Date.now();
    const startMs = now - windowMs;
    const endMs = now;
    const series = streamSeriesNormalized;

    (async () => {
      setStreamHistoryLoading(true);
      setStreamHistoryError(null);
      setStreamHistoryFetchedAt(null);

      if (!streamDeviceId) {
        if (!cancelled) {
          setStreamHistoryLoading(false);
          setStreamHistoryError('Selecciona un dispositivo en el panel para ver el historial.');
          clearStreamingChart(streamingChartRef.current);
        }
        return;
      }

      if (!series.length) {
        if (!cancelled) {
          setStreamHistoryLoading(false);
          setStreamHistoryError('Añade al menos una serie en «Editar widget» → Datos.');
          clearStreamingChart(streamingChartRef.current);
        }
        return;
      }

      try {
        const uniqueKeys = [...new Set(series.map((s) => s.fieldKey))];
        let sharedRows = [];
        for (const key of uniqueKeys) {
          try {
            const local = await queryTelemetry(streamDeviceId, key, startMs, endMs);
            if (Array.isArray(local) && local.length) {
              sharedRows = local;
              break;
            }
          } catch (e) {
            console.warn('[BSD stream] queryTelemetry', e);
          }
        }

        if (!cancelled && sharedRows.length === 0) {
          try {
            const resp = await fetchDeviceHistory(
              streamDeviceId,
              { startTime: startMs, endTime: endMs, pageSize: 800 },
              credentials,
              token
            );
            const list = resp.list || resp.data?.list || [];
            sharedRows = list.map((item) => ({
              ts: item.ts,
              timestamp: item.timestamp,
              properties: item.properties,
            }));
          } catch (e2) {
            console.warn('[BSD stream] fetchDeviceHistory', e2);
          }
        }

        if (cancelled) return;

        const seriesPrepared = series.map((meta) => {
          let points = telemetryValuePoints(sharedRows, meta.fieldKey);
          if (meta.valueMode === 'delta') points = applyDeltaHistoryPoints(points);
          return { meta, points };
        });

        const chart = streamingChartRef.current;
        applyStreamingHistoryChartMulti(chart, seriesPrepared, streamTimePreset);

        const lastPts = seriesPrepared.map((sp) => sp.points[sp.points.length - 1]).filter(Boolean);
        if (lastPts.length) {
          setStreamDisplay(lastPts[0].val);
          setStreamHistoryFetchedAt(Date.now());
          setStreamHistoryError(null);
        } else {
          setStreamHistoryFetchedAt(null);
          setStreamHistoryError('Sin datos en este rango.');
        }
      } catch (err) {
        if (!cancelled) {
          setStreamHistoryError(err?.message || 'Error al cargar el historial');
        }
      } finally {
        if (!cancelled) setStreamHistoryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [streamTimePreset, streamDeviceId, streamSeriesNormalized, credentials, token]);

  useEffect(() => {
    const id = setInterval(() => {
      if (Math.random() <= 0.8) return;
      const pool = sensorsRef.current;
      if (!pool.length) return;
      const randomSensor = pool[Math.floor(Math.random() * pool.length)];
      setAlerts((prev) => {
        const next = [
          {
            id: Date.now(),
            type: Math.random() > 0.5 ? 'warning' : 'info',
            title: `Nueva lectura: ${randomSensor.name}`,
            description: 'Valor fuera del rango normal',
            value: `${randomSensor.value}${randomSensor.unit}`,
            icon: randomSensor.icon,
            timestamp: 'Ahora mismo',
          },
          ...prev,
        ];
        if (next.length > 6) next.pop();
        return next;
      });
    }, 12000);
    return () => clearInterval(id);
  }, []);

  const editSensorValue = (id) => {
    if (!canEditDashboard) return;
    const sensor = sensors.find((s) => s.id === id);
    if (!sensor) return;
    const newValue = window.prompt(`Ingrese nuevo valor para ${sensor.name}:`, String(sensor.value));
    if (newValue === null || newValue === '') return;
    const n = parseFloat(newValue);
    if (Number.isNaN(n)) return;
    setSensors((prev) =>
      prev.map((s) => (s.id === id ? { ...s, value: n } : s))
    );
    if (n > sensor.threshold) {
      setAlerts((prev) => [
        {
          id: Date.now(),
          type: n > sensor.threshold * 1.2 ? 'critical' : 'warning',
          title: `Alerta: ${sensor.name}`,
          description: 'Valor excede el umbral',
          value: `${n}${sensor.unit} / ${sensor.threshold}${sensor.unit}`,
          icon: sensor.icon,
          timestamp: 'Ahora mismo',
        },
        ...prev,
      ]);
    }
  };

  const acknowledgeAlert = (alertId) => {
    setAlerts((prev) => prev.filter((a) => a.id !== alertId));
  };

  const budgetAmount = BUDGETS[activeYear] ?? BUDGETS[2026];
  const kpiValue = KPIS[activeYear] ?? KPIS[2026];

  const dk = (wid) => widgetStorageKey(variant, 'dashboard', wid);
  const wTitle = (wid, fb) => {
    const t = widgetConfigs[dk(wid)]?.basics?.title;
    return (t && String(t).trim()) || fb;
  };
  const wTitleStyle = (wid) => {
    const c = widgetConfigs[dk(wid)]?.appearance?.titleColor;
    return c ? { color: c } : undefined;
  };
  const streamCfgStore = widgetConfigs[dk(DASH_WIDGET.STREAM)];
  const streamUnit =
    streamCfgStore?.data?.unit != null && String(streamCfgStore.data.unit).length > 0
      ? streamCfgStore.data.unit
      : '°C';
  const streamDecRaw = streamCfgStore?.data?.decimals;
  const streamDec =
    streamDecRaw != null && streamDecRaw !== '' && Number.isFinite(Number(streamDecRaw))
      ? Number(streamDecRaw)
      : 1;

  const openDashWidgetEdit = (wid, buildSensor, editScope = 'value') => {
    if (!canEditDashboard) return;
    openWidgetEditModal({
      storageKey: dk(wid),
      sensor: buildSensor(),
      editScope,
    });
  };

  const removeDashWidget = useCallback(
    (wid) => {
      if (!canEditDashboard) return;
      setVisibilityMap((prev) => {
        const next = { ...prev, [wid]: false };
        saveDashboardVisibility(variant, next);
        return next;
      });
    },
    [variant, canEditDashboard]
  );

  const addDashWidget = useCallback((wid) => {
    setVisibilityMap((prev) => {
      const next = { ...prev, [wid]: true };
      saveDashboardVisibility(variant, next);
      return next;
    });
  }, [variant]);

  const dashWidgetChrome = (wid, onEditClick) => (
    <div className="bsd-widget-actions">
      <button type="button" className="bsd-widget-edit-btn" onClick={onEditClick} aria-label="Editar widget">
        <Pencil size={16} />
      </button>
      <button
        type="button"
        className="bsd-widget-remove-btn"
        onClick={(e) => {
          e.stopPropagation();
          removeDashWidget(wid);
        }}
        aria-label="Quitar widget del tablero"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );

  const loadDashboardWidgetConfigModal = useCallback(
    (wid) => widgetConfigs[widgetStorageKey(variant, 'dashboard', wid)] ?? null,
    [variant, widgetConfigs]
  );

  const resolveDashboardModalStorageKey = useCallback(
    (wid) => widgetStorageKey(variant, 'dashboard', wid),
    [variant]
  );

  const savePinnedMapCoordinates = useCallback(() => {
    const lat = toFloatCoord(mapPinLat);
    const lng = toFloatCoord(mapPinLng);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      window.alert('Introduce latitud y longitud válidas.');
      return;
    }
    const k = widgetStorageKey(variant, 'dashboard', DASH_WIDGET.MAP);
    const prev = widgetConfigs[k];
    const base = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.MAP), prev);
    base.data = {
      ...base.data,
      savedLatitude: lat,
      savedLongitude: lng,
    };
    saveWidgetConfig(k, base);
    setWidgetConfigs(loadAllWidgetConfigs());
  }, [variant, widgetConfigs, mapPinLat, mapPinLng]);

  const clearPinnedMapCoordinates = useCallback(() => {
    const k = widgetStorageKey(variant, 'dashboard', DASH_WIDGET.MAP);
    const prev = widgetConfigs[k];
    const base = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.MAP), prev);
    base.data = { ...base.data, savedLatitude: '', savedLongitude: '' };
    saveWidgetConfig(k, base);
    setWidgetConfigs(loadAllWidgetConfigs());
  }, [variant, widgetConfigs]);

  const onImageFileSelected = useCallback(
    (e) => {
      const f = e.target.files?.[0];
      const input = e.target;
      if (input) input.value = '';
      if (!f || !f.type.startsWith('image/')) return;
      if (f.size > 1_200_000) {
        window.alert('Imagen demasiado grande (máx. ~1,2 MB).');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        if (typeof dataUrl !== 'string') return;
        const k = widgetStorageKey(variant, 'dashboard', DASH_WIDGET.IMAGE);
        const prev = widgetConfigs[k];
        const base = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.IMAGE), prev);
        base.data = { ...base.data, uploadedImageDataUrl: dataUrl };
        saveWidgetConfig(k, base);
        setWidgetConfigs(loadAllWidgetConfigs());
      };
      reader.readAsDataURL(f);
    },
    [variant, widgetConfigs]
  );

  const clearUploadedDashboardImage = useCallback(() => {
    const k = widgetStorageKey(variant, 'dashboard', DASH_WIDGET.IMAGE);
    const prev = widgetConfigs[k];
    const base = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.IMAGE), prev);
    base.data = { ...base.data, uploadedImageDataUrl: '' };
    saveWidgetConfig(k, base);
    setWidgetConfigs(loadAllWidgetConfigs());
  }, [variant, widgetConfigs]);

  const effectiveDeviceId =
    variant === 'device' && device?.deviceId ? String(device.deviceId) : controlDeviceId;

  const toggleKey = useMemo(() => pickToggleKey(liveProps), [liveProps]);
  const switchOn = useMemo(() => {
    if (!toggleKey) return false;
    const v = liveProps[toggleKey];
    const b = parseTelemetryBoolish(v);
    if (b !== null) return b;
    return Number(v) === 1;
  }, [liveProps, toggleKey]);

  const emergState = useMemo(() => {
    const raw = pickEmergencyRaw(liveProps);
    if (raw === undefined) return 'unknown';
    const s = String(raw).toLowerCase();
    const active =
      raw === true ||
      raw === 1 ||
      raw === '1' ||
      s === 'on' ||
      s === 'alarm' ||
      s === 'triggered' ||
      s === 'panic' ||
      s === 'emergency';
    return active ? 'active' : 'ok';
  }, [liveProps]);

  const imageUrl = useMemo(
    () =>
      resolveImageDisplayUrl(
        liveProps,
        widgetConfigs[widgetStorageKey(variant, 'dashboard', DASH_WIDGET.IMAGE)]
      ),
    [liveProps, widgetConfigs, variant]
  );
  const mapCoords = useMemo(
    () =>
      resolveMapCoords(
        liveProps,
        widgetConfigs[widgetStorageKey(variant, 'dashboard', DASH_WIDGET.MAP)]
      ),
    [liveProps, widgetConfigs, variant]
  );

  useEffect(() => {
    if (mapCoords) {
      setMapPinLat(String(mapCoords.lat));
      setMapPinLng(String(mapCoords.lng));
    }
  }, [mapCoords?.lat, mapCoords?.lng]);

  /** Downlink que envía el botón del widget: el elegido en Datos o el primero de la lista. */
  const resolvedPanelDownlink = useMemo(() => {
    if (!downlinkList.length) return null;
    const preferred = widgetConfigs[widgetStorageKey(variant, 'dashboard', DASH_WIDGET.DOWNLINK)]?.data?.downlinkDefaultHex;
    const n = normalizeDownlinkHex(preferred);
    if (n) {
      const hit = downlinkList.find((d) => normalizeDownlinkHex(d.hex) === n);
      if (hit) return hit;
    }
    return downlinkList[0];
  }, [downlinkList, widgetConfigs, variant]);

  const availableDataFields = useMemo(() => {
    if (!telemetryLiveProps || typeof telemetryLiveProps !== 'object') return [];
    return Object.keys(telemetryLiveProps)
      .filter((k) => !IGNORE.has(k) && !String(k).endsWith('_alarm'))
      .sort((a, b) => a.localeCompare(b));
  }, [telemetryLiveProps]);

  const visibleSensorsForGrid = useMemo(
    () => sensors.filter((s) => !hiddenSensorCardKeys.has(`${s.sourceDeviceId}|${s.propertyKey}`)),
    [sensors, hiddenSensorCardKeys]
  );

  const handleSwitchClick = useCallback(async () => {
    if (!isAdmin || !effectiveDeviceId || switchProcessing) return;
    const dls = downlinkList;
    if (dls.length === 0) {
      window.alert('No hay downlinks guardados. Configúralos en Dispositivos → acciones → Downlink.');
      return;
    }
    const swData = widgetConfigs[widgetStorageKey(variant, 'dashboard', DASH_WIDGET.SWITCH)]?.data;
    const onStored = swData?.switchHexOn;
    const offStored = swData?.switchHexOff;
    const pickHex = (stored) => {
      const n = normalizeDownlinkHex(stored);
      if (!n) return null;
      const hit = dls.find((d) => normalizeDownlinkHex(d.hex) === n);
      return hit ? hit.hex : stored;
    };
    let hex =
      onStored && offStored
        ? switchOn
          ? pickHex(offStored)
          : pickHex(onStored)
        : null;
    if (hex == null || String(hex).trim() === '') {
      hex = dls.length >= 2 ? (switchOn ? dls[1].hex : dls[0].hex) : dls[0].hex;
    }
    setSwitchProcessing(true);
    try {
      await sendDownlink(effectiveDeviceId, hex, credentials, token);
      if (toggleKey && dls.length >= 2) {
        setLiveProps((p) => ({ ...p, [toggleKey]: switchOn ? 0 : 1 }));
      }
    } catch (err) {
      window.alert(downlinkErrorMessage(err));
    } finally {
      setSwitchProcessing(false);
    }
  }, [
    isAdmin,
    effectiveDeviceId,
    switchProcessing,
    downlinkList,
    switchOn,
    toggleKey,
    credentials,
    token,
    widgetConfigs,
    variant,
  ]);

  const handlePanelDownlinkClick = useCallback(async () => {
    const dl = resolvedPanelDownlink;
    if (!isAdmin || !effectiveDeviceId || !dl || downlinkWidgetBusy) return;
    setDownlinkWidgetBusy(true);
    try {
      await sendDownlink(effectiveDeviceId, dl.hex, credentials, token);
    } catch (err) {
      window.alert(`${dl.name || 'Downlink'}: ${downlinkErrorMessage(err)}`);
    } finally {
      setDownlinkWidgetBusy(false);
    }
  }, [isAdmin, effectiveDeviceId, resolvedPanelDownlink, downlinkWidgetBusy, credentials, token]);

  const buildDashboardWidgetSensor = useCallback(
    (wid) => {
      const pk = `__bsd_${wid}`;
      switch (wid) {
        case DASH_WIDGET.PANEL_DEVICE_BAR:
          return {
            id: 0,
            name: 'Controles vinculados',
            value: panelDevices.length,
            unit: 'dispositivos',
            icon: '🔗',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.SWITCH:
          return {
            id: 0,
            name: 'Switch',
            value: switchOn ? 1 : 0,
            unit: '',
            icon: '⚡',
            threshold: 1,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.EMERGENCY:
          return {
            id: 0,
            name: 'Emergencia',
            value: emergState === 'active' ? 1 : 0,
            unit: '',
            icon: '⚠️',
            threshold: 1,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.DOWNLINK:
          return {
            id: 0,
            name: 'Downlink',
            value: downlinkList.length,
            unit: 'cmds',
            icon: '⚡',
            threshold: 10,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.IMAGE:
          return {
            id: 0,
            name: 'Imagen',
            value: imageUrl ? 1 : 0,
            unit: '',
            icon: '🖼️',
            threshold: 1,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.MAP:
          return {
            id: 0,
            name: 'Mapa',
            value: mapCoords ? 1 : 0,
            unit: '',
            icon: '📍',
            threshold: 1,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.BUDGET:
          return {
            id: 0,
            name: 'Total Budget',
            value: budgetAmount,
            unit: '$',
            icon: '💰',
            threshold: 5000,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.TASKS:
          return {
            id: 0,
            name: 'Tasks Completed',
            value: tasksCompleted,
            unit: '',
            icon: '✅',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.SATISFACTION:
          return {
            id: 0,
            name: 'Team Satisfaction',
            value: satisfactionUi.rawValue != null ? satisfactionUi.rawValue : satisfactionUi.ringPct,
            unit: '%',
            icon: '😊',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.BURNDOWN:
          return {
            id: 0,
            name: 'Epic Burndown Chart',
            value: donutBurndown.completed,
            unit: 'pts',
            icon: '📉',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.SOURCES:
          return {
            id: 0,
            name: 'Sources',
            value: Math.max(...Object.values(SOURCES_DATA)),
            unit: '',
            icon: '🔗',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.TASK_STATUS:
          return {
            id: 0,
            name: 'Task Status',
            value: taskStatusPercents[0],
            unit: '%',
            icon: '📋',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.ALERTS:
          return {
            id: 0,
            name: 'Threshold Alerts',
            value: alerts.length,
            unit: 'alertas',
            icon: '⚠️',
            threshold: 10,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.STREAM:
          return {
            id: 0,
            name: 'Real-Time Sensor Streaming',
            value: streamDisplay,
            unit: streamUnit,
            icon: '📡',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.SENSOR_GRID:
          return {
            ...dashboardWidgetSensorStub(DASH_WIDGET.SENSOR_GRID),
            icon: '📊',
          };
        default:
          return { ...dashboardWidgetSensorStub(wid), icon: '▫️' };
      }
    },
    [
      panelDevices.length,
      switchOn,
      emergState,
      downlinkList.length,
      imageUrl,
      mapCoords,
      budgetAmount,
      tasksCompleted,
      satisfactionUi.rawValue,
      satisfactionUi.ringPct,
      donutBurndown.completed,
      taskStatusPercents,
      alerts.length,
      streamDisplay,
      streamUnit,
    ]
  );

  const addableWidgetMenuEntries = useMemo(
    () => getDashboardWidgetMenuEntries().filter((e) => !e.panelOnly || variant === 'panel'),
    [variant]
  );

  const addDashboardWidgetAndOpenConfig = useCallback(
    (wid) => {
      if (!canEditDashboard) return;
      addDashWidget(wid);
      openWidgetEditModal({
        storageKey: widgetStorageKey(variant, 'dashboard', wid),
        sensor: buildDashboardWidgetSensor(wid),
        editScope: 'value',
      });
      queueMicrotask(() => {
        const root = addWidgetDetailsRef.current;
        if (root?.removeAttribute) root.removeAttribute('open');
      });
    },
    [addDashWidget, buildDashboardWidgetSensor, variant, canEditDashboard, openWidgetEditModal]
  );

  const dashboardToolbar = canEditDashboard ? (
    <div className="bsd-dashboard-toolbar">
      {!dashboardEditMode ? (
        <button type="button" className="bsd-btn-dashboard-edit" onClick={() => setDashboardEditMode(true)}>
          Editar
        </button>
      ) : (
        <>
          <details ref={addWidgetDetailsRef} className="bsd-widget-menu bsd-widget-menu--add">
            <summary className="bsd-widget-menu-summary">
              <LayoutGrid size={16} aria-hidden />
              Agregar widget
            </summary>
            <div className="bsd-widget-menu-panel" onClick={(e) => e.stopPropagation()}>
              <p className="bsd-widget-menu-help">
                Elige un tipo de widget: se abrirá la misma ventana de configuración (tipo, datos, apariencia,
                indicador). Si estaba oculto, volverá al tablero al guardar o al cerrar tras revisar.
              </p>
              <div className="bsd-widget-add-list">
                {addableWidgetMenuEntries.map((e) => {
                  const visible = visibilityMap[e.id] !== false;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      className="bsd-widget-add-item"
                      onClick={() => addDashboardWidgetAndOpenConfig(e.id)}
                    >
                      <span className="bsd-widget-add-item__row">
                        <span>{e.label}</span>
                        <span className={`bsd-widget-add-item__badge${visible ? ' is-on' : ''}`}>
                          {visible ? 'En tablero' : 'Oculto'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </details>
          <button type="button" className="bsd-btn-dashboard-done" onClick={() => setDashboardEditMode(false)}>
            Listo
          </button>
        </>
      )}
    </div>
  ) : null;

  const showLoader = (variant === 'panel' && panelLoading) || loadingExternal;

  if (showLoader) {
    return (
      <div
        className={`bsd-root ${embedded ? 'bsd-root--embedded' : ''} ${dashboardLayoutLocked ? 'bsd-dashboard-edit-off' : ''}`}
      >
        <div className="dashboard-container" style={{ textAlign: 'center', padding: '3rem', color: '#a1a1aa' }}>
          <RefreshCw className="spin" size={32} />
          <p style={{ marginTop: 16 }}>{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  const title =
    variant === 'device' && device
      ? device.name || device.sn || 'Dispositivo'
      : '✨ Budget & Sensors Dashboard';
  const subtitle =
    variant === 'device' && device
      ? `${device.model || 'IoT'} · ${device.sn || device.deviceId || ''}`
      : 'Monitoreo inteligente | Alertas en tiempo real | Análisis predictivo';

  return (
    <div
      className={`bsd-root ${embedded ? 'bsd-root--embedded' : ''} ${dashboardLayoutLocked ? 'bsd-dashboard-edit-off' : ''}`}
    >
      <div className="dashboard-container">
        {!(embedded && variant === 'device') && (
          <div className="dashboard-header">
            <div className="dashboard-header-top">
              <div className="title">
                <h1>{title}</h1>
                <p>{subtitle}</p>
              </div>
              {dashboardToolbar}
            </div>
          </div>
        )}

        {embedded && variant === 'device' && <div className="bsd-embedded-toolbar">{dashboardToolbar}</div>}

        <div
          className={embedded && variant === 'device' ? 'bsd-embedded-main' : 'bsd-dashboard-inner'}
        >
        {variant === 'panel' && panelDevices.length > 0 && isVis(DASH_WIDGET.PANEL_DEVICE_BAR) && (
          <div className="widget bsd-panel-device-bar bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.PANEL_DEVICE_BAR, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.PANEL_DEVICE_BAR, () => ({
                id: 0,
                name: 'Controles vinculados',
                value: panelDevices.length,
                unit: 'dispositivos',
                icon: '🔗',
                threshold: 100,
                propertyKey: `__bsd_${DASH_WIDGET.PANEL_DEVICE_BAR}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="bsd-panel-device-bar-inner">
              <span className="bsd-panel-device-label" style={wTitleStyle(DASH_WIDGET.PANEL_DEVICE_BAR)}>
                {wTitle(DASH_WIDGET.PANEL_DEVICE_BAR, 'Controles vinculados a')}
              </span>
              <select
                className="bsd-device-select"
                value={controlDeviceId || ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setControlDeviceId(v);
                  localStorage.setItem('bsd_panel_control_device', v);
                }}
                aria-label="Dispositivo para switch y downlinks"
              >
                {panelDevices.map((d) => (
                  <option key={d.deviceId} value={String(d.deviceId)}>
                    {d.name || d.sn || d.deviceId}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {(isVis(DASH_WIDGET.SWITCH) || isVis(DASH_WIDGET.EMERGENCY)) && (
        <div className="grid-2cols bsd-control-widgets">
          {isVis(DASH_WIDGET.SWITCH) && (
          <div className="widget bsd-control-widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.SWITCH, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.SWITCH, () => ({
                id: 0,
                name: 'Switch',
                value: switchOn ? 1 : 0,
                unit: '',
                icon: '⚡',
                threshold: 1,
                propertyKey: `__bsd_${DASH_WIDGET.SWITCH}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.SWITCH)}>
                <span className="bsd-control-ico">⚡</span> {wTitle(DASH_WIDGET.SWITCH, 'Switch')}
              </div>
            </div>
            <div className="bsd-switch-body">
              {toggleKey ? (
                <div className="bsd-switch-meta">{toggleKey}</div>
              ) : (
                <div className="bsd-control-hint">Sin señal ON/OFF en telemetría (relay, output, etc.)</div>
              )}
              <button
                type="button"
                className={`bsd-switch-track ${switchOn ? 'on' : 'off'} ${switchProcessing ? 'busy' : ''}`}
                onClick={handleSwitchClick}
                disabled={!isAdmin || !effectiveDeviceId || downlinkList.length === 0}
                aria-pressed={switchOn}
              >
                <span className="bsd-switch-knob" />
                <span className="bsd-switch-label">{switchProcessing ? '…' : switchOn ? 'ON' : 'OFF'}</span>
              </button>
              {!isAdmin && <p className="bsd-control-hint">Solo administradores pueden enviar comandos.</p>}
              {isAdmin && downlinkList.length > 0 && (
                <p className="bsd-control-hint">
                  Asigna qué HEX envía cada cambio en <strong>Editar widget → Datos</strong>. Si no eliges ambos comandos, se
                  usa el orden de la lista (1.º = encender, 2.º = apagar cuando hay al menos dos).
                </p>
              )}
            </div>
          </div>
          )}
          {isVis(DASH_WIDGET.EMERGENCY) && (
          <div className="widget bsd-control-widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.EMERGENCY, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.EMERGENCY, () => ({
                id: 0,
                name: 'Emergencia',
                value: emergState === 'active' ? 1 : 0,
                unit: '',
                icon: '⚠️',
                threshold: 1,
                propertyKey: `__bsd_${DASH_WIDGET.EMERGENCY}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.EMERGENCY)}>
                <AlertTriangle size={18} className="bsd-lucide-glow" strokeWidth={2} />{' '}
                {wTitle(DASH_WIDGET.EMERGENCY, 'Emergencia')}
              </div>
            </div>
            <div className="bsd-emergency-body">
              {emergState === 'unknown' && (
                <div className="bsd-emergency-badge unknown">
                  <span className="bsd-emergency-dot" />
                  Sin dato
                </div>
              )}
              {emergState === 'ok' && (
                <div className="bsd-emergency-badge ok">
                  <span className="bsd-emergency-dot" />
                  Normal
                </div>
              )}
              {emergState === 'active' && (
                <div className="bsd-emergency-badge active">
                  <span className="bsd-emergency-dot" />
                  ¡ACTIVADO!
                </div>
              )}
            </div>
          </div>
          )}
        </div>
        )}

        {(isVis(DASH_WIDGET.DOWNLINK) || isVis(DASH_WIDGET.IMAGE) || isVis(DASH_WIDGET.MAP)) && (
        <div className="grid-3cols bsd-control-widgets bsd-control-widgets--dio-map">
          {isVis(DASH_WIDGET.DOWNLINK) && (
          <div className="widget bsd-control-widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.DOWNLINK, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.DOWNLINK, () => ({
                id: 0,
                name: 'Downlink',
                value: downlinkList.length,
                unit: 'cmds',
                icon: '⚡',
                threshold: 10,
                propertyKey: `__bsd_${DASH_WIDGET.DOWNLINK}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.DOWNLINK)}>
                <Zap size={18} className="bsd-lucide-glow" strokeWidth={2} /> {wTitle(DASH_WIDGET.DOWNLINK, 'Downlink')}
              </div>
            </div>
            <div className="bsd-downlink-widget-body">
              {downlinkList.length === 0 ? (
                <div className="bsd-control-hint">
                  Sin comandos guardados. Créalos en la ficha del dispositivo → Downlink y elige cuál envía el botón en
                  Editar widget → Datos.
                </div>
              ) : (
                <button
                  type="button"
                  className="bsd-downlink-btn bsd-downlink-btn--send bsd-downlink-widget-single"
                  disabled={!isAdmin || downlinkWidgetBusy}
                  onClick={handlePanelDownlinkClick}
                >
                  {downlinkWidgetBusy
                    ? 'Enviando…'
                    : (resolvedPanelDownlink?.name || '').trim() || 'Enviar comando'}
                </button>
              )}
            </div>
            {!isAdmin && <p className="bsd-control-hint">Solo administradores pueden enviar downlinks.</p>}
          </div>
          )}
          {isVis(DASH_WIDGET.IMAGE) && (
          <div className="widget bsd-control-widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.IMAGE, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.IMAGE, () => ({
                id: 0,
                name: 'Imagen',
                value: imageUrl ? 1 : 0,
                unit: '',
                icon: '🖼️',
                threshold: 1,
                propertyKey: `__bsd_${DASH_WIDGET.IMAGE}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.IMAGE)}>
                <ImageIcon size={18} className="bsd-lucide-glow" strokeWidth={2} /> {wTitle(DASH_WIDGET.IMAGE, 'Imagen')}
              </div>
            </div>
            <div className="bsd-image-widget-body">
              {canEditDashboard && (
                <div className="bsd-image-toolbar">
                  <label className="bsd-file-label">
                    <input
                      type="file"
                      accept="image/*"
                      className="bsd-file-input"
                      onChange={onImageFileSelected}
                    />
                    Subir imagen
                  </label>
                  {widgetConfigs[widgetStorageKey(variant, 'dashboard', DASH_WIDGET.IMAGE)]?.data
                    ?.uploadedImageDataUrl ? (
                    <button type="button" className="bsd-linkish-btn" onClick={clearUploadedDashboardImage}>
                      Quitar imagen subida
                    </button>
                  ) : null}
                </div>
              )}
              {imageUrl ? (
                <img src={imageUrl} alt="" className="bsd-preview-img" />
              ) : (
                <div className="bsd-image-placeholder">
                  <ImageIcon size={40} strokeWidth={1} />
                  <span>Sube una imagen o usa URL en telemetría (imageUrl, foto…)</span>
                </div>
              )}
            </div>
          </div>
          )}
          {isVis(DASH_WIDGET.MAP) && (
          <div className="widget bsd-control-widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.MAP, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.MAP, () => ({
                id: 0,
                name: 'Mapa',
                value: mapCoords ? 1 : 0,
                unit: '',
                icon: '📍',
                threshold: 1,
                propertyKey: `__bsd_${DASH_WIDGET.MAP}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.MAP)}>
                <MapPin size={18} className="bsd-lucide-glow" strokeWidth={2} /> {wTitle(DASH_WIDGET.MAP, 'Mapa')}
              </div>
            </div>
            <div className="bsd-map-widget-body">
              {canEditDashboard && (
                <div className="bsd-map-coords-form">
                  <span className="bsd-map-coords-title">Guardar coordenadas en el widget</span>
                  <div className="bsd-map-coords-row">
                    <input
                      type="text"
                      className="bsd-map-coord-input"
                      placeholder="Latitud"
                      value={mapPinLat}
                      onChange={(e) => setMapPinLat(e.target.value)}
                      aria-label="Latitud"
                    />
                    <input
                      type="text"
                      className="bsd-map-coord-input"
                      placeholder="Longitud"
                      value={mapPinLng}
                      onChange={(e) => setMapPinLng(e.target.value)}
                      aria-label="Longitud"
                    />
                  </div>
                  <div className="bsd-map-coords-actions">
                    <button type="button" className="bsd-map-save-btn" onClick={savePinnedMapCoordinates}>
                      Guardar coordenadas
                    </button>
                    <button type="button" className="bsd-linkish-btn" onClick={clearPinnedMapCoordinates}>
                      Usar solo telemetría
                    </button>
                  </div>
                </div>
              )}
              {mapCoords ? (
                <>
                  <iframe
                    title="Mapa dispositivo"
                    className="bsd-map-iframe"
                    src={openStreetMapEmbedUrl(mapCoords.lat, mapCoords.lng)}
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                  />
                  <div className="bsd-map-meta">
                    {mapCoords.lat.toFixed(5)}, {mapCoords.lng.toFixed(5)}
                  </div>
                </>
              ) : (
                <div className="bsd-map-placeholder">
                  <MapPin size={40} strokeWidth={1} />
                  <span>
                    Indica lat/lon arriba, guarda, o envía <code>latitude</code>/<code>longitude</code> en telemetría.
                  </span>
                </div>
              )}
            </div>
          </div>
          )}
        </div>
        )}

        {(isVis(DASH_WIDGET.BUDGET) ||
          isVis(DASH_WIDGET.TASKS) ||
          isVis(DASH_WIDGET.SATISFACTION)) && (
        <div className="grid-3cols">
          {isVis(DASH_WIDGET.BUDGET) && (
          <div className="widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.BUDGET, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.BUDGET, () => ({
                id: 0,
                name: 'Total Budget',
                value: budgetAmount,
                unit: '$',
                icon: '💰',
                threshold: 5000,
                propertyKey: `__bsd_${DASH_WIDGET.BUDGET}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.BUDGET)}>
                <span>💰</span> {wTitle(DASH_WIDGET.BUDGET, 'Total Budget')}
              </div>
            </div>
            <div className="budget-main">
              <div className="budget-amount">${budgetAmount.toLocaleString()}</div>
              <div className="budget-years">
                {['2025', '2026', '2027', '2028'].map((y) => (
                  <button
                    key={y}
                    type="button"
                    className={`year-btn ${activeYear === y ? 'active' : ''}`}
                    onClick={() => setActiveYear(y)}
                  >
                    {y}
                  </button>
                ))}
              </div>
              <div className="kpi-badge">{kpiValue}%</div>
            </div>
          </div>
          )}
          {isVis(DASH_WIDGET.TASKS) && (
          <div className="widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.TASKS, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.TASKS, () => ({
                id: 0,
                name: 'Tasks Completed',
                value: tasksCompleted,
                unit: '',
                icon: '✅',
                threshold: 100,
                propertyKey: `__bsd_${DASH_WIDGET.TASKS}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.TASKS)}>
                <span>✅</span> {wTitle(DASH_WIDGET.TASKS, 'Tasks Completed')}
              </div>
            </div>
            <div className="budget-main">
              <div className="tasks-number">{tasksCompleted}</div>
              <div className="tasks-plan">
                <div>
                  <div className="plan-label">Plan</div>
                  <div className="plan-value">{tasksPlan}</div>
                </div>
              </div>
            </div>
          </div>
          )}
          {isVis(DASH_WIDGET.SATISFACTION) && (
          <div className="widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.SATISFACTION, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.SATISFACTION, () => ({
                id: 0,
                name: 'Team Satisfaction',
                value: satisfactionUi.rawValue != null ? satisfactionUi.rawValue : satisfactionUi.ringPct,
                unit: '%',
                icon: '😊',
                threshold: 100,
                propertyKey: `__bsd_${DASH_WIDGET.SATISFACTION}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.SATISFACTION)}>
                <span>😊</span> {wTitle(DASH_WIDGET.SATISFACTION, 'Team Satisfaction')}
              </div>
            </div>
            <div className="progress-circle">
              <svg width="160" height="160" aria-hidden>
                <circle cx="80" cy="80" r="70" fill="none" stroke="rgba(99,102,241,0.2)" strokeWidth="10" />
                <circle
                  ref={satisfactionArcRef}
                  cx="80"
                  cy="80"
                  r="70"
                  fill="none"
                  stroke={`url(#bsd-grad-${gradId})`}
                  strokeWidth="10"
                  strokeDasharray="439.8"
                  strokeDashoffset="439.8"
                />
                <defs>
                  <linearGradient id={`bsd-grad-${gradId}`} x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" style={{ stopColor: '#10b981', stopOpacity: 1 }} />
                    <stop offset="100%" style={{ stopColor: '#06b6d4', stopOpacity: 1 }} />
                  </linearGradient>
                </defs>
              </svg>
              <div className="progress-text">{satisfactionUi.centerLabel}</div>
            </div>
          </div>
          )}
        </div>
        )}

        {(isVis(DASH_WIDGET.BURNDOWN) || isVis(DASH_WIDGET.SOURCES) || isVis(DASH_WIDGET.TASK_STATUS)) && (
        <div className="grid-3cols">
          {isVis(DASH_WIDGET.BURNDOWN) && (
          <div className="widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.BURNDOWN, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.BURNDOWN, () => ({
                id: 0,
                name: 'Epic Burndown Chart',
                value: donutBurndown.completed,
                unit: 'pts',
                icon: '📉',
                threshold: 100,
                propertyKey: `__bsd_${DASH_WIDGET.BURNDOWN}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.BURNDOWN)}>
                <span>📉</span> {wTitle(DASH_WIDGET.BURNDOWN, 'Epic Burndown Chart')}
              </div>
            </div>
            <div className="donut-container">
              <canvas ref={burndownRef} width={200} height={200} />
            </div>
            <div className="donut-legend">
              <div className="legend-item">
                <div className="legend-color" style={{ background: '#10b981' }} />
                Completed: <span>{donutBurndown.completed}</span>
              </div>
              <div className="legend-item">
                <div className="legend-color" style={{ background: '#f59e0b' }} />
                Pending: <span>{donutBurndown.pending}</span>
              </div>
              <div className="legend-item">
                <div className="legend-color" style={{ background: '#ef4444' }} />
                Added: <span>{donutBurndown.added}</span>
              </div>
            </div>
          </div>
          )}
          {isVis(DASH_WIDGET.SOURCES) && (
          <div className="widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.SOURCES, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.SOURCES, () => ({
                id: 0,
                name: 'Sources',
                value: Math.max(...Object.values(SOURCES_DATA)),
                unit: '',
                icon: '🔗',
                threshold: 100,
                propertyKey: `__bsd_${DASH_WIDGET.SOURCES}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.SOURCES)}>
                <span>🔗</span> {wTitle(DASH_WIDGET.SOURCES, 'Sources')}
              </div>
            </div>
            <div className="bar-chart">
              {Object.entries(SOURCES_DATA).map(([label, value]) => {
                const maxValue = Math.max(...Object.values(SOURCES_DATA));
                const heightPercent = (value / maxValue) * 180;
                return (
                  <div key={label} className="bar-item">
                    <div className="bar" style={{ height: `${heightPercent}px` }} />
                    <div className="bar-label">{label}</div>
                  </div>
                );
              })}
            </div>
          </div>
          )}
          {isVis(DASH_WIDGET.TASK_STATUS) && (
          <div className="widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.TASK_STATUS, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.TASK_STATUS, () => ({
                id: 0,
                name: 'Task Status',
                value: taskStatusPercents[0],
                unit: '%',
                icon: '📋',
                threshold: 100,
                propertyKey: `__bsd_${DASH_WIDGET.TASK_STATUS}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.TASK_STATUS)}>
                <span>📋</span> {wTitle(DASH_WIDGET.TASK_STATUS, 'Task Status')}
              </div>
            </div>
            <div className="donut-container">
              <canvas ref={taskStatusRef} width={200} height={200} />
            </div>
            <div className="donut-legend">
              <div className="legend-item">
                <div className="legend-color" style={{ background: '#10b981' }} />
                Completed: {taskStatusPercents[0]}%
              </div>
              <div className="legend-item">
                <div className="legend-color" style={{ background: '#f59e0b' }} />
                Pending: {taskStatusPercents[1]}%
              </div>
              <div className="legend-item">
                <div className="legend-color" style={{ background: '#ef4444' }} />
                Added: {taskStatusPercents[2]}%
              </div>
            </div>
          </div>
          )}
        </div>
        )}

        {isVis(DASH_WIDGET.SENSOR_GRID) && (
        <div className="bsd-sensor-grid-shell bsd-widget-editable">
          {dashWidgetChrome(DASH_WIDGET.SENSOR_GRID, (e) => {
            e.stopPropagation();
            openDashWidgetEdit(DASH_WIDGET.SENSOR_GRID, () => ({
              ...dashboardWidgetSensorStub(DASH_WIDGET.SENSOR_GRID),
              icon: '📊',
            }));
          })}
          <div className="grid-4cols">
          {visibleSensorsForGrid.length === 0 ? (
            <p className="bsd-sensor-grid-empty">
              No hay tarjetas visibles. Las que ocultes con eliminar vuelven al cambiar de dispositivo o al recargar la
              página.
            </p>
          ) : (
            visibleSensorsForGrid.map((sensor) => {
            const cfg = getWidgetConfig(sensor);
            const displayVal = getDisplayValue(sensor);
            const status = updateSensorStatus(sensor, displayVal);
            const ak = `${sensor.sourceDeviceId}|${sensor.propertyKey}`;
            const historySeries = aggregateSeriesByKey[ak];
            const unit =
              cfg?.data?.unit != null && String(cfg.data.unit).length > 0 ? cfg.data.unit : sensor.unit;
            const decRaw = cfg?.data?.decimals;
            const decimals =
              decRaw != null && decRaw !== '' && Number.isFinite(Number(decRaw)) ? Number(decRaw) : 1;
            const indType = normalizeIndicatorType(cfg?.gauge?.indicatorType || 'numeric');
            const useClassicNumeric = indType === 'numeric';
            const cardTitle = cfg?.basics?.title || sensor.name;
            const titleColor = cfg?.appearance?.titleColor || '#f97316';
            const gran = cfg?.timeframe?.granularity;
            const subtitle =
              cfg?.timeframe?.mode === 'interval'
                ? gran
                  ? `Historial (${gran})`
                  : 'Intervalo'
                : 'En vivo';
            const statusLabel =
              status === 'normal' ? '✓ NORMAL' : status === 'warning' ? '⚠ ALERTA' : '🔴 CRÍTICO';
            const rangeAccent = colorForValueInRanges(
              displayVal,
              cfg?.gauge?.ranges || [],
              Number(cfg?.gauge?.scaleMin) || 0,
              Number(cfg?.gauge?.scaleMax) || 50
            );
            return (
              <div
                key={sensor.id}
                role={canEditDashboard ? 'button' : undefined}
                tabIndex={canEditDashboard ? 0 : undefined}
                className="sensor-card"
                onClick={() => canEditDashboard && editSensorValue(sensor.id)}
                onKeyDown={(e) => {
                  if (!canEditDashboard) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    editSensorValue(sensor.id);
                  }
                }}
                style={{
                  width: '100%',
                  ...(rangeAccent
                    ? { borderColor: `${rangeAccent}aa`, boxShadow: `0 0 26px ${rangeAccent}40` }
                    : {}),
                }}
              >
                {canEditDashboard && (
                  <div className="sensor-card__actions">
                    <button
                      type="button"
                      className="sensor-card__edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        openWidgetEditModal({
                          storageKey: configKeyForSensor(sensor),
                          sensor,
                          editScope: 'value',
                        });
                      }}
                      aria-label="Editar widget"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      className="sensor-card__remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        const k = `${sensor.sourceDeviceId}|${sensor.propertyKey}`;
                        setHiddenSensorCardKeys((prev) => new Set(prev).add(k));
                      }}
                      aria-label="Quitar tarjeta del tablero"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
                {!useClassicNumeric ? (
                  <>
                    <ValueIndicator
                      type={indType}
                      value={displayVal}
                      unit={unit}
                      decimals={decimals}
                      scaleMin={Number(cfg.gauge?.scaleMin) || 0}
                      scaleMax={Number(cfg.gauge?.scaleMax) || 50}
                      ranges={cfg.gauge?.ranges || []}
                      title={cardTitle}
                      titleColor={titleColor}
                      subtitle={subtitle}
                      compact
                      theme="dark"
                      historySeries={
                        indType === 'linear' && historySeries && historySeries.length > 1
                          ? historySeries
                          : undefined
                      }
                    />
                    <div className={`sensor-status status-${status}`}>{statusLabel}</div>
                  </>
                ) : (
                  <>
                    <div className="sensor-icon">{sensor.icon}</div>
                    <div className="sensor-name">{cardTitle}</div>
                    <div className="sensor-value">
                      {typeof displayVal === 'number' && !Number.isInteger(displayVal)
                        ? displayVal.toFixed(decimals)
                        : displayVal}
                      <span className="sensor-unit">{unit}</span>
                    </div>
                    <div className={`sensor-status status-${status}`}>{statusLabel}</div>
                  </>
                )}
              </div>
            );
          })
          )}
          </div>
        </div>
        )}

        {(isVis(DASH_WIDGET.ALERTS) || isVis(DASH_WIDGET.STREAM)) && (
        <div className="grid-2cols">
          {isVis(DASH_WIDGET.ALERTS) && (
          <div className="widget bsd-widget-editable">
            {dashWidgetChrome(DASH_WIDGET.ALERTS, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.ALERTS, () => ({
                id: 0,
                name: 'Threshold Alerts',
                value: alerts.length,
                unit: 'alertas',
                icon: '⚠️',
                threshold: 10,
                propertyKey: `__bsd_${DASH_WIDGET.ALERTS}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(DASH_WIDGET.ALERTS)}>
                <span>⚠️</span> {wTitle(DASH_WIDGET.ALERTS, 'Threshold Alerts')}
              </div>
              <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{alerts.length} alertas</span>
            </div>
            <div className="alerts-list">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  role="button"
                  tabIndex={0}
                  className={`alert-item ${alert.type}`}
                  onClick={() => acknowledgeAlert(alert.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      acknowledgeAlert(alert.id);
                    }
                  }}
                >
                  <div className="alert-icon">{alert.icon}</div>
                  <div className="alert-content">
                    <div className="alert-title">{alert.title}</div>
                    <div className="alert-desc">{alert.description}</div>
                    <div style={{ fontSize: 10, marginTop: 2 }}>{alert.timestamp}</div>
                  </div>
                  <div className="alert-value">{alert.value}</div>
                </div>
              ))}
            </div>
          </div>
          )}
          {isVis(DASH_WIDGET.STREAM) && (
          <div className="widget bsd-widget-editable bsd-stream-widget-wrap">
            {dashWidgetChrome(DASH_WIDGET.STREAM, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(DASH_WIDGET.STREAM, () => ({
                id: 0,
                name: 'Real-Time Sensor Streaming',
                value: streamDisplay,
                unit: streamUnit,
                icon: '📡',
                threshold: 100,
                propertyKey: `__bsd_${DASH_WIDGET.STREAM}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header bsd-stream-widget-header">
              <div className="bsd-stream-widget-head-main">
                <div className="widget-title" style={wTitleStyle(DASH_WIDGET.STREAM)}>
                  <span>📡</span> {wTitle(DASH_WIDGET.STREAM, 'Real-Time Sensor Streaming')}
                </div>
                <div className="bsd-stream-status">
                  {streamTimePreset === 'live' ? (
                    <>
                      <span className="live-badge" aria-hidden />
                      <span>En vivo</span>
                    </>
                  ) : streamHistoryLoading ? (
                    <span>Cargando historial…</span>
                  ) : (
                    <span>
                      {streamHistoryError ||
                        (streamHistoryFetchedAt
                          ? `Actualizado ${new Date(streamHistoryFetchedAt).toLocaleTimeString()}`
                          : 'Historial')}
                    </span>
                  )}
                </div>
              </div>
              <div className="bsd-stream-presets" role="group" aria-label="Rango temporal del gráfico">
                {STREAM_TIME_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`bsd-stream-preset${streamTimePreset === p.id ? ' active' : ''}`}
                    onClick={() => setStreamTimePreset(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div
              className={`streaming-container${streamSeriesNormalized.length > 1 ? ' streaming-container--multi' : ''}`}
            >
              {streamSeriesNormalized.length === 1 && (
                <div className="streaming-value">
                  {Number.isFinite(streamDisplay) ? streamDisplay.toFixed(streamDec) : '—'}{' '}
                  <span style={{ fontSize: 24 }}>{streamUnit}</span>
                </div>
              )}
              <canvas
                ref={streamingRef}
                height={streamSeriesNormalized.length > 1 ? 220 : 120}
                style={{ marginTop: streamSeriesNormalized.length > 1 ? 8 : 15, position: 'relative', zIndex: 1 }}
              />
            </div>
          </div>
          )}
        </div>
        )}

        {variant === 'device' && typeof onRefresh === 'function' && (
          <div className="bsd-footer-refresh">
            <button type="button" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
              {refreshing ? t('common.loading') : t('common.refresh')}
            </button>
          </div>
        )}
        </div>

        <WidgetEditModal
          key={widgetEditSession}
          open={Boolean(editModalCtx)}
          sensor={editModalCtx?.sensor ?? null}
          initialConfig={editModalCtx ? widgetConfigs[editModalCtx.storageKey] ?? null : null}
          editScope={editModalCtx?.editScope ?? 'value'}
          liveProps={telemetryLiveProps}
          availableDataFields={availableDataFields}
          availableDownlinks={downlinkList}
          loadDashboardWidgetConfig={loadDashboardWidgetConfigModal}
          resolveDashboardStorageKey={resolveDashboardModalStorageKey}
          onSave={(cfg, meta) => {
            if (!editModalCtx) return;
            const oldKey = editModalCtx.storageKey;
            const key = meta?.dashboardTargetKey ?? oldKey;
            saveWidgetConfig(key, cfg);

            if (meta?.dashboardTargetKey && meta.dashboardTargetKey !== oldKey) {
              const oldWid = dashboardWidgetIdFromStorageKey(oldKey);
              const newWid = dashboardWidgetIdFromStorageKey(meta.dashboardTargetKey);
              if (oldWid && newWid && oldWid !== newWid) {
                setVisibilityMap((prev) => {
                  const next = { ...prev, [oldWid]: false, [newWid]: true };
                  saveDashboardVisibility(variant, next);
                  return next;
                });
              }
            }

            setWidgetConfigs(loadAllWidgetConfigs());
            setDashboardEditMode(false);
          }}
          onClose={() => setEditModalCtx(null)}
        />
      </div>
    </div>
  );
}
