import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync, createPortal } from 'react-dom';
import GridLayout from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { flattenDashboardGridChildren } from './BsdStaticDashboardGrid';
import Chart from 'chart.js/auto';
import {
  RefreshCw,
  Zap,
  Image as ImageIcon,
  Pencil,
  Copy,
  Plus,
  LayoutGrid,
  MapPin,
  Trash2,
  Search,
  X,
  Rows3,
  ToggleLeft,
  LineChart,
  BarChart3,
  Grid3X3,
  PieChart,
  Gauge,
  Cylinder,
  Battery,
  Type,
  Route,
  Compass,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import {
  fetchDevices,
  fetchDeviceProperties,
  fetchDeviceHistory,
  sendDownlink,
  fetchDeviceBsdPreferences,
  putDeviceBsdPreferences,
  fetchPanelBsdPreferences,
  putPanelBsdPreferences,
} from '../../services/api';
import { getLatestDeviceData, queryTelemetry } from '../../services/localAuth';
import {
  parseTelemetryScalar,
  parseTelemetryBoolish,
  expandNestedGatewayTelemetry,
  hasMeaningfulAppTelemetry,
  mergeDeviceTelemetryForWidgets,
  PROPERTY_INFER_IGNORE_SET,
} from '../../utils/gatewayPayload';
import {
  formatTelemetryChartTooltipValue,
  formatWidgetTelemetryDisplay,
  tryTelemetryDisplayLabel,
} from '../../utils/telemetryDisplayFormat';
import { transformWidgetNumeric } from '../../utils/widgetFormula';
import {
  enrichTelemetryWithDbFallback,
  resolveLastScalarsFromTelemetryHistory,
} from '../../utils/widgetTelemetryDbFallback';
import {
  applyDeviceBsdBundle,
  collectDeviceBsdBundle,
  deviceBsdBundleIsEmpty,
} from '../../utils/deviceBsdPreferencesBundle';
import { applyPanelBsdBundle, collectPanelBsdBundle, purgePanelInstanceStorage } from '../../utils/panelBsdPreferencesBundle';
import { applyStaleOfflineConnectStatus, isDeviceVisuallyOnline } from '../../utils/deviceConnectionStatus';
import { SYSCOM_REALTIME_TELEMETRY, SYSCOM_REALTIME_LNS } from '../../constants/realtimeEvents';
import {
  PANEL_LIVE_REFRESH_MS,
  DEVICE_LIVE_REFRESH_MS,
  PANEL_SSE_SKIP_HTTP_MS,
  PANEL_DEVICES_LIST_REFRESH_MS,
  PANEL_PROPERTIES_FETCH_MIN_MS,
  DASH_CHART_HISTORY_POLL_MS,
} from '../../constants/liveRefreshMs';
import { pushAppActivityLog } from '../../utils/appActivityLog';
import WidgetEditModal from './WidgetEditModal';
import {
  ValueWidgetDateFilterButtons,
  ValueWidgetDateFilterCustomFields,
} from './ValueWidgetDateFilter';
import BsdWindVaneWidget from './BsdWindVaneWidget';
import BsdSwitchWidgetSlot from './BsdSwitchWidgetSlot';
import BsdDownlinkWidgetSlot from './BsdDownlinkWidgetSlot';
import { computeVeletaWidgetUiForSlot, resolveWindDirectionScalar } from './windVaneUi';
import CenteredAlertModal from '../CenteredAlertModal';
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
  migrateLegacyPanelDataToOwner,
  loadPanelWorkspace,
  savePanelWorkspace,
  resolvePanelOwnerSegment,
  panelControlDeviceStorageKey,
  dashboardWidgetConfigNamespace,
  BSD_VALUE_WIDGETS_STORAGE_KEY,
  dashboardWidgetStorageKey,
  getDashboardWidgetMenuEntries,
  colorForValueInRanges,
  gaugeFillProgressT,
  resolveGaugeColorLookupValue,
  dashboardWidgetIdFromStorageKey,
  mergeWidgetConfig,
  dashboardWidgetSensorStub,
  normalizeDownlinkHex,
  parseCssHex,
  resolveDownlinkButtonTextColor,
  buildBsdWidgetSurfaceStyle,
  isWidgetBackgroundTransparent,
  appearanceWithConditionalBackground,
  resolveTelemetryDisplaySource,
  isLikelyButtonOrStatusFieldKey,
  resolveTextWidgetRawScalar,
  ensureDownlinkButtonsDraft,
  normalizeStreamSeriesConfig,
  applyHistoryGranularityPreset,
  normalizeBarChartGranularity,
  barChartHistoryFetchFromMs,
  startOfLocalDayMs,
  startOfLocalWeekMondayMs,
  startOfLocalMonthMs,
  streamHistoryDisplayBounds,
  historyChartBucketMs,
  BAR_CHART_WIDGET_GRANULARITY_OPTIONS,
  applyValueDateFilterPreset,
  normalizeValueDateFilterPreset,
  isValueDateFilterActive,
  resolveValueDateFilterWindow,
  formatValueDateFilterLabel,
  normalizeValueDateFilterOperation,
  MULTI_INSTANCE_DASH_WIDGETS,
  dashboardWidgetBaseId,
  makeDashboardWidgetCloneId,
  listDashboardWidgetSlotIds,
  cloneWidgetConfigBetweenKeys,
  isDashboardMultiLayoutSlotId,
} from './widgetConfigUtils';
import {
  BSD_CIRCULAR_GAUGE_R,
  BSD_CIRCULAR_GAUGE_STROKE,
  BSD_CIRCULAR_GAUGE_LEN,
  MC_CX,
  MC_CY,
  MC_R,
  MC_ARC_START,
  MC_ARC_SWEEP,
  MC_ARC_PATH_D,
  MC_ARC_GEOM_LEN,
  mcPoint,
  buildMetricCircularTicksFromUi,
  computeMetricCircularUiForSlot,
  computeContainerTankUi,
  computeBatteryLevelUi,
  computeSatisfactionRingUi,
} from './metricCircularUi';
import BsdContainerTankView from './BsdContainerTankView';
import BsdBatteryLevelView from './BsdBatteryLevelView';
import {
  buildDefaultBsdGridLayout,
  compactBsdGridLayoutTopLeft,
  clampLayoutItemsToModerateMins,
  computeBsdDashboardNormalizedLayout,
  commitBsdUserGridLayout,
  buildModerateBsdGridTemplateForWidget,
  dashboardGridLayoutStorageKey,
  layoutsEqualStable,
  mergeStoredBsdGridLayout,
  normalizeLayoutForPersistence,
  readStoredBsdGridLayout,
  filterLayoutToAllowedDashboardItems,
  filterLayoutToVisibleDashboardItems,
  appendBsdGridWidgetAtFirstGap,
  resolveBsdDashboardGridLayout,
  bsdDashboardLayoutHasOverlap,
  ensureBsdGridLayoutGeometry,
  BSD_NARROW_DASHBOARD_MAX_PX,
  stackBsdGridLayoutForNarrowViewport,
  normalizeNewWidgetSlotTemplate,
  ensureBsdGridWidgetSlotAtFirstGap,
} from './bsdDashboardLayout';
import {
  readDownlinksFromLocalStorage,
  getTelemetryLabelHintsForDevice,
  getDownlinkSendOptionsForDevice,
} from '../../services/deviceTemplates';
import BsdLeafletTrackingMap from './BsdLeafletTrackingMap';
import BsdLeafletStaticMap from './BsdLeafletStaticMap';
import BsdMapLayerMenu from './BsdMapLayerMenu';
import { resolveMapCoords } from './mapWidgetCoords';
import { normalizeMapBaseLayerId } from './mapWidgetLayers';
import {
  collectTrackingPointsFromTelemetryRows,
  trackingWindowEndMs,
} from './trackingMapPoints';
import './BudgetSensorsDashboard.css';

/** Icono del catálogo modal «Agregar widget» (Lucide). */
function widgetGalleryLucideIcon(widgetId) {
  const id = String(widgetId || '');
  switch (id) {
    case DASH_WIDGET.PANEL_DEVICE_BAR:
      return Rows3;
    case DASH_WIDGET.SWITCH:
      return ToggleLeft;
    case DASH_WIDGET.DOWNLINK:
      return Zap;
    case DASH_WIDGET.IMAGE:
      return ImageIcon;
    case DASH_WIDGET.MAP:
      return MapPin;
    case DASH_WIDGET.TRACKING_MAP:
      return Route;
    case DASH_WIDGET.SATISFACTION:
      return PieChart;
    case DASH_WIDGET.CONTAINER:
      return Cylinder;
    case DASH_WIDGET.BATTERY_LEVEL:
      return Battery;
    case DASH_WIDGET.METRIC_CIRCULAR:
      return Gauge;
    case DASH_WIDGET.TEXT:
      return Type;
    case DASH_WIDGET.VEleta:
      return Compass;
    case DASH_WIDGET.STREAM:
      return LineChart;
    case DASH_WIDGET.BAR_CHART:
      return BarChart3;
    case DASH_WIDGET.SENSOR_GRID:
      return Grid3X3;
    default:
      return LayoutGrid;
  }
}

const IGNORE = new Set([...PROPERTY_INFER_IGNORE_SET]);

function isTelemetryFieldPickerKey(k) {
  const s = String(k ?? '').trim();
  if (!s) return false;
  if (IGNORE.has(s)) return false;
  if (s.endsWith('_alarm')) return false;
  if (s.startsWith('__bsd_')) return false;
  return true;
}

/** Prefijo `device|<id>|` o `panel|dashboard_<panelId>|` para claves en `bsd_value_widgets_v1`. */
function dashboardWidgetConfigKeyPrefix(variant, dashDeviceId, panelInstanceId, panelOwnerSegment) {
  if (variant === 'device' && dashDeviceId != null && String(dashDeviceId).trim().length) {
    return `device|${String(dashDeviceId).trim()}|`;
  }
  if (variant === 'device') return 'device|dashboard|';
  const ns = dashboardWidgetConfigNamespace('panel', null, panelInstanceId, panelOwnerSegment);
  return `panel|${ns}|`;
}

/** Campos ya usados en widgets del mismo tablero (reutilización ilimitada: siguen apareciendo en el selector). */
function collectFieldKeysFromStoredWidgetConfigs(widgetConfigs, variant, dashDeviceId, panelInstanceId, panelOwnerSegment) {
  const out = [];
  if (!widgetConfigs || typeof widgetConfigs !== 'object') return out;
  const prefix = dashboardWidgetConfigKeyPrefix(variant, dashDeviceId, panelInstanceId, panelOwnerSegment);
  for (const [sk, cfg] of Object.entries(widgetConfigs)) {
    if (!String(sk).startsWith(prefix)) continue;
    const data = cfg?.data;
    if (!data || typeof data !== 'object') continue;
    const fk = data.fieldKey;
    if (fk != null && String(fk).trim()) {
      const t = String(fk).trim();
      if (isTelemetryFieldPickerKey(t)) out.push(t);
    }
    const rows = data.streamSeries;
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const k = r?.fieldKey;
        if (k != null && String(k).trim()) {
          const t = String(k).trim();
          if (isTelemetryFieldPickerKey(t)) out.push(t);
        }
      }
    }
  }
  return out;
}

function collectScalarKeysFromDeviceLikeRecord(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const out = [];
  for (const [key, val] of Object.entries(rec)) {
    if (!isTelemetryFieldPickerKey(key)) continue;
    if (val == null) continue;
    if (typeof val === 'object' && !Array.isArray(val)) continue;
    out.push(String(key));
  }
  return out;
}

/**
 * Identificador estable para claves localStorage del BSD por dispositivo.
 * Algunos listados usan `id` u otros campos; si solo existía `deviceId` en parte del flujo,
 * el layout caía en `bsd_dash_grid_v1_default` y varios equipos compartían la misma parrilla.
 */
function resolveDeviceDashboardStorageId(device) {
  if (!device || typeof device !== 'object') return null;
  const candidates = [
    device.deviceId,
    device.id,
    device.device_id,
    device.uuid,
    device._id,
  ];
  for (const c of candidates) {
    const s = c != null && String(c).trim();
    if (s) return String(c).trim();
  }
  return null;
}

/** Copia `device|dashboard|dw_*` → `device|<deviceId>|dw_*` si falta la clave por equipo (migración / aislamiento). */
function migrateLegacySharedDeviceWidgetConfigs(all, variant, deviceOrId) {
  const newNs =
    typeof deviceOrId === 'string'
      ? deviceOrId.trim()
      : resolveDeviceDashboardStorageId(deviceOrId) || '';
  if (variant !== 'device' || !newNs) return all;
  let next = all;
  let changed = false;
  for (const wid of Object.values(DASH_WIDGET)) {
    const nk = widgetStorageKey('device', newNs, wid);
    const ok = widgetStorageKey('device', 'dashboard', wid);
    if (next[nk] == null && next[ok] != null) {
      if (!changed) {
        next = { ...next };
        changed = true;
      }
      try {
        next[nk] = JSON.parse(JSON.stringify(next[ok]));
      } catch {
        next[nk] = { ...(next[ok] && typeof next[ok] === 'object' ? next[ok] : {}) };
      }
    }
  }
  if (changed) {
    try {
      localStorage.setItem(BSD_VALUE_WIDGETS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  return next;
}

/** DevEUI 16 hex para etiquetas (evita confundir equipos con nombres parecidos). */
function panelDeviceDeuiLabel(d) {
  const eui = String(d?.devEUI || d?.devEui || '')
    .replace(/[^0-9a-fA-F]/gi, '')
    .toLowerCase();
  return eui.length === 16 ? eui : '';
}

const DEFAULT_SENSORS = [
  { id: 1, name: 'Temperatura', value: 23.5, unit: '°C', icon: '🌡️', threshold: 30, propertyKey: 'temperature', sourceDeviceId: 'demo' },
  { id: 2, name: 'Humedad', value: 65, unit: '%', icon: '💧', threshold: 80, propertyKey: 'humidity', sourceDeviceId: 'demo' },
  { id: 3, name: 'Presión', value: 1013, unit: 'hPa', icon: '📊', threshold: 1020, propertyKey: 'pressure', sourceDeviceId: 'demo' },
  { id: 4, name: 'Calidad Aire', value: 42, unit: 'AQI', icon: '🌫️', threshold: 100, propertyKey: 'aqi', sourceDeviceId: 'demo' },
];

/** Rangos del gráfico lineal: en vivo + mismos presets que el gráfico de barras (Hora / Día / Semana / Mes). */
const STREAM_TIME_PRESETS = [
  { id: 'live', label: 'En vivo' },
  { id: 'hour', label: 'Hora' },
  { id: 'day', label: 'Día' },
  { id: 'week', label: 'Semana' },
  { id: 'month', label: 'Mes' },
];

const STREAM_PRESET_IDS = new Set(STREAM_TIME_PRESETS.map((p) => p.id));

const VALUE_DATE_FILTER_DASH_BASES = [
  DASH_WIDGET.TEXT,
  DASH_WIDGET.METRIC_CIRCULAR,
  DASH_WIDGET.SATISFACTION,
  DASH_WIDGET.CONTAINER,
  DASH_WIDGET.BATTERY_LEVEL,
];

function formatStreamChartLabel(tsMs, presetId) {
  const d = new Date(tsMs);
  if (!Number.isFinite(d.getTime())) return '';
  if (presetId === 'live' || presetId === 'hour') {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (presetId === 'day') {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (presetId === 'week') {
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  if (presetId === 'month') {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
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

/** Evita TypeError en Chart.resize cuando el canvas ya no está en el DOM (rAF / ResizeObserver tardíos). */
function safeChartResize(chart) {
  if (!chart) return;
  try {
    const canvas = chart.canvas;
    if (!canvas || !canvas.isConnected) return;
    chart.resize();
  } catch {
    /* instancia destruida o árbol desmontado */
  }
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
      spanGaps: !bar,
      borderColor: s.color,
      backgroundColor: streamHexToRgba(s.color, fill ? 0.28 : 0.06),
      fill,
      tension: stepped ? 0 : 0.35,
      stepped: stepped ? 'before' : false,
      yAxisID: s.yAxis === 'y2' ? 'y2' : 'y',
      order: bar ? 2 : 1,
      pointRadius: fill ? 2 : 2,
      pointHoverRadius: 7,
      pointBackgroundColor: s.color,
      borderWidth: bar ? 0 : 2,
    };
  });
}

function applyStreamingHistoryChartMulti(chart, seriesPrepared, presetId) {
  if (!chart || !seriesPrepared.length) return;
  const n = Math.min(seriesPrepared.length, chart.data.datasets.length);
  const endNow = Date.now();
  const sp0 = seriesPrepared[0];
  const useStreamPerEventTimeline =
    presetId !== 'live' &&
    presetId !== 'hour' &&
    n === 1 &&
    sp0?.meta?.valueMode !== 'delta' &&
    isLikelyButtonOrStatusFieldKey(sp0?.meta?.fieldKey);

  let slotStarts;
  let bucketKind;
  /** @type {number[] | null} */
  let perEventVals = null;

  if (useStreamPerEventTimeline) {
    const tl = streamPerEventTimelineForPreset(sp0.points, sp0.meta.fieldKey, presetId, endNow);
    if (tl && tl.slotStarts.length) {
      slotStarts = tl.slotStarts;
      bucketKind = 'event';
      perEventVals = tl.vals;
    }
  }

  if (!bucketKind || !Array.isArray(slotStarts) || !slotStarts.length) {
    const fixed = bucketSlotsForStreamPreset(presetId, endNow);
    slotStarts = fixed.slotStarts;
    bucketKind = fixed.bucketKind;
    perEventVals = null;
  }

  if (!slotStarts.length || !bucketKind) {
    chart.data.labels = [];
    chart.$streamTimestamps = [];
    for (let i = 0; i < chart.data.datasets.length; i++) chart.data.datasets[i].data = [];
    chart.options.scales.y.min = undefined;
    chart.options.scales.y.max = undefined;
    if (chart.options.scales.y2) {
      chart.options.scales.y2.min = undefined;
      chart.options.scales.y2.max = undefined;
    }
    chart.update('none');
    return;
  }

  const anyPoints = seriesPrepared.some((sp) => sp.points.length);
  const labelTs = slotStarts;
  chart.data.labels = labelTs.map((ts) => formatStreamChartLabel(ts, presetId));
  chart.$streamTimestamps = [...labelTs];

  const nLab = labelTs.length;
  if (chart.options.scales?.x?.ticks) {
    chart.options.scales.x.ticks.maxRotation = nLab > 24 ? 50 : nLab > 12 ? 35 : 0;
    chart.options.scales.x.ticks.maxTicksLimit = Math.min(24, Math.max(8, Math.ceil(nLab / 4)));
  }

  const y1Vals = [];
  const y2Vals = [];
  for (let i = 0; i < n; i++) {
    const sp = seriesPrepared[i];
    const vals =
      perEventVals && i === 0
        ? perEventVals
        : anyPoints
          ? aggregatePointsToStreamSlots(sp.points, slotStarts, bucketKind, sp.meta?.fieldKey)
          : slotStarts.map(() => null);
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
  const anyFiniteY = y1Vals.length > 0 || (chart.options.scales.y2 && y2Vals.length > 0);
  if (!anyFiniteY && labelTs.length) {
    chart.options.scales.y.min = 0;
    chart.options.scales.y.max = 1;
  }
  chart.update('none');
  requestAnimationFrame(() => safeChartResize(chart));
}

function clearStreamingChart(chart) {
  if (!chart) return;
  chart.data.labels = [];
  chart.$streamTimestamps = [];
  chart.data.datasets.forEach((ds) => {
    ds.data = [];
  });
  chart.options.scales.y.min = undefined;
  chart.options.scales.y.max = undefined;
  if (chart.options.scales.y2) {
    chart.options.scales.y2.min = undefined;
    chart.options.scales.y2.max = undefined;
  }
  chart.update('none');
}

function initStreamingMultiState(len) {
  return {
    buffers: Array.from({ length: len }, () => []),
    timeBuffers: Array.from({ length: len }, () => []),
    lastRaw: Array(len).fill(null),
  };
}

/** Sincroniza etiquetas de tiempo del gráfico en vivo con buffer 0. */
function applyLiveStreamChartLabels(chart, st2, presetId) {
  if (!chart) return;
  const maxLen = Math.max(...st2.buffers.map((b) => b.length), 0);
  const tb0 = st2.timeBuffers[0] || [];
  chart.$streamTimestamps = maxLen ? [...Array(maxLen)].map((_, j) => tb0[j] ?? null) : [];
  chart.data.labels =
    maxLen && chart.$streamTimestamps.length
      ? chart.$streamTimestamps.map((ts) =>
          ts != null ? formatStreamChartLabel(ts, presetId === 'live' ? 'hour' : presetId) : ''
        )
      : maxLen
        ? [...Array(maxLen)].map((_, j) => `${j + 1}`)
        : [];
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

/** Algunas APIs / SSE envían lecturas solo bajo `properties`; subirlas al nivel superior para `getTelemetryPropertyValue`. */
function hoistTelemetryPropertiesLayer(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return src;
  const out = { ...src };
  const nest = out.properties;
  if (nest && typeof nest === 'object' && !Array.isArray(nest)) {
    for (const [k, v] of Object.entries(nest)) {
      const has = Object.prototype.hasOwnProperty.call(out, k);
      if (
        (!has || out[k] === undefined || out[k] === null) &&
        v !== undefined &&
        v !== null &&
        !(typeof v === 'string' && !String(v).trim()) &&
        !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
      ) {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Expande telemetría fusionada de un dispositivo (sin ref sticky del control del panel). */
function expandMergedDeviceTelemetryLive(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const base = hoistTelemetryPropertiesLayer(raw);
  return expandNestedGatewayTelemetry(base);
}

/** Metadatos del listado de dispositivos; no son lecturas de telemetría. */
const DEVICE_ROW_META_KEYS = new Set([
  'deviceId',
  'id',
  'device_id',
  'uuid',
  '_id',
  'name',
  'deviceName',
  'sn',
  'model',
  'productModel',
  'connectStatus',
  'registered',
  'registeredOnly',
  'assignments',
  'superadminGlobalView',
  'tag',
  'notes',
  'deviceSharedPresets',
  'lorawanClass',
  'licenseExpiresAt',
  'licenseValid',
  'licenseDaysLeft',
  'ingestStatus',
  'properties',
  'devEUI',
  'devEui',
  'lastUpdateTime',
]);

/**
 * Última telemetría conocida del listado/API para pintar widgets al abrir el modal sin esperar fetch.
 */
function buildSeedLivePropsFromDevice(dev) {
  return mergeDeviceTelemetryForWidgets(dev);
}

/** Clave de telemetría de entrada para la fórmula (si no se indica, la del campo principal). */
function telemetryFieldKeyForFormula(cfg, defaultKey) {
  const fs = cfg?.data?.formulaSourceKey != null ? String(cfg.data.formulaSourceKey).trim() : '';
  return fs || String(defaultKey ?? '').trim();
}

/** Aplica la fórmula del widget solo si la serie corresponde a la clave de entrada (evita mezclar series multi-campo). */
function pointValueAfterWidgetFormula(cfg, seriesFieldKey, numericVal) {
  if (numericVal == null || !Number.isFinite(numericVal)) return numericVal;
  const fk = String(seriesFieldKey ?? '').trim();
  if (!fk) return numericVal;
  if (telemetryFieldKeyForFormula(cfg, fk) !== fk) return numericVal;
  const t = transformWidgetNumeric(cfg, numericVal);
  return t != null && Number.isFinite(t) ? t : numericVal;
}

function computeTextWidgetUiForSlot(
  dk,
  widgetConfigs,
  slotWid,
  telemetryLiveProps,
  liveDeviceModel,
  telemetryHintMap
) {
  const key = dk(slotWid);
  const cfg = widgetConfigs[key];
  const fkRaw = cfg?.data?.fieldKey;
  const fkStr = fkRaw != null ? String(fkRaw).trim() : '';
  const readFk = telemetryFieldKeyForFormula(cfg, fkStr);
  const rawScalar =
    telemetryLiveProps && typeof telemetryLiveProps === 'object' && !Array.isArray(telemetryLiveProps)
      ? resolveTextWidgetRawScalar(telemetryLiveProps, readFk, cfg)
      : undefined;
  const useLive = Boolean(readFk) && !readFk.startsWith('__bsd_') && rawScalar !== undefined;
  const raw = useLive ? rawScalar : undefined;
  const decRaw = cfg?.data?.decimals;
  const dec =
    decRaw != null && decRaw !== '' && Number.isFinite(Number(decRaw))
      ? Math.min(20, Math.max(0, Number(decRaw)))
      : 2;
  const unit = cfg?.data?.unit != null ? String(cfg.data.unit) : '';
  const lastAtLine = formatLastTelemetryUpdateLine(telemetryLiveProps?.lastUpdateTime);
  const formulaActive =
    Boolean(cfg?.data?.formulaEnabled) && String(cfg?.data?.formulaExpression ?? '').trim() !== '';

  if (raw === undefined || raw === null) {
    const hint = !fkStr || fkStr.startsWith('__bsd_') ? 'Configura el campo en edición' : 'Sin dato en vivo';
    return { display: '—', hint, lastAtLine };
  }
  if (formulaActive) {
    const n = parseNumeric(raw);
    if (n !== null && Number.isFinite(n)) {
      const nd = transformWidgetNumeric(cfg, n);
      return { display: `${nd.toFixed(dec)}${unit ? ` ${unit}` : ''}`.trim(), hint: fkStr, lastAtLine };
    }
  } else {
    const formatted = formatWidgetTelemetryDisplay({
      model: liveDeviceModel,
      fieldKey: fkStr,
      raw,
      hintMap: telemetryHintMap,
      decimals: dec,
      unit,
      formulaActive: false,
    });
    if (formatted.usedProcessedLabel && formatted.display !== '—') {
      return { display: formatted.display, hint: fkStr, lastAtLine };
    }
    if (!formatted.usedProcessedLabel && formatted.display !== '—') {
      const n = parseNumeric(raw);
      if (n !== null && Number.isFinite(n)) {
        const nd = transformWidgetNumeric(cfg, n);
        return { display: `${nd.toFixed(dec)}${unit ? ` ${unit}` : ''}`.trim(), hint: fkStr, lastAtLine };
      }
      return { display: formatted.display, hint: fkStr, lastAtLine };
    }
  }
  const s = String(raw).trim();
  return { display: s.length ? s : '—', hint: fkStr, lastAtLine };
}

/** Epoch en ms; si el backend envía segundos (~1e9), lo pasa a ms para alinear con ventanas del dashboard. */
function toHistoryEpochMs(raw) {
  if (raw == null) return NaN;
  const n = typeof raw === 'number' ? raw : new Date(raw).getTime();
  if (!Number.isFinite(n)) return NaN;
  if (n > 0 && n < 1e11) return Math.round(n * 1000);
  return n;
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

/** Propiedades de telemetría en fila de listado (API ya fusiona `...p` en la raíz del objeto). */
function panelDeviceTelemetryProps(dev) {
  if (!dev || typeof dev !== 'object') return {};
  const payload = {};
  for (const [k, v] of Object.entries(dev)) {
    if (DEVICE_ROW_META_KEYS.has(k)) continue;
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) continue;
    payload[k] = v;
  }
  if (dev.properties && typeof dev.properties === 'object' && !Array.isArray(dev.properties)) {
    Object.assign(payload, dev.properties);
  }
  return payload;
}

function buildPanelSensors(devices, latestData) {
  const list = [];
  let nextId = 1;
  for (const dev of devices.slice(0, 6)) {
    const entry = findLocalEntry(dev, latestData || []);
    const fromApiRow = panelDeviceTelemetryProps(dev);
    const props = { ...fromApiRow, ...(entry?.properties || {}) };
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

const IMAGE_PROP_KEYS = ['imageUrl', 'image', 'photo', 'picture', 'snapshot', 'cam', 'thumbnail', 'urlImagen'];

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

/** Imagen subida (data URL), URL guardada en el widget, o (legado) URL en telemetría. */
function resolveImageDisplayUrl(liveProps, imageCfg) {
  const u = imageCfg?.data?.uploadedImageDataUrl;
  if (typeof u === 'string' && /^data:image\//i.test(u.trim())) return u.trim();
  const staticUrl = imageCfg?.data?.staticImageUrl;
  if (typeof staticUrl === 'string' && staticUrl.trim()) {
    const s = staticUrl.trim();
    if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) return s;
  }
  return pickImageUrl(liveProps);
}

function normalizeTelemetryList(rows) {
  if (Array.isArray(rows)) return rows;
  if (rows && Array.isArray(rows.data)) return rows.data;
  if (rows && Array.isArray(rows.records)) return rows.records;
  return [];
}

function telemetryValuePoints(rows, field, widgetCfg = null) {
  const list = normalizeTelemetryList(rows);
  const out = [];
  for (const r of list) {
    const tsRaw = r.timestamp ?? r.ts ?? r.time;
    const ts = toHistoryEpochMs(tsRaw);
    let rawProps = r.properties != null ? r.properties : r;
    if (typeof rawProps === 'string') {
      try {
        const p = JSON.parse(rawProps);
        rawProps = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
      } catch {
        rawProps = {};
      }
    }
    if (!rawProps || typeof rawProps !== 'object' || Array.isArray(rawProps)) rawProps = {};
    const props = expandNestedGatewayTelemetry(rawProps);
    const rawVal = resolveTextWidgetRawScalar(props, field, widgetCfg);
    const val = parseNumeric(rawVal);
    if (val === null || !Number.isFinite(ts)) continue;
    out.push({ ts, val });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Una sola pasada JSON + expand por fila; el gráfico lineal llama esto y luego extrae N series
 * sin repetir `expandNestedGatewayTelemetry` (antes: O(filas × series), costoso en Mes).
 * @returns {{ ts: number, props: Record<string, unknown> }[]}
 */
function buildStreamRowsPreparsed(rows) {
  const list = normalizeTelemetryList(rows);
  const out = [];
  for (const r of list) {
    const tsRaw = r.timestamp ?? r.ts ?? r.time;
    const ts = toHistoryEpochMs(tsRaw);
    if (!Number.isFinite(ts)) continue;
    let rawProps = r.properties != null ? r.properties : r;
    if (typeof rawProps === 'string') {
      try {
        const p = JSON.parse(rawProps);
        rawProps = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
      } catch {
        rawProps = {};
      }
    }
    if (!rawProps || typeof rawProps !== 'object' || Array.isArray(rawProps)) rawProps = {};
    out.push({ ts, props: expandNestedGatewayTelemetry(rawProps) });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function telemetryValuePointsFromPreparsed(preparsed, field, widgetCfg = null) {
  const out = [];
  for (const { ts, props } of preparsed) {
    const rawVal = resolveTextWidgetRawScalar(props, field, widgetCfg);
    const val = parseNumeric(rawVal);
    if (val === null) continue;
    out.push({ ts, val });
  }
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

/** Orden cronológico de claves `y-mo-d-...` frente a `localeCompare` (p. ej. 2025-9 antes de 2025-10). */
function compareBucketKeys(a, b, g) {
  const pa = String(a)
    .split('-')
    .map((x) => parseInt(x, 10));
  const pb = String(b)
    .split('-')
    .map((x) => parseInt(x, 10));
  if (pa.some((n) => !Number.isFinite(n)) || pb.some((n) => !Number.isFinite(n))) return String(a).localeCompare(String(b));
  if (g === 'year') return (pa[0] || 0) - (pb[0] || 0);
  if (g === 'month') return (pa[0] || 0) * 12 + (pa[1] || 0) - ((pb[0] || 0) * 12 + (pb[1] || 0));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function aggregateHistoryFromPoints(points, granularity, op, fieldKey = '') {
  if (!points.length) return { aggregate: null, series: [] };
  const effOp = isLikelyButtonOrStatusFieldKey(fieldKey) ? 'last' : op;
  const g = normalizeBarChartGranularity(granularity);
  if (!g) {
    const entries = points.map((p) => ({ ts: p.ts, val: p.val }));
    return { aggregate: applyAggOpToBucketEntries(entries, effOp), series: [] };
  }
  const bucketG = g === 'week' ? 'day' : g;
  const map = new Map();
  for (const p of points) {
    const k = bucketKeyUtc(p.ts, bucketG);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ ts: p.ts, val: p.val });
  }
  const keys = [...map.keys()].sort((a, b) => compareBucketKeys(a, b, bucketG));
  const series = keys.map((k) => applyAggOpToBucketEntries(map.get(k), effOp));
  const maxPts = 72;
  const trimmed = series.length > maxPts ? series.slice(-maxPts) : series;
  const aggregate = trimmed.length ? trimmed[trimmed.length - 1] : null;
  return { aggregate, series: trimmed };
}

const BAR_CHART_MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

function formatBucketAxisLabel(key, granularity) {
  const parts = key.split('-').map((x) => parseInt(x, 10));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return key;
  try {
    if (granularity === 'year') return String(parts[0]);
    if (granularity === 'month') return BAR_CHART_MONTHS[parts[1]] ?? key;
    if (granularity === 'day') {
      const d = new Date(Date.UTC(parts[0], parts[1], parts[2]));
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    if (granularity === 'hour') {
      const d = new Date(Date.UTC(parts[0], parts[1], parts[2], parts[3]));
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });
    }
    if (granularity === 'minute') {
      const d = new Date(Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4]));
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
  } catch {
    /* ignore */
  }
  return key;
}

/** Piso a minuto en epoch (ventanas de 60 / 1440 barras alineadas al minuto). */
function unixMinuteFloor(tsMs) {
  return Math.floor(tsMs / 60000) * 60000;
}

function unixHourFloor(tsMs) {
  return Math.floor(tsMs / 3600000) * 3600000;
}

function applyAggOpToVals(vals, op) {
  if (!vals.length) return null;
  if (op === 'min') return Math.min(...vals);
  if (op === 'max') return Math.max(...vals);
  if (op === 'sum') return vals.reduce((a, b) => a + b, 0);
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Number.isFinite(m) ? m : null;
}

/**
 * Incremento en el periodo: último − primero. Si el contador se reinicia (delta negativo),
 * suma solo los tramos positivos (medidores de agua / personas acumuladas).
 */
function incrementalTotalFromPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  if (points.length === 1) return 0;
  const first = points[0].val;
  const last = points[points.length - 1].val;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const simple = last - first;
  if (simple >= 0) return simple;
  let sum = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1].val;
    const b = points[i].val;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = b - a;
    sum += d >= 0 ? d : Math.max(0, b);
  }
  return sum;
}

function aggregateValueDateFilterPoints(points, operation) {
  const op = normalizeValueDateFilterOperation(operation);
  if (!Array.isArray(points) || !points.length) return null;
  if (op === 'delta') return incrementalTotalFromPoints(points);
  if (op === 'last') {
    const v = points[points.length - 1]?.val;
    return Number.isFinite(v) ? v : null;
  }
  return applyAggOpToBucketEntries(
    points.map((p) => ({ ts: p.ts, val: p.val })),
    op
  );
}

function applyDateFilterUiFooter(ui, cfg, agg) {
  if (!ui || !isValueDateFilterActive(cfg)) return ui;
  const lastAtLine = agg?.loading
    ? 'Cargando periodo…'
    : agg?.error
      ? String(agg.error)
      : agg?.label || formatValueDateFilterLabel(cfg);
  const next = { ...ui, lastAtLine };
  const hasVal = agg != null && agg.value != null && Number.isFinite(Number(agg.value));
  if (!agg?.loading && !hasVal) {
    if (Object.prototype.hasOwnProperty.call(next, 'display')) next.display = '—';
    if (Object.prototype.hasOwnProperty.call(next, 'hint')) next.hint = 'Sin datos en el periodo';
  }
  return next;
}

/** Si el filtro está activo, sustituye la telemetría en vivo por el agregado del periodo (o vacío). */
function overlayDateFilterTelemetry(baseTel, cfg, agg) {
  if (!isValueDateFilterActive(cfg)) return null;
  const fkRaw = cfg?.data?.fieldKey;
  const fk = fkRaw != null ? String(fkRaw).trim() : '';
  const overlay = {
    lastUpdateTime: baseTel && typeof baseTel === 'object' ? baseTel.lastUpdateTime : undefined,
  };
  if (!fk || fk.startsWith('__bsd_')) return overlay;
  const readFk = telemetryFieldKeyForFormula(cfg, fk);
  if (agg && agg.value != null && Number.isFinite(Number(agg.value))) {
    const v = Number(agg.value);
    if (readFk) overlay[readFk] = v;
    if (fk) overlay[fk] = v;
  }
  return overlay;
}

/** Puntos por intervalo con marca de tiempo (último evento gana en pulsadores / estados). */
function applyAggOpToBucketEntries(entries, op) {
  if (!entries.length) return null;
  if (op === 'last') {
    const sorted = [...entries].sort((a, b) => a.ts - b.ts);
    const v = sorted[sorted.length - 1].val;
    return Number.isFinite(v) ? v : null;
  }
  const vals = entries.map((e) => e.val).filter((n) => Number.isFinite(n));
  return applyAggOpToVals(vals, op);
}

/** @returns {Map<number, { ts: number, val: number }[]>} clave = inicio de minuto en ms */
function pointsByUnixMinute(points) {
  const map = new Map();
  for (const p of points) {
    const k = unixMinuteFloor(p.ts);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ ts: p.ts, val: p.val });
  }
  return map;
}

function valuesForMinuteSlots(slotStartsMs, minuteMap, op) {
  return slotStartsMs.map((t) => {
    const entries = minuteMap.get(t);
    if (!entries || !entries.length) return null;
    const v = applyAggOpToBucketEntries(entries, op);
    return v != null && Number.isFinite(v) ? v : null;
  });
}

/** @returns {Map<number, { ts: number, val: number }[]>} clave = inicio de hora en ms */
function pointsByUnixHour(points) {
  const map = new Map();
  for (const p of points) {
    const k = unixHourFloor(p.ts);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ ts: p.ts, val: p.val });
  }
  return map;
}

function valuesForHourSlots(slotStartsMs, hourMap, op) {
  return slotStartsMs.map((t) => {
    const entries = hourMap.get(t);
    if (!entries || !entries.length) return null;
    const v = applyAggOpToBucketEntries(entries, op);
    return v != null && Number.isFinite(v) ? v : null;
  });
}

const STREAM_DAY_BUCKET_MS = 15 * 60000;

/** Inicio del intervalo de 15 minutos (UTC) que contiene tsMs. */
function unixQuarterHourFloor(tsMs) {
  return Math.floor(Number(tsMs) / STREAM_DAY_BUCKET_MS) * STREAM_DAY_BUCKET_MS;
}

/** @returns {Map<number, { ts: number, val: number }[]>} clave = inicio de cada 15 min UTC */
function pointsByUnixQuarterHour(points) {
  const map = new Map();
  for (const p of points) {
    const k = unixQuarterHourFloor(p.ts);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ ts: p.ts, val: p.val });
  }
  return map;
}

function valuesForQuarterHourSlots(slotStartsMs, qMap, op) {
  return slotStartsMs.map((t) => {
    const entries = qMap.get(t);
    if (!entries || !entries.length) return null;
    const v = applyAggOpToBucketEntries(entries, op);
    return v != null && Number.isFinite(v) ? v : null;
  });
}

/** @returns {Map<number, { ts: number, val: number }[]>} clave = medianoche local en ms */
function pointsByLocalDay(points) {
  const map = new Map();
  for (const p of points) {
    const k = startOfLocalDayMs(p.ts);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ ts: p.ts, val: p.val });
  }
  return map;
}

function localCalendarDaySlots(fromMs, toMs) {
  const slots = [];
  const d = new Date(startOfLocalDayMs(fromMs));
  const end = startOfLocalDayMs(toMs);
  while (d.getTime() <= end) {
    slots.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return slots;
}

function localDayQuarterHourSlots(endMs) {
  const start = startOfLocalDayMs(endMs);
  const endQ = unixQuarterHourFloor(endMs);
  const slotStarts = [];
  for (let t = start; t <= endQ; t += STREAM_DAY_BUCKET_MS) slotStarts.push(t);
  return slotStarts;
}

function valuesForDaySlots(slotStartsMs, dayMap, op) {
  return slotStartsMs.map((t) => {
    const entries = dayMap.get(t);
    if (!entries || !entries.length) return null;
    const v = applyAggOpToBucketEntries(entries, op);
    return v != null && Number.isFinite(v) ? v : null;
  });
}

/**
 * Presets Hora–Mes del gráfico de barras: misma ventana que el gráfico lineal (`to` = ahora).
 * Evita filtrar con `cfg.timeframe.to` fijo u obsoleto mientras el fetch ya usa `now`.
 * @returns {({ fromMs: number, toMs: number }) | null}
 */
function barChartPresetDisplayBounds(granularity, nowMs) {
  const g = normalizeBarChartGranularity(granularity);
  return streamHistoryDisplayBounds(g, nowMs);
}

/** Tope de filas por preset: el eje ya limita puntos (p. ej. ≤500 por evento); menos filas = menos JSON/CPU en Mes. */
function streamHistoryPageSize(presetId) {
  switch (presetId) {
    case 'hour':
      return 400;
    case 'day':
      return 900;
    case 'week':
      return 700;
    case 'month':
      return 800;
    default:
      return 400;
  }
}

/** Mismos buckets que el gráfico de barras para un eje X legible. */
function bucketSlotsForStreamPreset(presetId, endMs) {
  const end = Number(endMs);
  if (!Number.isFinite(end)) return { slotStarts: [], bucketKind: null };
  if (presetId === 'hour') {
    const endMin = unixMinuteFloor(end);
    const slotStarts = [];
    for (let i = 59; i >= 0; i -= 1) slotStarts.push(endMin - i * 60000);
    return { slotStarts, bucketKind: 'minute' };
  }
  if (presetId === 'day') {
    /**
     * Desde las 00:00 locales hasta ahora, en pasos de 15 min.
     * Con 24 buckets horarios, todo lo ocurrido dentro de la misma hora se colapsaba en un solo punto.
     */
    return { slotStarts: localDayQuarterHourSlots(end), bucketKind: 'quarterHour' };
  }
  if (presetId === 'week') {
    return { slotStarts: localCalendarDaySlots(startOfLocalWeekMondayMs(end), end), bucketKind: 'day' };
  }
  if (presetId === 'month') {
    return { slotStarts: localCalendarDaySlots(startOfLocalMonthMs(end), end), bucketKind: 'day' };
  }
  return { slotStarts: [], bucketKind: null };
}

function aggregatePointsToStreamSlots(points, slotStarts, bucketKind, fieldKey) {
  if (!slotStarts.length || !bucketKind) return [];
  /** `last` en buckets anchos deja solo el reposo (p. ej. 1) si el pulso (3) no es el último del bucket; `max` conserva el evento. */
  const op = isLikelyButtonOrStatusFieldKey(fieldKey) ? 'max' : 'avg';
  if (bucketKind === 'minute') return valuesForMinuteSlots(slotStarts, pointsByUnixMinute(points), op);
  if (bucketKind === 'hour') return valuesForHourSlots(slotStarts, pointsByUnixHour(points), op);
  if (bucketKind === 'quarterHour')
    return valuesForQuarterHourSlots(slotStarts, pointsByUnixQuarterHour(points), op);
  if (bucketKind === 'day') return valuesForDaySlots(slotStarts, pointsByLocalDay(points), op);
  return [];
}

function buildStreamSeriesPreparedFromRows(series, sharedRows, streamWidgetCfg = null) {
  const preparsed = buildStreamRowsPreparsed(sharedRows);
  return series.map((meta) => {
    let points = telemetryValuePointsFromPreparsed(preparsed, meta.fieldKey, streamWidgetCfg);
    if (meta.valueMode === 'delta') points = applyDeltaHistoryPoints(points);
    points = points.map((p) => {
      if (!p || !Number.isFinite(p.val)) return p;
      const nv = pointValueAfterWidgetFormula(streamWidgetCfg, meta.fieldKey, p.val);
      return nv === p.val ? p : { ...p, val: nv };
    });
    return { meta, points };
  });
}

/**
 * Añade la lectura en vivo al historial persistido para que Hora/Día/etc. reflejen el mismo valor
 * que el widget Texto (p. ej. pulsador Short/Long/Double como número).
 */
/**
 * @param {{ formulaOnLiveAppend?: boolean }} [mergeOpts] Si `formulaOnLiveAppend` es false (p. ej. gráfico de barras),
 * no se aplica fórmula aquí: ese flujo transforma una sola vez antes de agregar por buckets.
 */
function mergeLiveIntoStreamSeriesPrepared(seriesPrepared, streamTel, streamWidgetCfg = null, mergeOpts = null) {
  if (!seriesPrepared.length) return seriesPrepared;
  if (!streamTel || typeof streamTel !== 'object' || Array.isArray(streamTel)) return seriesPrepared;
  const formulaOnLiveAppend = mergeOpts?.formulaOnLiveAppend !== false;
  const tel = expandMergedDeviceTelemetryLive(streamTel);
  const tsBase = toHistoryEpochMs(streamTel.lastUpdateTime);
  const now = Date.now();
  return seriesPrepared.map((sp) => {
    const fk = sp.meta?.fieldKey;
    let tsMs = Number.isFinite(tsBase) ? tsBase : now;
    /** Pulsador: alinear con «ahora» si `lastUpdateTime` va rezagado respecto al payload (evita caer en un bucket viejo). */
    if (isLikelyButtonOrStatusFieldKey(fk)) tsMs = Math.max(tsMs, now);
    const raw = resolveTextWidgetRawScalar(tel, fk, streamWidgetCfg);
    let val = parseNumeric(raw);
    if (val == null || !Number.isFinite(val)) return sp;
    if (formulaOnLiveAppend && streamWidgetCfg) {
      val = pointValueAfterWidgetFormula(streamWidgetCfg, fk, val);
    }
    if (sp.meta?.valueMode === 'delta') {
      if (sp.points.length) return sp;
      return { ...sp, points: [{ ts: tsMs, val: 0 }] };
    }
    const pts = sp.points;
    const last = pts.length ? pts[pts.length - 1] : null;
    let insertTs = tsMs;
    if (last && insertTs <= last.ts) insertTs = last.ts + 1;
    const btnLike = isLikelyButtonOrStatusFieldKey(fk);
    if (btnLike && last && unixMinuteFloor(last.ts) === unixMinuteFloor(insertTs)) {
      if (val === last.val) return sp;
      return { ...sp, points: [...pts.slice(0, -1), { ts: Math.max(last.ts, insertTs), val }] };
    }
    if (!last || insertTs > last.ts || val !== last.val) {
      return { ...sp, points: [...pts, { ts: insertTs, val }] };
    }
    return sp;
  });
}

/** Última lectura en vivo sobre puntos históricos (mismo criterio que el gráfico lineal). */
function mergeLiveIntoTelemetryPoints(points, fieldKey, telLive, barWidgetCfg = null) {
  const prepared = mergeLiveIntoStreamSeriesPrepared(
    [{ meta: { fieldKey }, points: Array.isArray(points) ? points : [] }],
    telLive,
    barWidgetCfg,
    { formulaOnLiveAppend: false }
  );
  return prepared[0]?.points ?? points;
}

/** Límite de barras en modo «Minuto» sobre intervalos muy largos (rendimiento). */
const BAR_CHART_MAX_MINUTE_SLOTS = 4000;

/** Pulsador / estados: una barra por lectura (mismo tope que puntos del lineal en modo por-evento). */
const BAR_CHART_MAX_EVENT_BARS = 500;

/**
 * Una barra por evento en el rango [fromMs, toMs] (orden cronológico; últimos N si hay muchos).
 */
function buildBarChartPerEventSeries(points, fromMs, toMs, granularity) {
  const lo = Number(fromMs);
  const hi = Number(toMs);
  const g = normalizeBarChartGranularity(granularity);
  let list = points.filter((p) => Number.isFinite(p.ts) && p.ts >= lo && p.ts <= hi);
  list.sort((a, b) => a.ts - b.ts);
  const truncated0 = list.length > BAR_CHART_MAX_EVENT_BARS;
  if (truncated0) list = list.slice(-BAR_CHART_MAX_EVENT_BARS);
  const labels = list.map((p) => {
    const d = new Date(p.ts);
    if (g === 'week' || g === 'month') {
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
    if (g === 'day') {
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  });
  const fullLabels = list.map((p) => new Date(p.ts).toLocaleString(undefined));
  const values = list.map((p) => p.val);
  return { labels, values, fullLabels, truncated: truncated0 };
}

/**
 * Series del widget de barras: «Hora» = 60 barras (1 min c/u), «Día» = 15 min desde las 00:00 locales,
 * «Semana»/«Mes» = días del calendario local (evita miles de categorías que deforman el eje X).
 * @returns {{ labels: string[], values: (number|null)[], fullLabels: string[], truncated: boolean }}
 */
function buildBarChartBucketSeries(points, granularity, op, fromMs, toMs, fieldKey = '') {
  if (!points.length) {
    return { labels: [], values: [], fullLabels: [], truncated: false };
  }
  const effOp = isLikelyButtonOrStatusFieldKey(fieldKey) ? 'last' : op;

  const g0 = normalizeBarChartGranularity(granularity);
  if (g0 && fieldKey && isLikelyButtonOrStatusFieldKey(fieldKey)) {
    return buildBarChartPerEventSeries(points, fromMs, toMs, granularity);
  }

  const buildFromMinuteSlots = (slotStartsMs, truncated) => {
    const minuteMap = pointsByUnixMinute(points);
    const values = valuesForMinuteSlots(slotStartsMs, minuteMap, effOp);
    const labels = slotStartsMs.map((ts) => {
      const d = new Date(ts);
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    });
    const fullLabels = slotStartsMs.map((ts) => {
      const d = new Date(ts);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    });
    return { labels, values, fullLabels, truncated };
  };

  const g = normalizeBarChartGranularity(granularity);

  if (!g) {
    const entries = points.map((p) => ({ ts: p.ts, val: p.val }));
    const v = applyAggOpToBucketEntries(entries, effOp);
    return {
      labels: ['Total'],
      values: [v],
      fullLabels: ['Intervalo completo'],
      truncated: false,
    };
  }

  if (g === 'hour') {
    const end = unixMinuteFloor(toMs);
    const slotStartsMs = [];
    for (let i = 59; i >= 0; i -= 1) slotStartsMs.push(end - i * 60000);
    return buildFromMinuteSlots(slotStartsMs, false);
  }

  if (g === 'day') {
    /** Misma resolución que el gráfico lineal en «Día»: 15 min desde las 00:00 locales. */
    const slotStartsMs = localDayQuarterHourSlots(toMs);
    const qMap = pointsByUnixQuarterHour(points);
    const values = valuesForQuarterHourSlots(slotStartsMs, qMap, effOp);
    const labels = slotStartsMs.map((ts) =>
      new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    );
    const fullLabels = slotStartsMs.map((ts) =>
      new Date(ts).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    );
    return { labels, values, fullLabels, truncated: false };
  }

  if (g === 'week') {
    const slotStartsMs = localCalendarDaySlots(startOfLocalWeekMondayMs(toMs), toMs);
    const dayMap = pointsByLocalDay(points);
    const values = valuesForDaySlots(slotStartsMs, dayMap, effOp);
    const labels = slotStartsMs.map((ts) =>
      new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    );
    const fullLabels = slotStartsMs.map((ts) =>
      new Date(ts).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    );
    return { labels, values, fullLabels, truncated: false };
  }

  if (g === 'month') {
    const slotStartsMs = localCalendarDaySlots(startOfLocalMonthMs(toMs), toMs);
    const dayMap = pointsByLocalDay(points);
    const values = valuesForDaySlots(slotStartsMs, dayMap, effOp);
    const labels = slotStartsMs.map((ts) =>
      new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    );
    const fullLabels = slotStartsMs.map((ts) =>
      new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
    );
    return { labels, values, fullLabels, truncated: false };
  }

  if (g === 'minute') {
    const start = unixMinuteFloor(fromMs);
    const end = unixMinuteFloor(toMs);
    const slotStartsMs = [];
    for (let t = start; t <= end; t += 60000) slotStartsMs.push(t);
    let truncated = false;
    let slots = slotStartsMs;
    if (slots.length > BAR_CHART_MAX_MINUTE_SLOTS) {
      slots = slots.slice(-BAR_CHART_MAX_MINUTE_SLOTS);
      truncated = true;
    }
    return buildFromMinuteSlots(slots, truncated);
  }

  const map = new Map();
  for (const p of points) {
    const k = bucketKeyUtc(p.ts, g);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ ts: p.ts, val: p.val });
  }
  const keys = [...map.keys()].sort((a, b) => compareBucketKeys(a, b, g));
  const values = keys.map((k) => applyAggOpToBucketEntries(map.get(k), effOp));
  const labels = keys.map((k) => formatBucketAxisLabel(k, g));
  return { labels, values, fullLabels: labels.slice(), truncated: false };
}

/** Timeout historial barras / lineal (evita «Cargando…» colgado si la red o SQLite van lentos). */
const BAR_CHART_FETCH_TIMEOUT_MS = 14000;
const STREAM_HISTORY_FETCH_TIMEOUT_MS = 14000;

function withTimeout(promise, ms, errTag = 'timeout') {
  let timer;
  const timeoutP = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(errTag)), ms);
  });
  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(timer));
}

/** Quita puntos casi duplicados (mismo pulso visto por buffer + merge). */
function dedupeBarChartLivePoints(points) {
  if (!Array.isArray(points) || points.length < 2) return points || [];
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const p of sorted) {
    if (!p || !Number.isFinite(p.ts) || !Number.isFinite(p.val)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.val === p.val && Math.abs(p.ts - prev.ts) < 140) continue;
    out.push(p);
  }
  return out;
}

/**
 * Pulsador / estatus: el mismo código (p. ej. Short=3) puede repetirse por retransmisiones, varias
 * filas en `telemetry` con `lastUpdateTime` distinto o pulsos duplicados en cliente; el gráfico
 * debe mostrar **un** evento por pulsación física.
 * Agrupa lecturas consecutivas del mismo valor si el hueco entre ellas ≤ maxInterMs y la ventana
 * desde el primer punto del grupo ≤ maxSpanMs (conserva el timestamp del primer punto del grupo).
 */
function collapseBarChartButtonBurstPoints(points, fieldKey) {
  if (!isLikelyButtonOrStatusFieldKey(fieldKey)) return points;
  if (!Array.isArray(points) || points.length <= 1) return points;
  const maxInterMs = 8000;
  const maxSpanMs = 22000;
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    const p = sorted[i];
    if (!p || !Number.isFinite(p.ts) || !Number.isFinite(p.val)) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let lastTs = p.ts;
    while (j < sorted.length) {
      const q = sorted[j];
      if (!q || !Number.isFinite(q.ts) || !Number.isFinite(q.val)) {
        j += 1;
        continue;
      }
      if (q.val !== p.val) break;
      if (q.ts - lastTs > maxInterMs) break;
      if (q.ts - p.ts > maxSpanMs) break;
      lastTs = q.ts;
      j += 1;
    }
    out.push({ ts: p.ts, val: p.val });
    i = j;
  }
  return out;
}

/**
 * Gráfico lineal alineado al de barras (pulsador/estatus): en Día/Semana/Mes un punto por evento
 * en la ventana, sin agregación por bucket que ocultaba Short/Long (p. ej. `last` = 1 al final).
 */
function streamPerEventTimelineForPreset(points, fieldKey, presetId, endMs = Date.now()) {
  if (!isLikelyButtonOrStatusFieldKey(fieldKey)) return null;
  const bounds = streamHistoryDisplayBounds(presetId, endMs);
  if (!bounds) return null;
  const lo = bounds.fromMs;
  const hi = bounds.toMs;
  let pts = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(p.ts) && Number.isFinite(p.val) && p.ts >= lo && p.ts <= hi)
    .sort((a, b) => a.ts - b.ts);
  pts = collapseBarChartButtonBurstPoints(pts, fieldKey);
  const MAX = 500;
  if (pts.length > MAX) pts = pts.slice(-MAX);
  if (!pts.length) return null;
  return {
    slotStarts: pts.map((p) => p.ts),
    vals: pts.map((p) => p.val),
  };
}

function mergeLivePulseBufferIntoPoints(points, pulses, fromMs, toMs) {
  if (!pulses || !pulses.length) return points;
  const lo = Number(fromMs);
  const hi = Number(toMs);
  const out = [...(Array.isArray(points) ? points : [])];
  for (const p of pulses) {
    if (!p || !Number.isFinite(p.ts) || !Number.isFinite(p.val)) continue;
    if (p.ts < lo || p.ts > hi) continue;
    out.push({ ts: p.ts, val: p.val });
  }
  return out;
}

/**
 * Si el último punto sigue desincronizado respecto al valor que ve el widget Texto,
 * añade una lectura coherente (p. ej. historial API con «Double» y JSON en vivo «Short»).
 */
function reconcileBarChartPointsWithLiveReading(points, fk, telLive, barCfg, now = Date.now()) {
  if (!isLikelyButtonOrStatusFieldKey(fk) || !telLive || typeof telLive !== 'object' || Array.isArray(telLive)) {
    return Array.isArray(points) ? points : [];
  }
  const tel = expandMergedDeviceTelemetryLive(telLive);
  const raw = resolveTextWidgetRawScalar(tel, fk, barCfg);
  const liveVal = parseNumeric(raw);
  if (liveVal == null || !Number.isFinite(liveVal)) return Array.isArray(points) ? points : [];

  let tsMs = toHistoryEpochMs(telLive.lastUpdateTime);
  if (!Number.isFinite(tsMs)) tsMs = now;
  tsMs = Math.max(tsMs, now);

  const sorted = [...(Array.isArray(points) ? points : [])].sort((a, b) => a.ts - b.ts);
  const last = sorted.length ? sorted[sorted.length - 1] : null;

  if (!last) return [{ ts: tsMs, val: liveVal }];

  if (last.val === liveVal) {
    const drift = Math.abs(tsMs - last.ts);
    if (drift < 90000) return sorted;
  }

  let insertTs = tsMs;
  if (insertTs <= last.ts) insertTs = last.ts + 1;
  return [...sorted, { ts: insertTs, val: liveVal }];
}

/**
 * Recomputa series del gráfico de barras desde filas cacheadas + telemetría en vivo (sin red).
 * Debe coincidir con la lógica del efecto principal (mismo cfg / barCfg / ventana).
 * @param {{ ts: number, val: number }[] | null} [livePulses] muestras en cliente (cambios de barChartLiveValueSig).
 */
function computeBarChartSeriesFromRows(rows, cfg, barCfg, fk, telSnapshot, now = Date.now(), livePulses = null) {
  const op = String(cfg.timeframe?.operation || 'avg');
  const gran = normalizeBarChartGranularity(cfg.timeframe?.granularity) || 'hour';
  const rollingWin = barChartPresetDisplayBounds(gran, now);
  let fromMs;
  let toMs;
  if (rollingWin) {
    ({ fromMs, toMs } = rollingWin);
  } else {
    fromMs = parseRelativeTime(cfg.timeframe?.from, now, 'from') ?? now - 90 * 86400000;
    toMs = parseRelativeTime(cfg.timeframe?.to, now, 'to') ?? now;
  }

  let points = telemetryValuePoints(rows, fk, barCfg);
  points = mergeLiveIntoTelemetryPoints(points, fk, telSnapshot, barCfg);
  points = reconcileBarChartPointsWithLiveReading(points, fk, telSnapshot, barCfg, now);
  points = mergeLivePulseBufferIntoPoints(points, livePulses, fromMs, toMs);
  points = dedupeBarChartLivePoints(points);
  points = collapseBarChartButtonBurstPoints(points, fk);
  points = points.map((p) => {
    if (!p || !Number.isFinite(p.val)) return p;
    const nv = pointValueAfterWidgetFormula(barCfg, fk, p.val);
    return nv === p.val ? p : { ...p, val: nv };
  });
  let { labels, values, fullLabels, truncated } = buildBarChartBucketSeries(points, gran, op, fromMs, toMs, fk);
  let hasNumeric = values.some((v) => v != null && Number.isFinite(v));

  if (!labels.length || !hasNumeric) {
    let liveOnly = mergeLiveIntoTelemetryPoints([], fk, telSnapshot, barCfg);
    liveOnly = reconcileBarChartPointsWithLiveReading(liveOnly, fk, telSnapshot, barCfg, now);
    liveOnly = mergeLivePulseBufferIntoPoints(liveOnly, livePulses, fromMs, toMs);
    liveOnly = dedupeBarChartLivePoints(liveOnly);
    liveOnly = collapseBarChartButtonBurstPoints(liveOnly, fk);
    liveOnly = liveOnly.map((p) => {
      if (!p || !Number.isFinite(p.val)) return p;
      const nv = pointValueAfterWidgetFormula(barCfg, fk, p.val);
      return nv === p.val ? p : { ...p, val: nv };
    });
    if (liveOnly.length) {
      const reb = buildBarChartBucketSeries(liveOnly, gran, op, fromMs, toMs, fk);
      const rebNum = reb.values.some((v) => v != null && Number.isFinite(v));
      if (reb.labels.length && rebNum) {
        ({ labels, values, fullLabels, truncated } = reb);
        hasNumeric = true;
      }
    }
  }

  if (!labels.length || !hasNumeric) return null;

  const tgtRaw = cfg.data?.barChartTarget;
  const targetNum = parseFloat(String(tgtRaw ?? '').replace(',', '.'));
  const hasTarget = Number.isFinite(targetNum);
  const legendActual = cfg.data?.barLegendActual != null ? String(cfg.data.barLegendActual) : 'Actual';
  const legendTarget = cfg.data?.barLegendTarget != null ? String(cfg.data.barLegendTarget) : 'Objetivo';
  const decRaw = cfg?.data?.decimals;
  const dec =
    decRaw != null && decRaw !== '' && Number.isFinite(Number(decRaw))
      ? Math.min(6, Math.max(0, Number(decRaw)))
      : 1;
  const unit = cfg?.data?.unit != null ? String(cfg.data.unit).trim() : '';

  const nBar = labels.length;
  const finiteVals = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  let yMin = 0;
  let yMax = 1;
  if (finiteVals.length) {
    yMin = Math.min(...finiteVals);
    yMax = Math.max(...finiteVals);
    if (hasTarget) {
      yMin = Math.min(yMin, targetNum);
      yMax = Math.max(yMax, targetNum);
    }
    const pad = Math.max((yMax - yMin) * 0.12, 0.25);
    yMin -= pad;
    yMax += pad;
  }

  const barFillColors = values.map((v) =>
    v == null || !Number.isFinite(v) ? 'rgba(148, 163, 184, 0.35)' : 'rgba(15, 118, 110, 0.92)'
  );
  const maxBarThickness = nBar > 600 ? 2 : nBar > 200 ? 3 : nBar > 80 ? 6 : nBar > 40 ? 14 : 48;

  return {
    labels,
    values,
    fullLabels,
    truncated,
    fk,
    hasTarget,
    targetNum,
    legendActual,
    legendTarget,
    dec,
    unit,
    nBar,
    yMin,
    yMax,
    barFillColors,
    maxBarThickness,
  };
}

/** Monta o actualiza Chart.js del widget de barras (reutilizado para precarga y tras fetch de historial). */
function mountBarChartFromComputed({
  computed,
  cfg,
  fk,
  canvasRef,
  chartRef,
  tooltipBridgeRef,
}) {
  if (!computed) return false;
  const canvas = canvasRef.current;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return false;

  const {
    labels,
    values,
    fullLabels,
    truncated,
    hasTarget,
    targetNum,
    legendActual,
    legendTarget,
    dec,
    unit,
    nBar,
    yMin,
    yMax,
    barFillColors,
    maxBarThickness,
  } = computed;

  if (chartRef.current) {
    chartRef.current.destroy();
    chartRef.current = null;
  }

  const scrollWrap = canvas.parentElement;
  let distFromRight = null;
  if (scrollWrap && scrollWrap.scrollWidth > scrollWrap.clientWidth) {
    distFromRight = scrollWrap.scrollWidth - scrollWrap.clientWidth - scrollWrap.scrollLeft;
  }
  const pxPerBar = nBar > 800 ? 2 : nBar > 400 ? 2.5 : nBar > 144 ? 3 : nBar > 60 ? 5 : 12;
  if (nBar > 36) {
    canvas.style.minWidth = `${Math.ceil(Math.max(320, nBar * pxPerBar))}px`;
  } else {
    canvas.style.minWidth = '';
  }

  const tickColor = 'rgba(255,255,255,0.92)';
  const xGrid = { display: true, color: 'rgba(255,255,255,0.07)', drawBorder: false };
  const yGrid = { display: true, color: 'rgba(255,255,255,0.08)', drawBorder: false };

  let chart;
  try {
    chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: legendActual,
            data: values,
            backgroundColor: barFillColors,
            borderColor: 'rgba(13, 148, 136, 1)',
            borderWidth: 0,
            borderRadius: nBar > 200 ? 1 : 4,
            maxBarThickness,
          },
          ...(hasTarget
            ? [
                {
                  type: 'line',
                  label: legendTarget,
                  data: labels.map(() => targetNum),
                  borderColor: '#ef4444',
                  backgroundColor: '#ef4444',
                  borderWidth: 2,
                  pointRadius: 0,
                  pointHoverRadius: 4,
                  pointBackgroundColor: '#ef4444',
                  tension: 0,
                  order: 0,
                },
              ]
            : []),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        datasets: {
          bar: {
            categoryPercentage: nBar > 120 ? 1 : 0.88,
            barPercentage: nBar > 120 ? 1 : 0.92,
          },
        },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: tickColor,
              font: { weight: '600', size: 11 },
              usePointStyle: true,
              padding: 14,
            },
          },
          tooltip: {
            callbacks: {
              title(items) {
                const i = items[0]?.dataIndex ?? 0;
                return fullLabels[i] ?? labels[i] ?? '';
              },
              label(item) {
                const ch = item.chart;
                const t = ch.$barTooltipCtx;
                const dsIdx = item.datasetIndex ?? 0;
                const leg = dsIdx > 0 ? legendTarget : legendActual;
                const v = item.parsed?.y;
                if (v == null || !Number.isFinite(v)) return `${leg}: sin dato`;
                const processed = formatTelemetryChartTooltipValue(
                  v,
                  t?.fieldKey || fk,
                  t?.model ?? null,
                  t?.hints ?? null,
                  {
                    unit,
                    decimals: dec,
                    ranges: t?.gauge?.ranges,
                    scaleMin: t?.gauge?.scaleMin,
                    scaleMax: t?.gauge?.scaleMax,
                  }
                );
                return `${leg}: ${processed}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: xGrid,
            ticks: {
              color: tickColor,
              font: { weight: '600', size: 10 },
              maxRotation: nBar > 80 ? 60 : 0,
              autoSkip: true,
              autoSkipPadding: 4,
              maxTicksLimit: nBar > 400 ? 16 : nBar > 120 ? 12 : nBar > 60 ? 10 : 24,
            },
          },
          y: {
            beginAtZero: false,
            suggestedMin: yMin,
            suggestedMax: yMax,
            grid: yGrid,
            ticks: {
              color: tickColor,
              font: { weight: '700', size: 11 },
              callback(v) {
                const n = Number(v);
                return Number.isFinite(n) ? n.toFixed(dec) : v;
              },
            },
            title: {
              display: true,
              text: unit ? `Valor (${unit})` : 'Valor',
              color: tickColor,
              font: { size: 11, weight: '600' },
            },
          },
        },
      },
    });
  } catch (e) {
    console.warn('[BSD bar chart] Chart init', e);
    return false;
  }

  chart.$barTooltipCtx = {
    fieldKey: fk,
    model: tooltipBridgeRef.current.model,
    hints: tooltipBridgeRef.current.hints,
    unit,
    dec,
    gauge: cfg.gauge,
  };
  chartRef.current = chart;
  chart.update('none');
  requestAnimationFrame(() => {
    const w = canvasRef.current?.parentElement;
    if (w && distFromRight != null) {
      const max = w.scrollWidth - w.clientWidth;
      if (max > 0) w.scrollLeft = Math.max(0, max - distFromRight);
    }
    safeChartResize(chartRef.current);
  });
  return { chart, truncated };
}

function deviceModelForDownlinks(deviceId, deviceRow, panelDevicesList) {
  if (deviceRow && String(deviceRow.deviceId) === String(deviceId)) {
    return deviceRow.model || deviceRow.productModel || '';
  }
  const dev = (panelDevicesList || []).find((d) => String(d.deviceId) === String(deviceId));
  return dev?.model || dev?.productModel || '';
}

function loadDownlinksFromStorage(deviceId, deviceModel) {
  if (!deviceId) return [];
  try {
    const list = readDownlinksFromLocalStorage(deviceId, { deviceModel });
    return Array.isArray(list) ? list.filter((d) => d && String(d.hex || '').trim()) : [];
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

/** Marca de tiempo en ms para comparar fuentes de telemetría (API vs almacén local). */
function telemetryTsToMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : null;
}

/** Texto corto para pie de widget con marca de tiempo del último dato persistido / fusionado. */
function formatLastTelemetryUpdateLine(ts) {
  if (ts == null) return '';
  const n = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!Number.isFinite(n)) return '';
  return `Última actualización: ${new Date(n).toLocaleString()}`;
}

/** Evita GET /properties por dispositivo en cada tick del panel. */
const panelPropertiesFetchAtByDevice = new Map();
/** Vista dispositivo (modal): /properties al abrir y como máximo cada 12 s. */
const deviceModalPropertiesFetchAtByDevice = new Map();
const DEVICE_MODAL_PROPERTIES_MIN_MS = 60000;

function deviceRowHasScalarTelemetry(dev) {
  if (!dev || typeof dev !== 'object') return false;
  for (const [k, v] of Object.entries(dev)) {
    if (DEVICE_ROW_META_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) continue;
    if (typeof v === 'string' && !String(v).trim()) continue;
    return true;
  }
  return false;
}

function deviceRowMatchesRealtimeId(dev, deviceId) {
  if (!dev || deviceId == null) return false;
  if (String(dev.deviceId) === String(deviceId)) return true;
  const norm = (v) => String(v || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  const rowEui = norm(dev.devEUI || dev.devEui || dev.deviceId);
  const evEui = norm(deviceId);
  return rowEui.length >= 8 && evEui.length >= 8 && rowEui === evEui;
}

/** Mezcla payload SSE sobre fila de dispositivo sin round-trip HTTP. */
function mergeRealtimeTelemetryIntoDeviceRow(dev, detail) {
  if (!dev || !detail?.properties || typeof detail.properties !== 'object') return dev;
  const p = detail.properties;
  const merged = {
    ...dev,
    ...p,
    deviceId: dev.deviceId,
    name: dev.name,
    tag: dev.tag,
    productModel: dev.productModel,
    lastUpdateTime: detail.timestamp != null ? detail.timestamp : dev.lastUpdateTime,
  };
  const ev = p.lorawan_event != null ? String(p.lorawan_event).trim() : '';
  if (ev && /join/i.test(ev)) merged.connectStatus = 'ONLINE';
  else if (p.connectStatus || p.status || p.payload_hex || p.fPort != null) {
    merged.connectStatus = p.connectStatus || p.status || merged.connectStatus || 'ONLINE';
  }
  return applyStaleOfflineConnectStatus(merged);
}

/**
 * @param {unknown} [preloadedLatest] si viene de un batch del panel, evita N llamadas idénticas a `/api/devices/latest`.
 * @param {{ alwaysFetchProperties?: boolean }} [opts] vista dispositivo: siempre refresca `/properties` en paralelo.
 */
async function mergeDeviceLive(dev, credentials, token, preloadedLatest = undefined, opts = {}) {
  if (!dev?.deviceId) return {};
  try {
    const did = String(dev.deviceId);
    const now = Date.now();
    const isDeviceView = opts.view === 'device';
    const lastDeviceModalFetch = deviceModalPropertiesFetchAtByDevice.get(did) || 0;
    const lastPanelFetch = panelPropertiesFetchAtByDevice.get(did) || 0;
    const shouldFetchProperties = isDeviceView
      ? opts.alwaysFetchProperties === true ||
        !hasMeaningfulAppTelemetry(dev) ||
        now - lastDeviceModalFetch >= DEVICE_MODAL_PROPERTIES_MIN_MS
      : opts.alwaysFetchProperties === true ||
        !hasMeaningfulAppTelemetry(dev) ||
        now - lastPanelFetch >= PANEL_PROPERTIES_FETCH_MIN_MS;

    const latestPromise =
      preloadedLatest !== undefined
        ? Promise.resolve(Array.isArray(preloadedLatest) ? preloadedLatest : [])
        : getLatestDeviceData().catch(() => []);

    const propsPromise = shouldFetchProperties
      ? fetchDeviceProperties(dev.deviceId, credentials, token).catch(() => null)
      : Promise.resolve(null);

    const [latest, propsResp] = await Promise.all([latestPromise, propsPromise]);

    let liveFromAPI = {};
    let apiData = {};
    if (propsResp) {
      if (isDeviceView) deviceModalPropertiesFetchAtByDevice.set(did, now);
      else panelPropertiesFetchAtByDevice.set(did, now);
      apiData = propsResp.data?.data || {};
      liveFromAPI = apiData.properties || propsResp.data?.properties || {};
    } else if (!shouldFetchProperties) {
      liveFromAPI = {};
      for (const k of Object.keys(dev)) {
        if (
          k === 'deviceId' ||
          k === 'name' ||
          k === 'assignments' ||
          k === 'registered' ||
          k === 'deviceSharedPresets'
        ) {
          continue;
        }
        if (dev[k] !== undefined && dev[k] !== null) liveFromAPI[k] = dev[k];
      }
    }
    const entry = findLocalEntry(dev, latest);
    const liveFromLocal = entry?.properties || {};
    const tsApi = telemetryTsToMs(apiData.lastTimestamp);
    const tsLocal = telemetryTsToMs(entry?.timestamp);
    /** Preferir la fuente con telemetría más reciente; si solo hay una con marca, esa gana en solapes. */
    const useApiOverlay = tsLocal == null || (tsApi != null && tsApi >= tsLocal);
    const propsMerged = useApiOverlay ? { ...liveFromLocal, ...liveFromAPI } : { ...liveFromAPI, ...liveFromLocal };
    const lastSeen = coalesceMaxSeenMs(apiData.lastTimestamp, entry?.timestamp, dev.lastUpdateTime);
    let merged = { ...dev, ...propsMerged };
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
  if (err.response?.data?.code === 'DEFER_INSERT_FAILED') return msg || 'No se pudo guardar el comando en cola hasta el próximo uplink.';
  if (err.response?.data?.code === 'DOWNLINK_FPORT_MISSING' || msg.includes('Puerto LoRaWAN')) {
    return 'FPort no configurado: el «puerto» de la plantilla debe guardarse en el dispositivo (decoder). Reaplique la plantilla o pida al superadmin que actualice el canal.';
  }
  if (msg.toLowerCase().includes('offline') || msg.toLowerCase().includes('desconect')) return 'Dispositivo fuera de línea.';
  if (msg.toLowerCase().includes('hex') || msg.toLowerCase().includes('invalid')) return 'Comando inválido.';
  if (status === 501) return 'Downlink no disponible en este modo.';
  return msg || 'Error al enviar comando.';
}

/** Barras de señal (cabecera del widget Texto, mismo lenguaje visual que las tarjetas de telemetría). */
function BsdTextWidgetSignalIcon({ className }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <rect x="1.5" y="13" width="3" height="5.5" rx="0.65" fill="currentColor" />
      <rect x="6.5" y="10" width="3" height="8.5" rx="0.65" fill="currentColor" />
      <rect x="11.5" y="6.5" width="3" height="12" rx="0.65" fill="currentColor" />
      <rect x="16.5" y="3" width="3" height="15.5" rx="0.65" fill="currentColor" />
    </svg>
  );
}

/**
 * Única implementación del tablero BSD: Panel Control (`variant="panel"`, página Dashboard)
 * y dashboard por dispositivo (`variant="device"`, modal desde Dispositivos). Rejilla,
 * galería «Agregar widget» y persistencia son las mismas para todos los usuarios y equipos;
 * no hay otra copia del grid que deba parchearse aparte.
 *
 * @param {{ variant?: 'panel' | 'device', device?: object | null, preloadedTelemetry?: object | null, embedded?: boolean, loadingExternal?: boolean, onRefresh?: () => void, refreshing?: boolean, readOnlyView?: boolean }} props
 */
export default function BudgetSensorsDashboard({
  variant = 'panel',
  device = null,
  preloadedTelemetry = null,
  embedded = false,
  loadingExternal = false,
  onRefresh,
  refreshing = false,
  readOnlyView = false,
}) {
  const { credentials, token, hasNavPage, canEditDashboard: canEditFromAuth, user, userProfile, isDemo } = useAuth();
  const canEditDashboard = canEditFromAuth && !readOnlyView;
  const canSendLnsCommands = Boolean(
    token && !isDemo && (hasNavPage('Devices') || variant === 'device' || variant === 'panel')
  );
  const { t } = useLanguage();
  const dashDeviceId = variant === 'device' ? resolveDeviceDashboardStorageId(device) : null;

  const panelOwnerSegment = useMemo(() => resolvePanelOwnerSegment(userProfile ?? user), [userProfile, user]);

  const [panelWorkspace, setPanelWorkspace] = useState(() => ({
    panels: [{ id: 'main', name: 'Panel principal' }],
    activePanelId: 'main',
  }));
  const panelWorkspaceRef = useRef(panelWorkspace);
  panelWorkspaceRef.current = panelWorkspace;
  /** `{ id, name }` mientras el modal de confirmación de borrado de panel está abierto. */
  const [panelDelete, setPanelDelete] = useState(null);

  useEffect(() => {
    if (variant !== 'panel') return;
    const seg = resolvePanelOwnerSegment(userProfile ?? user);
    if (!seg) return;
    const ws = loadPanelWorkspace(seg);
    if (ws) setPanelWorkspace(ws);
  }, [variant, userProfile, user]);
  const panelInstanceId =
    variant === 'panel' ? panelWorkspace.activePanelId || 'main' : 'main';

  const dk = useCallback(
    (wid) =>
      dashboardWidgetStorageKey(
        variant,
        dashDeviceId,
        wid,
        variant === 'panel' ? panelInstanceId : undefined,
        variant === 'panel' ? panelOwnerSegment : undefined
      ),
    [variant, dashDeviceId, panelInstanceId, panelOwnerSegment]
  );

  const selectPanelTab = useCallback((id) => {
    setPanelWorkspace((ws) => {
      const next = { ...ws, activePanelId: id };
      savePanelWorkspace(next, panelOwnerSegment);
      return next;
    });
  }, [panelOwnerSegment]);

  const addPanelTab = useCallback(() => {
    const id = `p_${Date.now().toString(36)}`;
    setPanelWorkspace((ws) => {
      const next = {
        panels: [...ws.panels, { id, name: `Panel ${ws.panels.length + 1}` }],
        activePanelId: id,
      };
      savePanelWorkspace(next, panelOwnerSegment);
      return next;
    });
  }, [panelOwnerSegment]);

  const renameActivePanel = useCallback(() => {
    if (variant !== 'panel') return;
    const cur = panelWorkspace.panels.find((p) => p.id === panelInstanceId);
    const name = window.prompt('Nombre del panel', cur?.name || '');
    if (name == null || !String(name).trim()) return;
    setPanelWorkspace((ws) => {
      const next = {
        ...ws,
        panels: ws.panels.map((p) =>
          p.id === panelInstanceId ? { ...p, name: String(name).trim() } : p
        ),
      };
      savePanelWorkspace(next, panelOwnerSegment);
      return next;
    });
  }, [variant, panelInstanceId, panelWorkspace.panels, panelOwnerSegment]);

  const closePanelDeleteDialog = useCallback(() => {
    setPanelDelete(null);
  }, []);

  const requestPanelDelete = useCallback(
    (panelId) => {
      if (variant !== 'panel') return;
      const pid = String(panelId || '').trim();
      if (!pid || pid === 'main') return;
      const ws = panelWorkspaceRef.current;
      if (ws.panels.length <= 1) return;
      const victim = ws.panels.find((p) => p.id === pid);
      if (!victim) return;
      setPanelDelete({ id: pid, name: victim.name });
    },
    [variant]
  );

  const commitPanelDelete = useCallback(async () => {
    if (!panelDelete || variant !== 'panel') return;
    const pid = String(panelDelete.id || '').trim();
    if (!pid || pid === 'main') return;
    const ws = panelWorkspaceRef.current;
    if (ws.panels.length <= 1) return;

    purgePanelInstanceStorage(panelOwnerSegment, pid);
    const filtered = ws.panels.filter((p) => p.id !== pid);
    const safeFiltered = filtered.length ? filtered : [{ id: 'main', name: 'Panel principal' }];
    let activePanelId = ws.activePanelId;
    if (activePanelId === pid) {
      const ix = ws.panels.findIndex((p) => p.id === pid);
      const pick = safeFiltered[Math.max(0, ix - 1)] || safeFiltered[0];
      activePanelId = pick.id;
    }
    const next = { panels: safeFiltered, activePanelId };
    setPanelWorkspace(next);
    savePanelWorkspace(next, panelOwnerSegment);

    const seg =
      panelOwnerSegment != null && String(panelOwnerSegment).trim()
        ? String(panelOwnerSegment).trim()
        : '';
    const uid = String((user && user.id) || (userProfile && userProfile.id) || '').trim();
    if (token && uid) {
      try {
        await putPanelBsdPreferences(seg, pid, {
          valueWidgets: {},
          gridLayout: [],
          visibility: {},
        });
      } catch {
        /* ignore */
      }
      try {
        const markerKey = `sycom_bsd_panel_remote_rev_${uid}_${encodeURIComponent(seg)}_${encodeURIComponent(pid)}`;
        localStorage.removeItem(markerKey);
      } catch {
        /* ignore */
      }
    }
  }, [panelDelete, variant, panelOwnerSegment, token, user?.id, userProfile?.id]);
  const gradId = useId().replace(/:/g, '');
  const metricCircularDomId = useId().replace(/:/g, '');

  const [panelLoading, setPanelLoading] = useState(variant === 'panel');
  const [satisfactionPct, setSatisfactionPct] = useState(83);
  const [sensors, setSensors] = useState(DEFAULT_SENSORS);

  const streamingRef = useRef(null);
  const streamChartWrapRef = useRef(null);
  /** Historial listo antes de que exista instancia Chart.js (ref del canvas aún null). */
  const streamHistoryPendingRef = useRef(null);
  const streamHistoryRowsRef = useRef([]);
  const streamHistoryRowsCacheKeyRef = useRef('');
  /** Generación del fetch de historial del stream: evita dejar `streamHistoryLoading` en true si un ciclo se cancela tras el await (p. ej. al guardar el widget). */
  const streamHistoryFetchTicketRef = useRef(0);
  const streamWidgetTelSnapshotRef = useRef(null);
  const streamChartWidgetCfgRef = useRef(null);
  const barChartWidgetCfgRef = useRef(null);
  const barWidgetTelSnapshotRef = useRef(null);
  const barHistoryRowsRef = useRef([]);
  const barHistoryRowsCacheKeyRef = useRef('');
  /** Evita dejar «Cargando historial» colgado si un efecto anterior se canceló tras setBarChartLoading(true). */
  const barChartEffectRunIdRef = useRef(0);
  /** true mientras queryTelemetry/fetch del widget barras (solo coordinación interna). */
  const barChartHistoryFetchInFlightRef = useRef(false);
  /** Pulsos recientes alineados al widget Texto (Short/Long/Double); sobrevive hasta el siguiente fetch de historial. */
  const barChartLivePulseBufferRef = useRef([]);
  /** Solo registra pulso en buffer si cambió el valor mostrado (evita duplicar por `lastUpdateTime` sin cambio real). */
  const barChartLastBufferedPulseValRef = useRef(null);
  const barChartCanvasRef = useRef(null);
  const barChartJsRef = useRef(null);
  const streamingChartRef = useRef(null);
  const streamingMultiRef = useRef(initStreamingMultiState(1));
  const lastStreamRef = useRef(23.5);
  const sensorsRef = useRef(sensors);
  const [streamDisplay, setStreamDisplay] = useState(23.5);
  const [streamTimePreset, setStreamTimePreset] = useState('live');
  const streamTimePresetRef = useRef(streamTimePreset);
  const streamPresetStorageKeyRef = useRef('');
  const streamPresetHydratedRef = useRef(false);
  /** Sincronizar antes de layout effects (p. ej. historial pendiente vs preset «1 h»). */
  streamTimePresetRef.current = streamTimePreset;

  useEffect(() => {
    if (streamTimePreset === 'live') streamHistoryPendingRef.current = null;
  }, [streamTimePreset]);
  const [streamHistoryLoading, setStreamHistoryLoading] = useState(false);
  const [streamHistoryError, setStreamHistoryError] = useState(null);
  const [streamHistoryFetchedAt, setStreamHistoryFetchedAt] = useState(null);
  /** Incrementa en intervalo cuando el lineal está en Hora/Día/… para volver a leer BD con ventana móvil. */
  const [streamHistoryPollEpoch, setStreamHistoryPollEpoch] = useState(0);

  useEffect(() => {
    if (STREAM_PRESET_IDS.has(streamTimePreset)) return;
    const legacy = { '15m': 'hour', '1h': 'hour', '1d': 'day', '1w': 'week', '1mo': 'month' };
    setStreamTimePreset(legacy[streamTimePreset] || 'live');
  }, [streamTimePreset]);
  const [barChartLoading, setBarChartLoading] = useState(false);
  const [barChartError, setBarChartError] = useState(null);
  const [barChartHint, setBarChartHint] = useState('');
  /** Incrementa cada 5 s con el widget visible: fuerza nueva consulta de historial (evita cerrar el modal). */
  const [barAutoRefreshEpoch, setBarAutoRefreshEpoch] = useState(0);

  const [panelDevices, setPanelDevices] = useState([]);
  const panelDevicesRef = useRef(panelDevices);
  /** Refrescos puntuales vía SSE (sin esperar al intervalo). */
  const deviceLiveTickRef = useRef(() => Promise.resolve());
  const panelListTickRef = useRef(() => Promise.resolve());
  const panelMergeTickRef = useRef(() => Promise.resolve());
  const lastRealtimeTelemetryMsRef = useRef(0);
  const [controlDeviceId, setControlDeviceId] = useState(null);
  const [liveProps, setLiveProps] = useState(() => {
    if (variant !== 'device' || !device) return {};
    if (preloadedTelemetry && typeof preloadedTelemetry === 'object' && Object.keys(preloadedTelemetry).length) {
      return mergeDeviceTelemetryForWidgets(device, preloadedTelemetry);
    }
    return mergeDeviceTelemetryForWidgets(device);
  });
  const livePropsRef = useRef(liveProps);
  livePropsRef.current = liveProps;
  /** Panel: telemetría fusionada por deviceId (widgets enlazan dispositivos distintos al «control»). */
  const [panelTelemetryByDeviceId, setPanelTelemetryByDeviceId] = useState({});
  /** Incrementa en cada SSE de telemetría para repintar widgets Texto/Circular sin esperar al poll HTTP. */
  const [panelLiveTelemetryEpoch, setPanelLiveTelemetryEpoch] = useState(0);
  const panelTelemetryByDeviceIdRef = useRef(panelTelemetryByDeviceId);
  /** Conserva claves de telemetría entre refrescos si el nuevo payload no las trae (p. ej. RSSI ausente en una tanda). */
  const telemetryStickyRef = useRef({ key: '', merged: {} });
  /**
   * Texto / número ya formateados por celda de widget Texto cuando en vivo falta el campo un instante:
   * sigue mostrando el último dato recibido en pantalla (no sustituye la marca «Última actualización»).
   */
  const textWidgetDisplayStickyRef = useRef({});
  /** Último escalar por `deviceId|fieldKey` desde SQLite cuando el uplink en vivo no trae el campo. */
  const [dbScalarByDeviceField, setDbScalarByDeviceField] = useState({});
  const dbScalarFetchGenRef = useRef(0);
  /** Agregado del filtro por fechas en widgets de valor (`storageKey` → { value, label, error, loading }). */
  const [dateFilterAggByKey, setDateFilterAggByKey] = useState({});
  const [dateFilterEpoch, setDateFilterEpoch] = useState(0);
  const [dateFilterCustomSlotId, setDateFilterCustomSlotId] = useState(null);
  const [dateFilterCustomDraft, setDateFilterCustomDraft] = useState({ from: '', to: '' });
  const telemetryLiveProps = useMemo(() => {
    const deviceKey =
      variant === 'device' && dashDeviceId != null && String(dashDeviceId).trim().length
        ? `d:${String(dashDeviceId).trim()}`
        : controlDeviceId != null
          ? `p:${String(controlDeviceId)}`
          : '';
    const deviceLayer =
      variant === 'device' && device ? mergeDeviceTelemetryForWidgets(device) : {};
    const rawBase = hoistTelemetryPropertiesLayer({
      ...deviceLayer,
      ...(liveProps && typeof liveProps === 'object' && !Array.isArray(liveProps) ? liveProps : {}),
    });
    const expanded = expandNestedGatewayTelemetry(rawBase);
    if (telemetryStickyRef.current.key !== deviceKey) {
      telemetryStickyRef.current = { key: deviceKey, merged: {} };
    }
    const prev = telemetryStickyRef.current.merged;
    const next = { ...prev };
    for (const [k, v] of Object.entries(expanded)) {
      /**
       * No pisar el último valor con `null`/vacío: algunos backends repiten marca de tiempo sin repetir
       * todos los campos o envían cadena vacía donde antes había estado del pulsador.
       */
      if (
        v !== undefined &&
        v !== null &&
        !(typeof v === 'string' && v.trim() === '') &&
        !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
      ) {
        next[k] = v;
      }
    }
    const mergedTs = coalesceMaxSeenMs(expanded.lastUpdateTime, prev.lastUpdateTime);
    if (mergedTs != null) next.lastUpdateTime = mergedTs;
    telemetryStickyRef.current.merged = next;
    return next;
  }, [liveProps, device, variant, dashDeviceId, controlDeviceId]);

  const panelTelemetryExpandedByDeviceId = useMemo(() => {
    const o = {};
    for (const [id, raw] of Object.entries(panelTelemetryByDeviceId)) {
      o[id] = expandMergedDeviceTelemetryLive(raw);
    }
    return o;
  }, [panelTelemetryByDeviceId]);

  const lastTelemetryAtLabel = useMemo(
    () => formatLastTelemetryUpdateLine(telemetryLiveProps?.lastUpdateTime),
    [telemetryLiveProps?.lastUpdateTime]
  );

  /** Modelo del equipo cuyos widgets leen `telemetryLiveProps` (vista dispositivo o control del panel). */
  const liveDeviceModel = useMemo(() => {
    if (variant === 'device') return device?.model != null ? String(device.model) : '';
    const dev = (panelDevices || []).find((d) => String(d.deviceId) === String(controlDeviceId));
    return dev?.model != null ? String(dev.model) : '';
  }, [variant, device, panelDevices, controlDeviceId]);

  useEffect(() => {
    textWidgetDisplayStickyRef.current = {};
    setDbScalarByDeviceField({});
    dbScalarFetchGenRef.current = 0;
  }, [variant, dashDeviceId, controlDeviceId]);

  /** Pintura instantánea al abrir / actualizar el modal de dispositivo (fila listado + props en `device`). */
  useEffect(() => {
    if (variant !== 'device' || !device) return;
    const key = `d:${String(device.deviceId || '').trim()}`;
    telemetryStickyRef.current = { key, merged: {} };
    textWidgetDisplayStickyRef.current = {};
    const seed =
      preloadedTelemetry && typeof preloadedTelemetry === 'object' && Object.keys(preloadedTelemetry).length
        ? mergeDeviceTelemetryForWidgets(device, preloadedTelemetry)
        : mergeDeviceTelemetryForWidgets(device);
    setLiveProps(seed);
    const devSid =
      resolveDeviceDashboardStorageId(device) ||
      (device.deviceId != null ? String(device.deviceId) : '');
    const built = propertiesToSensors(seed, 1, '', devSid);
    if (built.length) setSensors(built);
  }, [variant, device, preloadedTelemetry]);

  /** Al abrir el modal: /properties solo si no hay precarga del listado (evita doble fetch con DeviceDashboardModal). */
  useEffect(() => {
    if (variant !== 'device' || !device?.deviceId) return;
    if (
      preloadedTelemetry &&
      typeof preloadedTelemetry === 'object' &&
      Object.keys(preloadedTelemetry).length &&
      hasMeaningfulAppTelemetry(preloadedTelemetry)
    ) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const merged = await mergeDeviceLive(device, credentials, token, {
          view: 'device',
          alwaysFetchProperties: true,
        });
        if (cancelled) return;
        const flat = mergeDeviceTelemetryForWidgets(device, merged);
        setLiveProps(flat);
        const devSid =
          resolveDeviceDashboardStorageId(device) ||
          (device.deviceId != null ? String(device.deviceId) : '');
        const built = propertiesToSensors(flat, 1, '', devSid);
        if (built.length) setSensors(built);
        setSatisfactionPct(isDeviceVisuallyOnline({ ...device, ...flat }) ? 100 : 0);
      } catch (e) {
        console.warn('[BudgetSensorsDashboard] device initial properties', e?.message || e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [variant, device?.deviceId, credentials, token, preloadedTelemetry]);

  const resolveTelemetryRowModel = useCallback(
    (sourceDeviceId) => {
      if (variant === 'device') return device?.model != null ? String(device.model) : '';
      if (sourceDeviceId == null || sourceDeviceId === 'demo') return '';
      const dev = (panelDevices || []).find((d) => String(d.deviceId) === String(sourceDeviceId));
      return dev?.model != null ? String(dev.model) : '';
    },
    [variant, device, panelDevices]
  );

  /** Etiquetas on/off desde la plantilla vinculada (generadas con «Ajustar» en Plantillas). */
  const telemetryHintMap = useMemo(() => {
    const id =
      variant === 'device' && dashDeviceId != null && String(dashDeviceId).trim().length
        ? String(dashDeviceId).trim()
        : controlDeviceId != null
          ? String(controlDeviceId)
          : '';
    if (!id) return null;
    return getTelemetryLabelHintsForDevice(id);
  }, [variant, dashDeviceId, controlDeviceId]);

  const telemetryHintsForSensor = useCallback(
    (sourceDeviceId) => {
      if (sourceDeviceId == null || sourceDeviceId === 'demo') return telemetryHintMap;
      return getTelemetryLabelHintsForDevice(String(sourceDeviceId));
    },
    [telemetryHintMap]
  );
  const [downlinkList, setDownlinkList] = useState([]);
  /** HEX normalizados en envío; ref + tick para re-render sin bloquear otros botones. */
  const downlinkSendingHexRef = useRef(new Set());
  const [downlinkSendingVersion, setDownlinkSendingVersion] = useState(0);

  useEffect(() => {
    panelDevicesRef.current = panelDevices;
  }, [panelDevices]);

  useEffect(() => {
    panelTelemetryByDeviceIdRef.current = panelTelemetryByDeviceId;
  }, [panelTelemetryByDeviceId]);

  const [widgetConfigs, setWidgetConfigs] = useState(() =>
    migrateLegacySharedDeviceWidgetConfigs(loadAllWidgetConfigs(), variant, device)
  );
  const widgetConfigsRef = useRef(widgetConfigs);
  widgetConfigsRef.current = widgetConfigs;

  /**
   * `migrateLegacyPanelDataToOwner` escribe claves nuevas en localStorage (`panel|dashboard_<usuario>_…|`).
   * Sin recargar estado, `dk()` apunta al namespace con usuario pero `widgetConfigs` sigue siendo el snapshot inicial → gráfico lineal vacío / sin series.
   */
  useEffect(() => {
    if (variant !== 'panel') return;
    const seg = resolvePanelOwnerSegment(userProfile ?? user);
    if (!seg) return;
    migrateLegacyPanelDataToOwner(seg);
    setWidgetConfigs(loadAllWidgetConfigs());
  }, [variant, userProfile, user]);

  /** Misma disciplina que al cambiar de equipo en dispositivo: al cambiar segmento o pestaña, releer el mapa completo desde disco (claves `dk()` distintas). */
  useEffect(() => {
    if (variant !== 'panel') return;
    setWidgetConfigs(loadAllWidgetConfigs());
  }, [variant, panelInstanceId, panelOwnerSegment]);

  const [editModalCtx, setEditModalCtx] = useState(null);
  /** Panel: dispositivo en vista previa en el modal (selección aún no guardada) para fusionar telemetría. */
  const [panelModalPreviewDeviceId, setPanelModalPreviewDeviceId] = useState(null);
  /** Incrementa al abrir el modal para remount limpio (evita reset vía useEffect y cumple reglas de hooks). */
  const [widgetEditSession, setWidgetEditSession] = useState(0);
  const openWidgetEditModal = useCallback((ctx) => {
    setWidgetEditSession((n) => n + 1);
    setEditModalCtx(ctx);
  }, []);

  /** Lee `widgetConfigs` vía ref para que el callback no cambie al editar otro widget del tablero. */
  const resolveWidgetBoundDeviceId = useCallback(
    (wid) => {
      if (variant === 'device') {
        return dashDeviceId != null && String(dashDeviceId).trim().length
          ? String(dashDeviceId).trim()
          : null;
      }
      if (variant !== 'panel') return controlDeviceId ? String(controlDeviceId) : null;
      const cfg = widgetConfigsRef.current[dk(wid)];
      const b = cfg?.data?.panelBoundDeviceId;
      if (b != null && String(b).trim()) return String(b).trim();
      return controlDeviceId ? String(controlDeviceId) : null;
    },
    [variant, dk, controlDeviceId, dashDeviceId]
  );

  /** Rango En vivo / Hora / Día… guardado en localStorage con el widget (sobrevive al cierre de sesión). */
  useEffect(() => {
    const key = dk(DASH_WIDGET.STREAM);
    if (streamPresetStorageKeyRef.current !== key) {
      streamPresetStorageKeyRef.current = key;
      streamPresetHydratedRef.current = false;
    }
    if (streamPresetHydratedRef.current) return;
    const merged = mergeWidgetConfig(
      dashboardWidgetSensorStub(DASH_WIDGET.STREAM),
      widgetConfigs[key] || {}
    );
    const raw = merged.data?.historyRangePreset;
    const id = STREAM_PRESET_IDS.has(String(raw)) ? String(raw) : 'live';
    setStreamTimePreset(id);
    streamPresetHydratedRef.current = true;
  }, [dk, widgetConfigs]);

  const telemetryLivePropsForPanelWidget = useCallback(
    (wid) => {
      if (variant !== 'panel') return telemetryLiveProps;
      const id = resolveWidgetBoundDeviceId(wid);
      if (!id) return telemetryLiveProps;
      if (controlDeviceId && String(id) === String(controlDeviceId)) return telemetryLiveProps;
      return panelTelemetryExpandedByDeviceId[id] || {};
    },
    [variant, telemetryLiveProps, controlDeviceId, resolveWidgetBoundDeviceId, panelTelemetryExpandedByDeviceId]
  );

  const resolveLiveDeviceModelForPanelWidget = useCallback(
    (wid) => {
      if (variant !== 'panel') return liveDeviceModel;
      const devId = resolveWidgetBoundDeviceId(wid);
      const dev = panelDevices.find((d) => String(d.deviceId) === String(devId));
      return dev?.model != null ? String(dev.model) : '';
    },
    [variant, liveDeviceModel, panelDevices, resolveWidgetBoundDeviceId]
  );

  const resolveTelemetryHintsForPanelWidget = useCallback(
    (wid) => {
      if (variant !== 'panel') return telemetryHintMap;
      const devId = resolveWidgetBoundDeviceId(wid);
      return devId ? getTelemetryLabelHintsForDevice(String(devId)) : telemetryHintMap;
    },
    [variant, telemetryHintMap, resolveWidgetBoundDeviceId]
  );

  /** Tooltips Chart.js: valores al pintar sin enlazar efectos entre widgets. */
  const streamChartTooltipBridgeRef = useRef({ model: '', hints: null });
  streamChartTooltipBridgeRef.current = {
    model: resolveLiveDeviceModelForPanelWidget(DASH_WIDGET.STREAM),
    hints: resolveTelemetryHintsForPanelWidget(DASH_WIDGET.STREAM),
  };
  const barChartTooltipBridgeRef = useRef({ model: '', hints: null });
  barChartTooltipBridgeRef.current = {
    model: resolveLiveDeviceModelForPanelWidget(DASH_WIDGET.BAR_CHART),
    hints: resolveTelemetryHintsForPanelWidget(DASH_WIDGET.BAR_CHART),
  };

  const [aggregateByKey, setAggregateByKey] = useState({});
  const [dashboardEditMode, setDashboardEditMode] = useState(false);
  const [widgetGallerySearch, setWidgetGallerySearch] = useState('');
  const [widgetGalleryOpen, setWidgetGalleryOpen] = useState(false);
  const [widgetGalleryCategory, setWidgetGalleryCategory] = useState('all');
  const dashboardLayoutLocked = !canEditDashboard || !dashboardEditMode;
  const [visibilityMap, setVisibilityMap] = useState(() =>
    loadDashboardVisibility(
      variant,
      dashDeviceId,
      variant === 'panel' ? panelInstanceId : undefined,
      variant === 'panel' ? panelOwnerSegment : undefined
    )
  );
  const visibilityMapRef = useRef(visibilityMap);
  visibilityMapRef.current = visibilityMap;
  const [aggregateSeriesByKey, setAggregateSeriesByKey] = useState({});
  const [trackingPathPoints, setTrackingPathPoints] = useState([]);
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [trackingError, setTrackingError] = useState(null);
  /** Tarjetas de sensor ocultas solo en la vista (no borran telemetría). */
  const [hiddenSensorCardKeys, setHiddenSensorCardKeys] = useState(() => new Set());

  useEffect(() => {
    if (visibilityMap[DASH_WIDGET.STREAM] === false) setStreamHistoryLoading(false);
  }, [visibilityMap[DASH_WIDGET.STREAM]]);

  const streamWidgetStorageKey = dk(DASH_WIDGET.STREAM);
  const streamWidgetSlice = widgetConfigs[streamWidgetStorageKey];
  const barWidgetStorageKey = dk(DASH_WIDGET.BAR_CHART);
  const barWidgetSlice = widgetConfigs[barWidgetStorageKey];
  const streamSeriesNormalized = useMemo(
    () => normalizeStreamSeriesConfig(streamWidgetSlice?.data),
    [streamWidgetSlice]
  );
  const streamSeriesChartKey = useMemo(() => {
    const c = streamWidgetSlice;
    const g = c?.gauge;
    return JSON.stringify({
      series: streamSeriesNormalized.map((s) => [
        s.fieldKey,
        s.chartType,
        s.color,
        s.yAxis,
        s.interpolation,
        s.valueMode,
        s.label,
      ]),
      gauge: g ? { ranges: g.ranges, scaleMin: g.scaleMin, scaleMax: g.scaleMax } : null,
      decimals: c?.data?.decimals,
      unit: c?.data?.unit,
    });
  }, [streamSeriesNormalized, streamWidgetSlice]);

  const streamChartWidgetCfgMerged = useMemo(
    () =>
      mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.STREAM), widgetConfigs[streamWidgetStorageKey] || {}),
    [widgetConfigs, streamWidgetStorageKey]
  );
  const barChartWidgetCfgMerged = useMemo(
    () =>
      mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.BAR_CHART), widgetConfigs[barWidgetStorageKey] || {}),
    [widgetConfigs, barWidgetStorageKey]
  );
  streamChartWidgetCfgRef.current = streamChartWidgetCfgMerged;
  barChartWidgetCfgRef.current = barChartWidgetCfgMerged;

  /** Refresco del preset histórico al cambiar la telemetría en vivo; también sincroniza «último evento». */
  const streamWidgetLivePaintKey = useMemo(() => {
    const tel = telemetryLivePropsForPanelWidget(DASH_WIDGET.STREAM);
    if (!tel || typeof tel !== 'object' || Array.isArray(tel)) return '';
    const exp = expandMergedDeviceTelemetryLive(tel);
    const parts = streamSeriesNormalized.map((s) => {
      const r = resolveTextWidgetRawScalar(exp, s.fieldKey, streamChartWidgetCfgMerged);
      const n = parseNumeric(r);
      const sig =
        n != null && Number.isFinite(n)
          ? String(n)
          : r !== undefined && r !== null
            ? typeof r === 'string'
              ? r
              : JSON.stringify(r)
            : '_';
      return `${s.fieldKey}=${sig}`;
    });
    return `${tel.lastUpdateTime ?? ''}|${parts.join(';')}`;
  }, [telemetryLivePropsForPanelWidget, streamSeriesNormalized, streamChartWidgetCfgMerged]);

  streamWidgetTelSnapshotRef.current = telemetryLivePropsForPanelWidget(DASH_WIDGET.STREAM);

  useEffect(() => {
    setVisibilityMap(
      loadDashboardVisibility(
        variant,
        dashDeviceId,
        variant === 'panel' ? panelInstanceId : undefined,
        variant === 'panel' ? panelOwnerSegment : undefined
      )
    );
  }, [variant, dashDeviceId, panelInstanceId, panelOwnerSegment]);

  const hiddenCardsScope = variant === 'device' ? device?.deviceId : controlDeviceId;
  useEffect(() => {
    setHiddenSensorCardKeys(new Set());
  }, [variant, hiddenCardsScope]);

  const dashboardGridLayoutKey = useMemo(
    () =>
      dashboardGridLayoutStorageKey(
        variant,
        dashDeviceId,
        variant === 'panel' ? panelInstanceId : undefined,
        variant === 'panel' ? panelOwnerSegment : undefined
      ),
    [variant, dashDeviceId, panelInstanceId, panelOwnerSegment]
  );

  const bsdServerPushTimerRef = useRef(null);
  /** Evita que `fetch*BsdPreferences` pise localStorage mientras subimos cambios al servidor. */
  const bsdServerPushInFlightRef = useRef(false);
  const runBsdServerPushNowRef = useRef(async () => Promise.resolve());
  const scheduleBsdServerPersistRef = useRef(() => {});

  /** Tras cada cambio local del BSD, subir el bundle al servidor con debounce (vista dispositivo: por equipo; panel: por segmento y pestaña). */
  useEffect(() => {
    const runServerPush = async () => {
      if (!token) return;
      const uid = String((user && user.id) || (userProfile && userProfile.id) || '').trim();
      if (!uid) return;
      if (variant === 'device') {
        const id = String(dashDeviceId || '').trim();
        if (!id) return;
        bsdServerPushInFlightRef.current = true;
        try {
          const bundle = collectDeviceBsdBundle(id);
          if (!bundle) return;
          const data = await putDeviceBsdPreferences(id, bundle);
          const updatedAt = data?.updatedAt != null ? String(data.updatedAt) : '';
          if (updatedAt) {
            try {
              localStorage.setItem(`sycom_bsd_remote_rev_${uid}_${id}`, updatedAt);
            } catch {
              /* ignore */
            }
          }
        } catch (e) {
          console.warn('[BSD] persistencia servidor:', e?.message || e);
        } finally {
          bsdServerPushInFlightRef.current = false;
        }
        return;
      }
      if (variant === 'panel') {
        const pid =
          panelInstanceId != null && String(panelInstanceId).trim()
            ? String(panelInstanceId).trim()
            : 'main';
        const seg =
          panelOwnerSegment != null && String(panelOwnerSegment).trim()
            ? String(panelOwnerSegment).trim()
            : '';
        bsdServerPushInFlightRef.current = true;
        try {
          const bundle = collectPanelBsdBundle(panelOwnerSegment, pid);
          if (!bundle) return;
          const data = await putPanelBsdPreferences(seg, pid, bundle);
          const updatedAt = data?.updatedAt != null ? String(data.updatedAt) : '';
          if (updatedAt) {
            try {
              const markerKey = `sycom_bsd_panel_remote_rev_${uid}_${encodeURIComponent(seg)}_${encodeURIComponent(pid)}`;
              localStorage.setItem(markerKey, updatedAt);
            } catch {
              /* ignore */
            }
          }
        } catch (e) {
          console.warn('[BSD] persistencia servidor:', e?.message || e);
        } finally {
          bsdServerPushInFlightRef.current = false;
        }
      }
    };

    runBsdServerPushNowRef.current = runServerPush;

    scheduleBsdServerPersistRef.current = () => {
      if (!token) return;
      const uid = String((user && user.id) || (userProfile && userProfile.id) || '').trim();
      if (!uid) return;
      if (bsdServerPushTimerRef.current != null) clearTimeout(bsdServerPushTimerRef.current);
      bsdServerPushTimerRef.current = setTimeout(() => {
        bsdServerPushTimerRef.current = null;
        void runServerPush();
      }, 900);
    };
  }, [variant, dashDeviceId, panelInstanceId, panelOwnerSegment, token, user?.id, userProfile?.id]);

  useEffect(() => {
    return () => {
      if (bsdServerPushTimerRef.current != null) {
        clearTimeout(bsdServerPushTimerRef.current);
        bsdServerPushTimerRef.current = null;
      }
    };
  }, []);

  /** Sin `dashDeviceId` en vista dispositivo, no escribir en `bsd_dash_grid_v1_default` (evita mezclar equipos). */
  const persistBsdGridLayoutDisk = useCallback(
    (normalizedLayout) => {
      if (variant === 'device' && !dashDeviceId) return;
      try {
        /** Posiciones y tamaños del grid (rejilla 12 cols): persistencia por dispositivo o panel (`dashboardGridLayoutStorageKey`). */
        localStorage.setItem(dashboardGridLayoutKey, JSON.stringify(normalizedLayout));
      } catch {
        /* ignore */
      }
      if ((variant === 'device' && dashDeviceId) || variant === 'panel') {
        scheduleBsdServerPersistRef.current?.();
      }
    },
    [variant, dashDeviceId, dashboardGridLayoutKey]
  );
  const loadInitialGridLayout = (gk, vis, panelDevicesLen = 0) =>
    resolveBsdDashboardGridLayout(
      normalizeLayoutForPersistence(
        clampLayoutItemsToModerateMins(
          mergeStoredBsdGridLayout(readStoredBsdGridLayout(gk), buildDefaultBsdGridLayout(variant, panelDevicesLen, vis))
        )
      ),
      vis
    );

  const [gridLayout, setGridLayout] = useState(() => {
    if (variant === 'panel') {
      const pid =
        panelInstanceId != null && String(panelInstanceId).trim()
          ? String(panelInstanceId).trim()
          : 'main';
      const vis = loadDashboardVisibility('panel', null, pid, panelOwnerSegment);
      const gk = dashboardGridLayoutStorageKey('panel', null, pid, panelOwnerSegment);
      return loadInitialGridLayout(gk, vis);
    }
    const did = variant === 'device' ? resolveDeviceDashboardStorageId(device) : null;
    const pid = undefined;
    const vis = loadDashboardVisibility(variant, did, pid);
    return loadInitialGridLayout(
      dashboardGridLayoutStorageKey(variant, did, pid),
      vis
    );
  });
  const gridLayoutLatestRef = useRef(gridLayout);
  /** Layout sin solapes (fuente única para RGL y lista de slots). */
  const resolvedGridLayout = useMemo(
    () => resolveBsdDashboardGridLayout(gridLayout, visibilityMap),
    [gridLayout, visibilityMap]
  );
  gridLayoutLatestRef.current = gridLayout;

  /** Fuerza remontaje de RGL cuando se repara un layout con solapes en disco/estado. */
  const [gridLayoutRepairEpoch, setGridLayoutRepairEpoch] = useState(0);

  /**
   * Posiciones visibles para RGL. No marcar `static: true` al pulsar «Listo»:
   * react-grid-layout `correctBounds` empuja celdas estáticas que se tocan hacia abajo
   * (los 3 KPIs acababan bajo el gráfico lineal). `isDraggable`/`isResizable` ya bloquean el gesto.
   */
  const gridLayoutForRgl = useMemo(() => {
    const visible = filterLayoutToVisibleDashboardItems(resolvedGridLayout, visibilityMap);
    return ensureBsdGridLayoutGeometry(visible);
  }, [resolvedGridLayout, visibilityMap]);

  const lastMeasuredGridWidthRef = useRef(0);
  const [gridWidth, setGridWidth] = useState(() => {
    if (typeof window === 'undefined') return 1200;
    return Math.max(1, Math.floor(window.innerWidth));
  });
  const dashStackWidgets = gridWidth < BSD_NARROW_DASHBOARD_MAX_PX;
  const gridLayoutForViewport = useMemo(
    () => (dashStackWidgets ? stackBsdGridLayoutForNarrowViewport(gridLayoutForRgl) : gridLayoutForRgl),
    [dashStackWidgets, gridLayoutForRgl]
  );

  const rglLayoutIdSet = useMemo(
    () => new Set(gridLayoutForRgl.map((it) => String(it.i))),
    [gridLayoutForRgl]
  );
  /** Posiciones actuales para `data-grid` en hijos directos de RGL. */
  const gridLayoutItemByIdRef = useRef(new Map());
  gridLayoutItemByIdRef.current = useMemo(
    () => new Map(gridLayoutForViewport.map((it) => [String(it.i), it])),
    [gridLayoutForViewport]
  );
  /** Evita mezclar posiciones del panel/dispositivo anterior al cambiar `dashboardGridLayoutKey`. */
  const prevDashboardGridLayoutKeyRef = useRef(dashboardGridLayoutKey);
  /** RGL emite `onLayoutChange` justo después de `onDragStop`; ignorar para no pisar el persistido. */
  const ignoreNextGridLayoutChangeFromDragRef = useRef(false);
  /** Durante el arrastre no compactamos en `onLayoutChange` (RGL emite muchas veces; el persist al soltar lo hace `persistDashboardGridLayoutNow`). */
  const gridRglDraggingRef = useRef(false);
  /** Durante el resize de una celda: igual que drag, no adoptar `onLayoutChange` «fantasma». */
  const gridRglResizingRef = useRef(false);
  /** Clase CSS para desactivar blur/sombras mientras se arrastra (el cristal es caro de pintar). */
  const [gridLayoutInteracting, setGridLayoutInteracting] = useState(false);

  const innerRef = useRef(null);
  const gridWidthMeasureRef = useRef(null);

  useEffect(() => {
    if (variant !== 'device' || !dashDeviceId) return;
    setWidgetConfigs((cur) => migrateLegacySharedDeviceWidgetConfigs(cur, variant, dashDeviceId));
  }, [variant, dashDeviceId]);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    const measureEl = gridWidthMeasureRef.current || inner?.parentElement || inner;
    if (!measureEl) return;
    const apply = () => {
      const w = Math.floor(measureEl.getBoundingClientRect().width);
      if (w < 1) return;
      if (lastMeasuredGridWidthRef.current !== 0 && Math.abs(w - lastMeasuredGridWidthRef.current) < 12) return;
      lastMeasuredGridWidthRef.current = w;
      setGridWidth(w);
    };
    apply();
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(apply);
    });
    ro.observe(measureEl);
    return () => ro.disconnect();
  }, [embedded, variant, panelLoading, loadingExternal, dashboardGridLayoutKey]);

  useLayoutEffect(() => {
    const keyChanged = prevDashboardGridLayoutKeyRef.current !== dashboardGridLayoutKey;
    prevDashboardGridLayoutKeyRef.current = dashboardGridLayoutKey;

    const stored = readStoredBsdGridLayout(dashboardGridLayoutKey);
    const vis = loadDashboardVisibility(
      variant,
      dashDeviceId,
      variant === 'panel' ? panelInstanceId : undefined,
      variant === 'panel' ? panelOwnerSegment : undefined
    );
    const panelLen = variant === 'panel' && (panelDevicesRef.current?.length ?? 0) > 0 ? 1 : 0;
    const defaults = buildDefaultBsdGridLayout(variant, panelLen, vis);
    /**
     * Al cambiar de panel/dispositivo solo leer disco: mezclar el layout en vivo del tab anterior
     * pisaba posiciones guardadas y deformaba widgets hasta recargar (F5).
     */
    let hybrid;
    if (keyChanged) {
      hybrid = normalizeLayoutForPersistence(stored || []);
    } else {
      const hybridById = new Map((stored || []).map((it) => [String(it.i), it]));
      const live = normalizeLayoutForPersistence(gridLayoutLatestRef.current || []);
      for (const it of live) {
        const id = String(it.i);
        if (id) hybridById.set(id, it);
      }
      hybrid = normalizeLayoutForPersistence([...hybridById.values()]);
    }
    const merged = normalizeLayoutForPersistence(mergeStoredBsdGridLayout(hybrid, defaults));
    const filtered = filterLayoutToAllowedDashboardItems(merged, defaults);
    /** Sin reempaque global: `compactBsdGridLayoutTopLeft` aquí movía widgets solos (p. ej. al cargar lista de dispositivos del panel o al redimensionar). */
    const sizeSafe = normalizeLayoutForPersistence(clampLayoutItemsToModerateMins(filtered));
    const nextLayout = resolveBsdDashboardGridLayout(sizeSafe, vis);
    try {
      const disk = normalizeLayoutForPersistence(readStoredBsdGridLayout(dashboardGridLayoutKey) || []);
      if (!layoutsEqualStable(disk, nextLayout)) persistBsdGridLayoutDisk(nextLayout);
    } catch {
      /* ignore */
    }
    setGridLayout((prev) => {
      if (layoutsEqualStable(prev, nextLayout)) {
        gridLayoutLatestRef.current = prev;
        return prev;
      }
      gridLayoutLatestRef.current = nextLayout;
      return nextLayout;
    });

    if (keyChanged) {
      lastMeasuredGridWidthRef.current = 0;
      const measureEl = gridWidthMeasureRef.current;
      if (measureEl) {
        const w = Math.floor(measureEl.getBoundingClientRect().width);
        if (w >= 1) {
          lastMeasuredGridWidthRef.current = w;
          setGridWidth(w);
        }
      }
      requestAnimationFrame(() => {
        const el = gridWidthMeasureRef.current;
        if (!el) return;
        const w = Math.floor(el.getBoundingClientRect().width);
        if (w < 1) return;
        lastMeasuredGridWidthRef.current = w;
        setGridWidth(w);
      });
    }
  }, [
    dashboardGridLayoutKey,
    variant,
    persistBsdGridLayoutDisk,
    dashDeviceId,
    panelInstanceId,
    panelOwnerSegment,
  ]);

  /** Persiste layout reparado (sin solapes) cuando el estado en memoria difiere del resuelto. */
  useLayoutEffect(() => {
    if (gridRglDraggingRef.current || gridRglResizingRef.current) return;
    const raw = gridLayoutLatestRef.current || [];
    const vis = visibilityMapRef.current;
    const visibleRaw = filterLayoutToVisibleDashboardItems(raw, vis);
    const hadOverlap = bsdDashboardLayoutHasOverlap(visibleRaw);
    let resolved = resolveBsdDashboardGridLayout(raw, vis);
    if (hadOverlap && layoutsEqualStable(resolved, raw) && bsdDashboardLayoutHasOverlap(visibleRaw)) {
      resolved = resolveBsdDashboardGridLayout(
        normalizeLayoutForPersistence([
          ...raw.filter((it) => {
            if (!it || it.i == null) return false;
            const base = dashboardWidgetBaseId(String(it.i));
            return vis[base] === false || vis[String(it.i)] === false;
          }),
          ...ensureBsdGridLayoutGeometry(visibleRaw),
        ]),
        vis
      );
    }
    if (layoutsEqualStable(resolved, raw)) return;
    gridLayoutLatestRef.current = resolved;
    setGridLayout(resolved);
    persistBsdGridLayoutDisk(resolved);
    if (hadOverlap) setGridLayoutRepairEpoch((n) => n + 1);
  }, [gridLayout, visibilityMap, dashboardGridLayoutKey, persistBsdGridLayoutDisk]);

  /**
   * Cuando el panel pasa a tener dispositivos y la barra superior está visible, insertar **una vez** esa fila
   * desplazando el resto hacia abajo — sin `compactBsdGridLayoutTopLeft` (no reordenar todo el tablero).
   */
  const panelDeviceCount = panelDevices.length;
  useEffect(() => {
    if (variant !== 'panel') return;
    if (panelDeviceCount === 0) return;
    const vis = visibilityMapRef.current;
    if (!vis || vis[DASH_WIDGET.PANEL_DEVICE_BAR] === false) return;
    const prev = normalizeLayoutForPersistence(gridLayoutLatestRef.current || []);
    if (prev.some((it) => String(it.i) === DASH_WIDGET.PANEL_DEVICE_BAR)) return;
    const bar = { i: DASH_WIDGET.PANEL_DEVICE_BAR, x: 0, y: 0, w: 12, h: 5, minW: 4, minH: 3 };
    const shifted = prev.map((it) => ({ ...it, y: (Math.round(Number(it.y)) || 0) + 5 }));
    const merged = normalizeLayoutForPersistence(clampLayoutItemsToModerateMins([bar, ...shifted]));
    const resolved = resolveBsdDashboardGridLayout(merged, vis);
    gridLayoutLatestRef.current = resolved;
    setGridLayout(resolved);
    persistBsdGridLayoutDisk(resolved);
  }, [variant, panelDeviceCount, dashboardGridLayoutKey, persistBsdGridLayoutDisk]);

  /** Solo adoptar posiciones de RGL al soltar (drag/resize). Durante el gesto no hay setState: evita lag y reempaque. */
  const handleGridLayoutChange = useCallback(
    (_next) => {
      if (dashboardLayoutLocked) return;
      if (ignoreNextGridLayoutChangeFromDragRef.current) {
        ignoreNextGridLayoutChangeFromDragRef.current = false;
      }
    },
    [dashboardLayoutLocked]
  );

  /** Escribe en localStorage el layout ya normalizado (misma geometría que RGL), sin reempaquetar filas. */
  /** @param {{ compact?: boolean }} [opts] Si `compact: true`, reempaqueta arriba-izquierda (solo si se pide explícitamente). */
  const persistDashboardGridLayoutNow = useCallback(
    (layout, opts) => {
      const committed = commitBsdUserGridLayout(
        layout,
        gridLayoutLatestRef.current,
        visibilityMapRef.current
      );
      if (!committed.length && !(Array.isArray(layout) && layout.length)) return;
      const shouldPack = opts?.compact === true;
      const packed = shouldPack
        ? compactBsdGridLayoutTopLeft(filterLayoutToVisibleDashboardItems(committed, visibilityMapRef.current))
        : committed;
      if (layoutsEqualStable(gridLayoutLatestRef.current, packed)) return;
      gridLayoutLatestRef.current = packed;
      setGridLayout(packed);
      persistBsdGridLayoutDisk(packed);
    },
    [dashboardGridLayoutKey, persistBsdGridLayoutDisk]
  );

  const handleGridDragStart = useCallback(() => {
    gridRglDraggingRef.current = true;
    setGridLayoutInteracting(true);
  }, []);

  const handleGridResizeStart = useCallback(() => {
    gridRglResizingRef.current = true;
    setGridLayoutInteracting(true);
  }, []);

  const handleGridResizeStop = useCallback(
    (layout) => {
      try {
        ignoreNextGridLayoutChangeFromDragRef.current = true;
        persistDashboardGridLayoutNow(layout, { compact: false });
      } finally {
        gridRglResizingRef.current = false;
        setGridLayoutInteracting(false);
      }
    },
    [persistDashboardGridLayoutNow]
  );

  const handleGridDragStop = useCallback(
    (layout) => {
      try {
        ignoreNextGridLayoutChangeFromDragRef.current = true;
        persistDashboardGridLayoutNow(layout, { compact: false });
      } finally {
        gridRglDraggingRef.current = false;
        setGridLayoutInteracting(false);
      }
    },
    [persistDashboardGridLayoutNow]
  );

  /** Persiste el layout actual antes de salir de edición (RGL a veces no re-emite el último drag al desmontar). */
  const flushDashboardGridLayoutToStorage = useCallback(() => {
    persistDashboardGridLayoutNow(gridLayoutLatestRef.current);
  }, [persistDashboardGridLayoutNow]);

  /** Sincroniza tablero BSD y downlinks desde el servidor (p. ej. tras asignar el equipo a otro usuario). */
  useEffect(() => {
    if (variant !== 'device' || !dashDeviceId || !token) return undefined;
    const uid = String((user && user.id) || (userProfile && userProfile.id) || '').trim();
    if (!uid) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchDeviceBsdPreferences(dashDeviceId);
        if (cancelled || !data || typeof data.prefs !== 'object') return;
        if (bsdServerPushTimerRef.current != null || bsdServerPushInFlightRef.current) return;
        const updatedAt = data.updatedAt != null ? String(data.updatedAt) : '';
        if (!updatedAt) return;
        const markerKey = `sycom_bsd_remote_rev_${uid}_${dashDeviceId}`;
        try {
          if (localStorage.getItem(markerKey) === updatedAt) return;
        } catch {
          /* ignore */
        }
        try {
          const localRev = localStorage.getItem(markerKey);
          if (localRev && String(localRev) !== String(updatedAt) && String(localRev) > String(updatedAt)) return;
        } catch {
          /* ignore */
        }
        if (deviceBsdBundleIsEmpty(data.prefs)) return;
        applyDeviceBsdBundle(dashDeviceId, data.prefs);
        try {
          localStorage.setItem(markerKey, updatedAt);
        } catch {
          /* ignore */
        }
        setWidgetConfigs(loadAllWidgetConfigs());
        setVisibilityMap(loadDashboardVisibility('device', dashDeviceId));
        const gk = dashboardGridLayoutStorageKey('device', dashDeviceId, undefined, undefined);
        const nextGrid = resolveBsdDashboardGridLayout(
          readStoredBsdGridLayout(gk),
          loadDashboardVisibility('device', dashDeviceId)
        );
        gridLayoutLatestRef.current = nextGrid;
        setGridLayout(nextGrid);
        setDownlinkList(
          loadDownlinksFromStorage(dashDeviceId, deviceModelForDownlinks(dashDeviceId, device, panelDevices))
        );
      } catch (e) {
        console.warn('[BSD] preferencias servidor:', e?.message || e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [variant, dashDeviceId, token, user?.id, userProfile?.id]);

  /** Sincroniza BSD del panel desde el servidor (otro navegador o caché limpiada). Una fila por (usuario, segmento, id de pestaña). */
  useEffect(() => {
    if (variant !== 'panel' || !token) return undefined;
    const uid = String((user && user.id) || (userProfile && userProfile.id) || '').trim();
    if (!uid) return undefined;
    const seg =
      panelOwnerSegment != null && String(panelOwnerSegment).trim() ? String(panelOwnerSegment).trim() : '';
    const pid =
      panelInstanceId != null && String(panelInstanceId).trim() ? String(panelInstanceId).trim() : 'main';
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchPanelBsdPreferences(seg, pid);
        if (cancelled || !data || typeof data.prefs !== 'object') return;
        if (bsdServerPushTimerRef.current != null || bsdServerPushInFlightRef.current) return;
        const updatedAt = data.updatedAt != null ? String(data.updatedAt) : '';
        if (!updatedAt) return;
        const markerKey = `sycom_bsd_panel_remote_rev_${uid}_${encodeURIComponent(seg)}_${encodeURIComponent(pid)}`;
        try {
          if (localStorage.getItem(markerKey) === updatedAt) return;
        } catch {
          /* ignore */
        }
        try {
          const localRev = localStorage.getItem(markerKey);
          if (localRev && String(localRev) !== String(updatedAt) && String(localRev) > String(updatedAt)) return;
        } catch {
          /* ignore */
        }
        if (deviceBsdBundleIsEmpty(data.prefs)) return;
        applyPanelBsdBundle(panelOwnerSegment, pid, data.prefs);
        try {
          localStorage.setItem(markerKey, updatedAt);
        } catch {
          /* ignore */
        }
        setWidgetConfigs(loadAllWidgetConfigs());
        setVisibilityMap(loadDashboardVisibility('panel', null, pid, panelOwnerSegment));
        const panelVis = loadDashboardVisibility('panel', null, pid, panelOwnerSegment);
        const gk = dashboardGridLayoutStorageKey('panel', null, pid, panelOwnerSegment);
        const nextGrid = resolveBsdDashboardGridLayout(readStoredBsdGridLayout(gk), panelVis);
        gridLayoutLatestRef.current = nextGrid;
        setGridLayout(nextGrid);
      } catch (e) {
        console.warn('[BSD] preferencias panel servidor:', e?.message || e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [variant, token, user?.id, userProfile?.id, panelOwnerSegment, panelInstanceId]);

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

  const getRawNumericForWidgetField = useCallback(
    (s, cfg, fieldKey, allowAggregate) => {
      const pk = s.propertyKey;
      const field = fieldKey || pk;
      const sid = s.sourceDeviceId;
      const aggField = cfg?.data?.fieldKey || pk;
      if (
        allowAggregate &&
        cfg?.timeframe?.mode === 'interval' &&
        cfg.timeframe?.operation &&
        sid &&
        sid !== 'demo' &&
        String(field) === String(aggField)
      ) {
        const ak = `${sid}|${pk}`;
        const agg = aggregateByKey[ak];
        if (agg != null && Number.isFinite(agg)) return agg;
      }
      const eff = variant === 'device' ? dashDeviceId : controlDeviceId;
      if (sid && sid !== 'demo') {
        let liveTel = null;
        if (variant === 'device' && dashDeviceId && String(sid) === String(dashDeviceId)) {
          liveTel = telemetryLiveProps;
        } else if (variant === 'panel') {
          if (eff != null && String(sid) === String(eff)) liveTel = telemetryLiveProps;
          else liveTel = panelTelemetryExpandedByDeviceId[String(sid)] || null;
        }
        if (liveTel && typeof liveTel === 'object') {
          const liveRaw = resolveTelemetryDisplaySource(liveTel, field);
          const alt = liveRaw !== undefined ? parseNumeric(liveRaw) : null;
          if (alt != null) return alt;
        }
      }
      if (String(field) === String(aggField)) {
        const v = s.value;
        return typeof v === 'number' && Number.isFinite(v) ? v : parseNumeric(v);
      }
      return null;
    },
    [
      aggregateByKey,
      telemetryLiveProps,
      variant,
      dashDeviceId,
      controlDeviceId,
      panelTelemetryExpandedByDeviceId,
    ]
  );

  const getDisplayValue = useCallback(
    (s) => {
      const cfg = getWidgetConfig(s);
      const pk = s.propertyKey;
      const primaryField = cfg?.data?.fieldKey || pk;
      const expr = String(cfg?.data?.formulaExpression ?? '').trim();
      const formulaOn = Boolean(cfg?.data?.formulaEnabled) && expr !== '';
      const formulaField = telemetryFieldKeyForFormula(cfg, primaryField);
      const aggField = cfg?.data?.fieldKey || pk;
      const allowAggFormula = String(formulaField) === String(aggField);

      const rawPrimary = getRawNumericForWidgetField(s, cfg, primaryField, true);
      if (!formulaOn) {
        if (rawPrimary != null && Number.isFinite(rawPrimary)) return rawPrimary;
        return s.value;
      }

      const rawForFormula = getRawNumericForWidgetField(s, cfg, formulaField, allowAggFormula);
      const base =
        rawForFormula != null && Number.isFinite(rawForFormula)
          ? rawForFormula
          : rawPrimary != null && Number.isFinite(rawPrimary)
            ? rawPrimary
            : parseNumeric(s.value) ?? s.value;

      const numBase = typeof base === 'number' && Number.isFinite(base) ? base : parseNumeric(base);
      const transformed = transformWidgetNumeric(cfg, numBase);
      if (typeof transformed === 'number' && Number.isFinite(transformed)) return transformed;
      return typeof numBase === 'number' && Number.isFinite(numBase) ? numBase : s.value;
    },
    [getWidgetConfig, getRawNumericForWidgetField]
  );

  const isVis = useCallback((id) => visibilityMap[id] !== false, [visibilityMap]);

  useEffect(() => {
    if (variant === 'panel' && panelLoading) return undefined;
    let cancelled = false;
    (async () => {
      const next = {};
      const nextSeries = {};
      for (const s of sensors) {
        const sid = s.sourceDeviceId;
        const pk = s.propertyKey;
        const ak = `${sid}|${pk}`;
        const cfg = widgetConfigs[configKeyForSensor(s)];
        if (!sid || sid === 'demo' || !cfg) {
          continue;
        }
        const dateWin = resolveValueDateFilterWindow(cfg, Date.now());
        const intervalOn =
          cfg.timeframe?.mode === 'interval' && Boolean(cfg.timeframe?.operation);
        if (!dateWin && !intervalOn) continue;
        const now = Date.now();
        const fromMs = dateWin
          ? dateWin.fromMs
          : parseRelativeTime(cfg.timeframe.from, now, 'from') ?? now - 86400000;
        const toMs = dateWin ? dateWin.toMs : parseRelativeTime(cfg.timeframe.to, now, 'to') ?? now;
        try {
          const field = cfg.data?.fieldKey || pk;
          const rows = await queryTelemetry(sid, field || pk, fromMs, toMs, 4000);
          const points = telemetryValuePoints(rows, field, cfg);
          if (!points.length) {
            next[ak] = null;
            nextSeries[ak] = [];
            continue;
          }
          const op = cfg.timeframe.operation;
          if (dateWin || op === 'delta') {
            next[ak] = aggregateValueDateFilterPoints(points, op);
            nextSeries[ak] = [];
            continue;
          }
          const gran = cfg.timeframe.granularity || '';
          const { aggregate, series } = aggregateHistoryFromPoints(points, gran, op, field);
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
  }, [sensors, widgetConfigs, configKeyForSensor, variant, panelLoading, dateFilterEpoch]);

  useEffect(() => {
    if (variant !== 'panel') return;
    let cancelled = false;
    (async () => {
      setPanelLoading(true);
      try {
        const resp = await withTimeout(
          fetchDevices(credentials, token),
          15000,
          'panel_devices_timeout'
        );
        if (cancelled) return;
        const rawList = resp.data?.data?.content || resp.data?.content || [];
        const deviceList = rawList.map((d) => applyStaleOfflineConnectStatus(d));
        setPanelDevices(deviceList);
        const devStoreKey = panelOwnerSegment ? panelControlDeviceStorageKey(panelOwnerSegment) : 'bsd_panel_control_device';
        const savedPanelDev =
          localStorage.getItem(devStoreKey) ?? localStorage.getItem('bsd_panel_control_device');
        const initialControl =
          savedPanelDev && deviceList.some((d) => String(d.deviceId) === String(savedPanelDev))
            ? String(savedPanelDev)
            : deviceList[0]?.deviceId != null
              ? String(deviceList[0].deviceId)
              : null;
        setControlDeviceId(initialControl);
        const online = deviceList.filter((d) => isDeviceVisuallyOnline(d)).length;
        const sat = deviceList.length ? Math.round((online / deviceList.length) * 100) : 83;
        setSatisfactionPct(Math.min(100, Math.max(0, sat)));
        const builtFromList = buildPanelSensors(deviceList, []);
        setSensors(builtFromList.map((s) => ({ ...s })));
        if (initialControl) {
          const controlDev = deviceList.find((d) => String(d.deviceId) === String(initialControl));
          if (controlDev) {
            const seed = buildSeedLivePropsFromDevice(controlDev);
            if (Object.keys(seed).length) setLiveProps(seed);
          }
        }
        if (!cancelled) setPanelLoading(false);

        getLatestDeviceData()
          .then((latest) => {
            if (cancelled) return;
            const latestArr = Array.isArray(latest) ? latest : [];
            const built = buildPanelSensors(deviceList, latestArr);
            setSensors(built.map((s) => ({ ...s })));
          })
          .catch((e) => {
            console.warn('[BudgetSensorsDashboard] panel local telemetry', e?.message || e);
          });
      } catch (e) {
        console.warn('[BudgetSensorsDashboard] panel load', e);
        setPanelDevices([]);
        setControlDeviceId(null);
        setSensors(DEFAULT_SENSORS.map((s, i) => ({ ...s, id: i + 1 })));
        if (!cancelled) setPanelLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [variant, credentials, token, panelOwnerSegment]);

  useEffect(() => {
    if (variant !== 'device' || !device) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const sseFresh = Date.now() - lastRealtimeTelemetryMsRef.current < PANEL_SSE_SKIP_HTTP_MS;
        if (sseFresh && hasMeaningfulAppTelemetry(livePropsRef.current)) {
          if (!cancelled) {
            setDownlinkList(
              loadDownlinksFromStorage(
                device.deviceId,
                deviceModelForDownlinks(device.deviceId, device, panelDevices)
              )
            );
          }
          return;
        }
        const merged = await mergeDeviceLive(device, credentials, token, undefined, {
          view: 'device',
        });
        if (cancelled) return;
        const devSid =
          resolveDeviceDashboardStorageId(device) ||
          (device.deviceId != null ? String(device.deviceId) : '');
        const built = propertiesToSensors(merged, 1, '', devSid);
        setSensors(built.length ? built : DEFAULT_SENSORS.map((s, i) => ({ ...s, id: i + 1 })));
        const online = isDeviceVisuallyOnline(merged);
        setSatisfactionPct(online ? 100 : 0);
        setLiveProps(mergeDeviceTelemetryForWidgets(device, merged));
        setDownlinkList(
          loadDownlinksFromStorage(
            device.deviceId,
            deviceModelForDownlinks(device.deviceId, device, panelDevices)
          )
        );
      } catch (e) {
        console.warn('[BudgetSensorsDashboard] device load', e);
        if (cancelled) return;
        const merged = mergeDeviceTelemetryForWidgets(device);
        const devSid =
          resolveDeviceDashboardStorageId(device) ||
          (device.deviceId != null ? String(device.deviceId) : '');
        const built = propertiesToSensors(merged, 1, '', devSid);
        setSensors(built.length ? built : DEFAULT_SENSORS.map((s, i) => ({ ...s, id: i + 1 })));
        setLiveProps(merged);
        setDownlinkList(
          loadDownlinksFromStorage(
            device.deviceId,
            deviceModelForDownlinks(device.deviceId, device, panelDevices)
          )
        );
      }
    };
    deviceLiveTickRef.current = tick;
    const id = setInterval(tick, DEVICE_LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [variant, device, credentials, token]);

  useEffect(() => {
    if (variant !== 'panel' || panelLoading) return;
    let cancelled = false;
    const tick = async () => {
      const list = panelDevicesRef.current || [];
      const ids = new Set();
      if (controlDeviceId) ids.add(String(controlDeviceId));
      let allConfigs = {};
      try {
        allConfigs = loadAllWidgetConfigs();
      } catch {
        /* ignore */
      }
      const prefix = dashboardWidgetConfigKeyPrefix(variant, dashDeviceId, panelInstanceId, panelOwnerSegment);
      for (const [sk, cfg] of Object.entries(allConfigs)) {
        if (!String(sk).startsWith(prefix)) continue;
        const pid = cfg?.data?.panelBoundDeviceId;
        if (pid != null && String(pid).trim()) ids.add(String(pid).trim());
      }
      if (panelModalPreviewDeviceId != null && String(panelModalPreviewDeviceId).trim()) {
        ids.add(String(panelModalPreviewDeviceId).trim());
      }
      const idArr = [...ids];
      if (!idArr.length) {
        if (!cancelled) {
          setLiveProps({});
          setPanelTelemetryByDeviceId({});
          setDownlinkList([]);
        }
        return;
      }
      if (controlDeviceId && !cancelled) {
        const controlDev = list.find((d) => String(d.deviceId) === String(controlDeviceId));
        if (controlDev) {
          const seed = buildSeedLivePropsFromDevice(controlDev);
          if (Object.keys(seed).length) setLiveProps(seed);
        }
      }
      const skipHttp = Date.now() - lastRealtimeTelemetryMsRef.current < PANEL_SSE_SKIP_HTTP_MS;
      let latestBatch = [];
      if (!skipHttp) {
        try {
          latestBatch = (await getLatestDeviceData()) || [];
        } catch {
          latestBatch = [];
        }
      }
      let results = [];
      try {
        results = await Promise.all(
          idArr.map(async (id) => {
            try {
              const dev = list.find((d) => String(d.deviceId) === String(id));
              if (!dev) return [id, {}];
              if (skipHttp) {
                const cached = panelTelemetryByDeviceIdRef.current?.[id];
                const base = cached && typeof cached === 'object' ? { ...dev, ...cached } : { ...dev };
                return [id, applyStaleOfflineConnectStatus(base)];
              }
              const merged = await mergeDeviceLive(dev, credentials, token, latestBatch);
              return [id, merged && typeof merged === 'object' && !Array.isArray(merged) ? merged : {}];
            } catch (e) {
              console.warn('[BudgetSensorsDashboard] panel merge device', id, e?.message || e);
              return [id, {}];
            }
          })
        );
      } catch (e) {
        console.warn('[BudgetSensorsDashboard] panel merge batch', e?.message || e);
        return;
      }
      if (cancelled) return;
      const byId = {};
      for (const [id, merged] of results) {
        byId[id] = merged;
      }
      setPanelTelemetryByDeviceId(byId);
      const primary = controlDeviceId ? byId[String(controlDeviceId)] : {};
      setLiveProps(primary && typeof primary === 'object' ? primary : {});
      setDownlinkList(
        controlDeviceId
          ? loadDownlinksFromStorage(
              controlDeviceId,
              deviceModelForDownlinks(controlDeviceId, null, panelDevices)
            )
          : []
      );
    };
    panelMergeTickRef.current = tick;
    tick();
    const id = setInterval(tick, PANEL_LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    variant,
    panelLoading,
    controlDeviceId,
    credentials,
    token,
    dashDeviceId,
    panelInstanceId,
    widgetConfigs,
    panelModalPreviewDeviceId,
    panelOwnerSegment,
  ]);

  /** Lista del panel + sensores agregados: misma cadencia que los widgets en vivo. */
  useEffect(() => {
    if (variant !== 'panel' || panelLoading) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const skipHttp = Date.now() - lastRealtimeTelemetryMsRef.current < PANEL_SSE_SKIP_HTTP_MS;
        const resp = await fetchDevices(credentials, token);
        const latest = skipHttp ? [] : await getLatestDeviceData().catch(() => []);
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
    const id = setInterval(tick, PANEL_DEVICES_LIST_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [variant, panelLoading, credentials, token]);

  useEffect(() => {
    const onTel = (e) => {
      const detail = e?.detail;
      const idStr = detail?.deviceId != null ? String(detail.deviceId) : '';
      if (!idStr || !detail?.properties || typeof detail.properties !== 'object') return;
      lastRealtimeTelemetryMsRef.current = Date.now();
      setPanelLiveTelemetryEpoch((n) => n + 1);

      if (variant === 'device' && device && deviceRowMatchesRealtimeId(device, idStr)) {
        const merged = mergeRealtimeTelemetryIntoDeviceRow(device, detail);
        const flat = mergeDeviceTelemetryForWidgets(device, merged);
        setLiveProps(flat);
        textWidgetDisplayStickyRef.current = {};
        const expanded = flat;
        const devSid =
          resolveDeviceDashboardStorageId(device) ||
          (device.deviceId != null ? String(device.deviceId) : '');
        const built = propertiesToSensors(expanded, 1, '', devSid);
        setSensors(built.length ? built : DEFAULT_SENSORS.map((s, i) => ({ ...s, id: i + 1 })));
        setSatisfactionPct(isDeviceVisuallyOnline(merged) ? 100 : 0);
        return;
      }

      if (variant === 'panel' && !panelLoading) {
        setPanelDevices((prev) =>
          prev.map((d) => (deviceRowMatchesRealtimeId(d, idStr) ? mergeRealtimeTelemetryIntoDeviceRow(d, detail) : d))
        );
        setPanelTelemetryByDeviceId((prev) => ({
          ...prev,
          [idStr]: expandMergedDeviceTelemetryLive({
            ...(prev[idStr] && typeof prev[idStr] === 'object' ? prev[idStr] : {}),
            ...detail.properties,
            lastUpdateTime: detail.timestamp != null ? detail.timestamp : prev[idStr]?.lastUpdateTime,
          }),
        }));
        const dev = panelDevicesRef.current?.find((d) => deviceRowMatchesRealtimeId(d, idStr));
        if (dev) {
          const mergedRow = expandMergedDeviceTelemetryLive(mergeRealtimeTelemetryIntoDeviceRow(dev, detail));
          if (controlDeviceId && String(controlDeviceId) === idStr) {
            setLiveProps(mergedRow);
          }
        }
      }
    };
    window.addEventListener(SYSCOM_REALTIME_TELEMETRY, onTel);
    return () => window.removeEventListener(SYSCOM_REALTIME_TELEMETRY, onTel);
  }, [variant, device, panelLoading, dashDeviceId, controlDeviceId]);

  /** Libera «Enviando…» cuando el LNS confirma fallo/éxito de TX (el POST HTTP puede responder antes que el gateway). */
  useEffect(() => {
    const onLns = (e) => {
      const d = e?.detail || {};
      const t = d.eventType || d.type || '';
      const meta = d.meta && typeof d.meta === 'object' ? d.meta : {};
      if (
        t === 'downlink_device_acked' ||
        (t === 'downlink_gateway_ack' && (meta.timeout || meta.ok === true)) ||
        t === 'gateway_tx_rejected'
      ) {
        if (downlinkSendingHexRef.current.size > 0) {
          downlinkSendingHexRef.current.clear();
          setDownlinkSendingVersion((v) => v + 1);
        }
      }
    };
    window.addEventListener(SYSCOM_REALTIME_LNS, onLns);
    return () => window.removeEventListener(SYSCOM_REALTIME_LNS, onLns);
  }, []);

  const dashWidgetSlotIds = useCallback(
    (baseId) =>
      listDashboardWidgetSlotIds(visibilityMap, resolvedGridLayout, baseId).filter((id) =>
        rglLayoutIdSet.has(String(id))
      ),
    [visibilityMap, resolvedGridLayout, rglLayoutIdSet]
  );

  const textDashSlotIds = useMemo(
    () => dashWidgetSlotIds(DASH_WIDGET.TEXT),
    [dashWidgetSlotIds]
  );

  const veletaDashSlotIds = useMemo(
    () => dashWidgetSlotIds(DASH_WIDGET.VEleta),
    [dashWidgetSlotIds]
  );

  const metricCircularDashSlotIds = useMemo(
    () => dashWidgetSlotIds(DASH_WIDGET.METRIC_CIRCULAR),
    [dashWidgetSlotIds]
  );

  const satisfactionUiBySlot = useMemo(() => {
    const out = {};
    for (const slotId of dashWidgetSlotIds(DASH_WIDGET.SATISFACTION)) {
      const cfg = widgetConfigs[dk(slotId)];
      const baseTel = telemetryLivePropsForPanelWidget(slotId);
      const tel = overlayDateFilterTelemetry(baseTel, cfg, dateFilterAggByKey[dk(slotId)]) || baseTel;
      let ui = computeSatisfactionRingUi(
        cfg,
        tel,
        resolveLiveDeviceModelForPanelWidget(slotId),
        resolveTelemetryHintsForPanelWidget(slotId)
      );
      if (ui.rawValue == null && slotId === DASH_WIDGET.SATISFACTION && !isValueDateFilterActive(cfg)) {
        const fallback = satisfactionPct;
        ui = { ...ui, ringPct: fallback, centerLabel: `${fallback}%` };
      }
      out[slotId] = applyDateFilterUiFooter(ui, cfg, dateFilterAggByKey[dk(slotId)]);
    }
    return out;
  }, [
    dashWidgetSlotIds,
    widgetConfigs,
    dk,
    satisfactionPct,
    telemetryLivePropsForPanelWidget,
    resolveLiveDeviceModelForPanelWidget,
    resolveTelemetryHintsForPanelWidget,
    dateFilterAggByKey,
  ]);

  const containerUiBySlot = useMemo(() => {
    const out = {};
    for (const slotId of dashWidgetSlotIds(DASH_WIDGET.CONTAINER)) {
      const cfg = widgetConfigs[dk(slotId)];
      const baseTel = telemetryLivePropsForPanelWidget(slotId);
      const tel = overlayDateFilterTelemetry(baseTel, cfg, dateFilterAggByKey[dk(slotId)]) || baseTel;
      const ui = computeContainerTankUi(
        cfg,
        tel,
        resolveLiveDeviceModelForPanelWidget(slotId),
        resolveTelemetryHintsForPanelWidget(slotId)
      );
      out[slotId] = applyDateFilterUiFooter(ui, cfg, dateFilterAggByKey[dk(slotId)]);
    }
    return out;
  }, [
    dashWidgetSlotIds,
    widgetConfigs,
    dk,
    telemetryLivePropsForPanelWidget,
    resolveLiveDeviceModelForPanelWidget,
    resolveTelemetryHintsForPanelWidget,
    dateFilterAggByKey,
  ]);

  const batteryLevelUiBySlot = useMemo(() => {
    const out = {};
    for (const slotId of dashWidgetSlotIds(DASH_WIDGET.BATTERY_LEVEL)) {
      const cfg = widgetConfigs[dk(slotId)];
      const baseTel = telemetryLivePropsForPanelWidget(slotId);
      const tel = overlayDateFilterTelemetry(baseTel, cfg, dateFilterAggByKey[dk(slotId)]) || baseTel;
      const ui = computeBatteryLevelUi(
        cfg,
        tel,
        resolveLiveDeviceModelForPanelWidget(slotId),
        resolveTelemetryHintsForPanelWidget(slotId)
      );
      out[slotId] = applyDateFilterUiFooter(ui, cfg, dateFilterAggByKey[dk(slotId)]);
    }
    return out;
  }, [
    dashWidgetSlotIds,
    widgetConfigs,
    dk,
    telemetryLivePropsForPanelWidget,
    resolveLiveDeviceModelForPanelWidget,
    resolveTelemetryHintsForPanelWidget,
    dateFilterAggByKey,
  ]);

  const imageUrlBySlot = useMemo(() => {
    const out = {};
    for (const slotId of dashWidgetSlotIds(DASH_WIDGET.IMAGE)) {
      out[slotId] = resolveImageDisplayUrl(
        telemetryLivePropsForPanelWidget(slotId),
        widgetConfigs[dk(slotId)]
      );
    }
    return out;
  }, [dashWidgetSlotIds, telemetryLivePropsForPanelWidget, widgetConfigs, dk]);

  const mapCoordsBySlot = useMemo(() => {
    const out = {};
    for (const slotId of dashWidgetSlotIds(DASH_WIDGET.MAP)) {
      out[slotId] = resolveMapCoords(
        telemetryLivePropsForPanelWidget(slotId),
        widgetConfigs[dk(slotId)]
      );
    }
    return out;
  }, [dashWidgetSlotIds, telemetryLivePropsForPanelWidget, widgetConfigs, dk]);

  const mapBaseLayerBySlot = useMemo(() => {
    const out = {};
    for (const slotId of dashWidgetSlotIds(DASH_WIDGET.MAP)) {
      out[slotId] = normalizeMapBaseLayerId(widgetConfigs[dk(slotId)]?.data?.mapBaseLayer);
    }
    return out;
  }, [dashWidgetSlotIds, widgetConfigs, dk]);

  const trackingMapBaseLayerBySlot = useMemo(() => {
    const out = {};
    for (const slotId of dashWidgetSlotIds(DASH_WIDGET.TRACKING_MAP)) {
      out[slotId] = normalizeMapBaseLayerId(widgetConfigs[dk(slotId)]?.data?.mapBaseLayer);
    }
    return out;
  }, [dashWidgetSlotIds, widgetConfigs, dk]);

  const enrichTelemetryForValueWidget = useCallback(
    (baseTel, wid) => {
      const configKey = dk(wid);
      const cfg = widgetConfigs[configKey];
      const fkRaw = cfg?.data?.fieldKey;
      const fk = fkRaw != null ? String(fkRaw).trim() : '';
      const devId =
        variant === 'device'
          ? device?.deviceId
          : resolveWidgetBoundDeviceId(wid) || controlDeviceId;
      if (isValueDateFilterActive(cfg) && fk && !fk.startsWith('__bsd_')) {
        return (
          overlayDateFilterTelemetry(baseTel, cfg, dateFilterAggByKey[configKey]) || {
            lastUpdateTime: baseTel && typeof baseTel === 'object' ? baseTel.lastUpdateTime : undefined,
          }
        );
      }
      return enrichTelemetryWithDbFallback(
        baseTel,
        devId,
        fk,
        cfg,
        dbScalarByDeviceField,
        resolveTextWidgetRawScalar
      );
    },
    [
      variant,
      device?.deviceId,
      controlDeviceId,
      widgetConfigs,
      dk,
      dbScalarByDeviceField,
      resolveWidgetBoundDeviceId,
      dateFilterAggByKey,
    ]
  );

  /** Historial SQLite para campos que el último uplink no incluye (p. ej. estatus WT201 tras join). */
  useEffect(() => {
    const entries = [];
    const seen = new Set();
    const collect = (slotId) => {
      const cfgKey = dk(slotId);
      const cfg = widgetConfigs[cfgKey];
      const fkRaw = cfg?.data?.fieldKey;
      const fk = fkRaw != null ? String(fkRaw).trim() : '';
      if (!fk || fk.startsWith('__bsd_')) return;
      const devId =
        variant === 'device'
          ? device?.deviceId
          : resolveWidgetBoundDeviceId(slotId) || controlDeviceId;
      if (!devId) return;
      const cacheKey = `${String(devId).trim()}|${fk}`;
      if (seen.has(cacheKey)) return;
      seen.add(cacheKey);
      entries.push({ fieldKey: fk, cfg, cacheKey });
    };
    for (const slotId of textDashSlotIds) collect(slotId);
    for (const slotId of metricCircularDashSlotIds) collect(slotId);
    if (!entries.length) return;

    const byDevice = new Map();
    for (const e of entries) {
      const devId = e.cacheKey.split('|')[0];
      if (!byDevice.has(devId)) byDevice.set(devId, []);
      byDevice.get(devId).push(e);
    }

    let cancelled = false;
    const gen = dbScalarFetchGenRef.current + 1;
    dbScalarFetchGenRef.current = gen;
    (async () => {
      const merged = {};
      for (const [deviceId, devEntries] of byDevice) {
        try {
          const part = await resolveLastScalarsFromTelemetryHistory(
            deviceId,
            devEntries,
            queryTelemetry,
            resolveTextWidgetRawScalar
          );
          Object.assign(merged, part);
        } catch (e) {
          console.warn('[BSD] widget db fallback', e?.message || e);
        }
      }
      if (cancelled || dbScalarFetchGenRef.current !== gen) return;
      if (Object.keys(merged).length) {
        setDbScalarByDeviceField((prev) => ({ ...prev, ...merged }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    variant,
    device?.deviceId,
    controlDeviceId,
    textDashSlotIds,
    metricCircularDashSlotIds,
    widgetConfigs,
    dk,
    resolveWidgetBoundDeviceId,
  ]);

  useEffect(() => {
    const t = window.setInterval(() => setDateFilterEpoch((n) => n + 1), DASH_CHART_HISTORY_POLL_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (variant === 'panel' && panelLoading) return undefined;
    let cancelled = false;
    (async () => {
      const next = {};
      const jobs = [];
      for (const baseId of VALUE_DATE_FILTER_DASH_BASES) {
        for (const slotId of dashWidgetSlotIds(baseId)) {
          const configKey = dk(slotId);
          const cfg = widgetConfigs[configKey];
          if (!isValueDateFilterActive(cfg)) continue;
          const win = resolveValueDateFilterWindow(cfg, Date.now());
          if (!win) continue;
          const fkRaw = cfg?.data?.fieldKey;
          const fk = fkRaw != null ? String(fkRaw).trim() : '';
          const field = telemetryFieldKeyForFormula(cfg, fk);
          if (!field || field.startsWith('__bsd_')) continue;
          const sid =
            variant === 'device'
              ? device?.deviceId
              : resolveWidgetBoundDeviceId(slotId) || controlDeviceId;
          if (!sid || String(sid) === 'demo') continue;
          jobs.push({ configKey, cfg, win, field, sid });
        }
      }
      await Promise.all(
        jobs.map(async (job) => {
          const label = formatValueDateFilterLabel(job.cfg, Date.now());
          try {
            const rows = await queryTelemetry(job.sid, job.field, job.win.fromMs, job.win.toMs, 4000);
            if (cancelled) return;
            const points = telemetryValuePoints(rows, job.field, job.cfg);
            const value = aggregateValueDateFilterPoints(points, job.cfg.timeframe?.operation);
            next[job.configKey] = { value, label, error: null, loading: false };
          } catch (e) {
            next[job.configKey] = {
              value: null,
              label,
              error: e?.message ? String(e.message) : 'No se pudo cargar el periodo',
              loading: false,
            };
          }
        })
      );
      if (!cancelled) setDateFilterAggByKey(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    variant,
    panelLoading,
    device?.deviceId,
    controlDeviceId,
    widgetConfigs,
    dk,
    dashWidgetSlotIds,
    resolveWidgetBoundDeviceId,
    dateFilterEpoch,
  ]);

  /** Medidor semicircular por celda del grid (`dw_metric_circular` o `dw_metric_circular__…`). */
  const metricCircularUiBySlot = useMemo(() => {
    const out = {};
    for (const slotId of metricCircularDashSlotIds) {
      const tel = enrichTelemetryForValueWidget(telemetryLivePropsForPanelWidget(slotId), slotId);
      out[slotId] = applyDateFilterUiFooter(
        computeMetricCircularUiForSlot(
          dk,
          widgetConfigs,
          slotId,
          tel,
          resolveLiveDeviceModelForPanelWidget(slotId),
          resolveTelemetryHintsForPanelWidget(slotId)
        ),
        widgetConfigs[dk(slotId)],
        dateFilterAggByKey[dk(slotId)]
      );
    }
    return out;
  }, [
    metricCircularDashSlotIds,
    dk,
    widgetConfigs,
    telemetryLivePropsForPanelWidget,
    enrichTelemetryForValueWidget,
    resolveLiveDeviceModelForPanelWidget,
    resolveTelemetryHintsForPanelWidget,
    dateFilterAggByKey,
  ]);

  /** Texto por celda del grid. */
  const textWidgetUiBySlot = useMemo(() => {
    const out = {};
    const stickyText = textWidgetDisplayStickyRef.current;
    for (const slotId of textDashSlotIds) {
      const configKey = dk(slotId);
      const fkRaw = widgetConfigs[configKey]?.data?.fieldKey;
      const fkStr = fkRaw != null ? String(fkRaw).trim() : '';
      const cfg = widgetConfigs[configKey];
      const filterOn = isValueDateFilterActive(cfg);
      const tel = enrichTelemetryForValueWidget(telemetryLivePropsForPanelWidget(slotId), slotId);
      let ui = computeTextWidgetUiForSlot(
        dk,
        widgetConfigs,
        slotId,
        tel,
        resolveLiveDeviceModelForPanelWidget(slotId),
        resolveTelemetryHintsForPanelWidget(slotId)
      );
      if (!filterOn) {
        const noLive =
          fkStr &&
          !fkStr.startsWith('__bsd_') &&
          (ui.display === '—' || ui.hint === 'Sin dato en vivo');
        if (noLive) {
          const prev = stickyText[configKey];
          if (prev && prev.fkStr === fkStr && prev.display && prev.display !== '—') {
            ui = {
              ...ui,
              display: prev.display,
              hint:
                fkStr && (!prev.hint || prev.hint === 'Sin dato en vivo')
                  ? `Último estatus · ${fkStr}`
                  : prev.hint && prev.hint !== 'Sin dato en vivo'
                    ? prev.hint
                    : fkStr || 'Último estatus',
            };
          }
        } else if (fkStr && !fkStr.startsWith('__bsd_') && ui.display && ui.display !== '—') {
          stickyText[configKey] = { fkStr, display: ui.display, hint: ui.hint };
        }
      }
      out[slotId] = applyDateFilterUiFooter(ui, cfg, dateFilterAggByKey[configKey]);
    }
    return out;
  }, [
    textDashSlotIds,
    dk,
    widgetConfigs,
    telemetryLiveProps,
    panelLiveTelemetryEpoch,
    panelTelemetryByDeviceId,
    telemetryLivePropsForPanelWidget,
    enrichTelemetryForValueWidget,
    dbScalarByDeviceField,
    resolveLiveDeviceModelForPanelWidget,
    resolveTelemetryHintsForPanelWidget,
    dateFilterAggByKey,
  ]);

  const veletaWidgetUiBySlot = useMemo(() => {
    const out = {};
    for (const slotId of veletaDashSlotIds) {
      const tel = enrichTelemetryForValueWidget(telemetryLivePropsForPanelWidget(slotId), slotId);
      out[slotId] = computeVeletaWidgetUiForSlot(dk, widgetConfigs, slotId, tel);
    }
    return out;
  }, [
    veletaDashSlotIds,
    dk,
    widgetConfigs,
    telemetryLiveProps,
    panelLiveTelemetryEpoch,
    panelTelemetryByDeviceId,
    telemetryLivePropsForPanelWidget,
    enrichTelemetryForValueWidget,
    dbScalarByDeviceField,
  ]);

  const barChartCfgSig = useMemo(() => {
    const c = barWidgetSlice;
    const g = c?.gauge;
    return JSON.stringify({
      fk: c?.data?.fieldKey,
      from: c?.timeframe?.from,
      to: c?.timeframe?.to,
      op: c?.timeframe?.operation,
      gran: c?.timeframe?.granularity,
      target: c?.data?.barChartTarget,
      legA: c?.data?.barLegendActual,
      legT: c?.data?.barLegendTarget,
      panelDev: c?.data?.panelBoundDeviceId,
      unit: c?.data?.unit,
      decimals: c?.data?.decimals,
      gauge: g ? { ranges: g.ranges, scaleMin: g.scaleMin, scaleMax: g.scaleMax } : null,
    });
  }, [barWidgetSlice]);

  /** Solo el widget barras: al cambiar telemetría en vivo del dispositivo enlazado, repinta sin editar el lineal. */
  const barChartLiveValueSig = useMemo(() => {
    const c = barWidgetSlice;
    const fk = c?.data?.fieldKey != null ? String(c.data.fieldKey).trim() : '';
    if (!fk || fk.startsWith('__bsd_')) return '';
    const tel = telemetryLivePropsForPanelWidget(DASH_WIDGET.BAR_CHART);
    if (!tel || typeof tel !== 'object') return `${fk}|`;
    const exp = expandMergedDeviceTelemetryLive(tel);
    const raw = resolveTextWidgetRawScalar(exp, fk, barChartWidgetCfgMerged);
    const n = raw !== undefined ? parseNumeric(raw) : null;
    const sig =
      n != null && Number.isFinite(n)
        ? String(n)
        : raw !== undefined && raw !== null
          ? typeof raw === 'string'
            ? raw
            : JSON.stringify(raw)
          : '_';
    return `${fk}|${tel.lastUpdateTime ?? ''}|${sig}`;
  }, [barWidgetSlice, telemetryLivePropsForPanelWidget, barChartWidgetCfgMerged]);

  barWidgetTelSnapshotRef.current = telemetryLivePropsForPanelWidget(DASH_WIDGET.BAR_CHART);

  useLayoutEffect(() => {
    if (visibilityMap[DASH_WIDGET.STREAM] === false) {
      if (streamingChartRef.current) {
        streamingChartRef.current.destroy();
        streamingChartRef.current = null;
      }
      return undefined;
    }

    let cancelled = false;
    let rafId = 0;
    let waitAttempts = 0;

    const dispose = () => {
      if (streamingChartRef.current) {
        streamingChartRef.current.destroy();
        streamingChartRef.current = null;
      }
    };

    const buildAndAttach = () => {
      if (cancelled) return;
      const el = streamingRef.current;
      if (!el) {
        if (waitAttempts++ < 200) rafId = requestAnimationFrame(buildAndAttach);
        return;
      }

      dispose();

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
                spanGaps: true,
                borderColor: 'rgba(99,102,241,0.35)',
                backgroundColor: 'transparent',
                fill: false,
                tension: 0.35,
                pointRadius: 0,
              },
            ]
          : buildStreamChartDatasets(list);
      streamingMultiRef.current = initStreamingMultiState(Math.max(n, 1));

      const seriesMeta =
        n === 0
          ? [{ label: '—', unit: '', fieldKey: '' }]
          : list.map((s) => ({
              label: s.label,
              unit: inferUnit(s.fieldKey),
              fieldKey: s.fieldKey != null ? String(s.fieldKey).trim() : '',
            }));

      const streamMerged = mergeWidgetConfig(
        dashboardWidgetSensorStub(DASH_WIDGET.STREAM),
        widgetConfigsRef.current[dk(DASH_WIDGET.STREAM)] || {}
      );
      const streamDecRaw = streamMerged?.data?.decimals;
      const streamTooltipDecimals =
        streamDecRaw != null && streamDecRaw !== '' && Number.isFinite(Number(streamDecRaw))
          ? Math.min(6, Math.max(0, Number(streamDecRaw)))
          : undefined;

      let chart;
      try {
        chart = new Chart(el, {
          type: 'line',
          data: { labels: [], datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            resizeDelay: 0,
            animation: false,
            interaction: { mode: 'index', intersect: false, axis: 'x' },
            layout: { padding: { left: 4, right: 10, top: 8, bottom: 2 } },
            plugins: {
              legend: {
                display: showLegend,
                position: 'bottom',
                labels: { color: 'rgba(200,200,220,0.95)', boxWidth: 10, padding: 8, font: { size: 11 } },
              },
              tooltip: {
                enabled: true,
                mode: 'index',
                intersect: false,
                callbacks: {
                  title(items) {
                    if (!items.length) return '';
                    const ch = items[0].chart;
                    const xs = ch.$streamTimestamps;
                    const idx = items[0].dataIndex;
                    if (Array.isArray(xs) && xs[idx] != null && Number.isFinite(xs[idx])) {
                      return new Date(xs[idx]).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'medium',
                      });
                    }
                    const lab = items[0].label;
                    return lab != null && lab !== '' ? String(lab) : '';
                  },
                  label(ctx) {
                    const ch = ctx.chart;
                    const meta = ch.$streamSeriesMeta;
                    const row = meta?.[ctx.datasetIndex];
                    const fk = row?.fieldKey || '';
                    const u = row?.unit || '';
                    const v = ctx.parsed.y;
                    const lab = ctx.dataset.label || 'Serie';
                    if (v == null || !Number.isFinite(v)) return `${lab}: —`;
                    const g = ch.$streamTooltipGauge;
                    const processed = formatTelemetryChartTooltipValue(v, fk, ch.$streamTooltipModel ?? null, ch.$streamTooltipHints ?? null, {
                      unit: u,
                      decimals: ch.$streamTooltipDataDecimals,
                      ranges: g?.ranges,
                      scaleMin: g?.scaleMin,
                      scaleMax: g?.scaleMax,
                    });
                    return `${lab}: ${processed}`;
                  },
                },
              },
            },
            scales: {
              y: {
                min: 0,
                max: 50,
                grid: { color: 'rgba(99,102,241,0.14)', borderDash: [4, 4] },
            ticks: { color: 'rgba(226,232,240,0.92)', maxTicksLimit: 8 },
          },
          ...(useY2
            ? {
                y2: {
                  position: 'right',
                  grid: { drawOnChartArea: false },
                  ticks: { color: 'rgba(226,232,240,0.88)', maxTicksLimit: 8 },
                },
              }
            : {}),
          x: {
            grid: { display: true, color: 'rgba(99,102,241,0.1)', borderDash: [4, 4] },
            ticks: { color: 'rgba(226,232,240,0.9)', maxRotation: 45, autoSkip: true, maxTicksLimit: 12 },
          },
            },
          },
        });
      } catch (e) {
        console.warn('[BSD stream] Chart init', e);
        return;
      }

      chart.$streamSeriesMeta = seriesMeta;
      chart.$streamTimestamps = [];
      chart.$streamTooltipGauge = streamMerged.gauge;
      chart.$streamTooltipDataDecimals = streamTooltipDecimals;
      chart.$streamTooltipModel = streamChartTooltipBridgeRef.current.model;
      chart.$streamTooltipHints = streamChartTooltipBridgeRef.current.hints;
      streamingChartRef.current = chart;

      const pending = streamHistoryPendingRef.current;
      if (
        pending &&
        pending.presetId !== 'live' &&
        pending.presetId === streamTimePresetRef.current &&
        Array.isArray(pending.seriesPrepared)
      ) {
        applyStreamingHistoryChartMulti(chart, pending.seriesPrepared, pending.presetId);
        streamHistoryPendingRef.current = null;
        const lp = pending.seriesPrepared.map((sp) => sp.points[sp.points.length - 1]).filter(Boolean);
        if (lp.length) {
          setStreamDisplay(lp[0].val);
          setStreamHistoryFetchedAt(Date.now());
          setStreamHistoryError(null);
        }
      }

      requestAnimationFrame(() => safeChartResize(chart));
    };

    buildAndAttach();

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      dispose();
    };
  }, [streamSeriesChartKey, visibilityMap[DASH_WIDGET.STREAM]]);

  useEffect(() => {
    if (visibilityMap[DASH_WIDGET.STREAM] === false) return undefined;
    const wrap = streamChartWrapRef.current;
    if (!wrap || !streamingChartRef.current) return undefined;
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            requestAnimationFrame(() => safeChartResize(streamingChartRef.current));
          })
        : null;
    if (ro) ro.observe(wrap);
    requestAnimationFrame(() => safeChartResize(streamingChartRef.current));
    return () => {
      if (ro) ro.disconnect();
    };
  }, [streamSeriesChartKey, visibilityMap[DASH_WIDGET.STREAM], gridWidth, streamTimePreset]);

  /** Tras cargar historial o cambiar rango: Chart.js a veces queda con tamaño 0 hasta un resize explícito. */
  useLayoutEffect(() => {
    if (visibilityMap[DASH_WIDGET.STREAM] === false) return undefined;
    if (streamTimePreset === 'live') return undefined;
    const chart = streamingChartRef.current;
    if (!chart) return undefined;
    const id = requestAnimationFrame(() => {
      const ch = streamingChartRef.current;
      if (!ch) return;
      try {
        safeChartResize(ch);
        ch.update('none');
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [streamTimePreset, streamHistoryFetchedAt, visibilityMap[DASH_WIDGET.STREAM]]);

  const pushLiveStreamingTick = useCallback(() => {
    const chart = streamingChartRef.current;
    const series = streamSeriesNormalized;
    const n = series.length;
    if (!chart || !chart.data.datasets.length || !n) return false;

    const streamTel = telemetryLivePropsForPanelWidget(DASH_WIDGET.STREAM);
    if (!streamTel || typeof streamTel !== 'object') return false;

    const tel = expandMergedDeviceTelemetryLive(streamTel);
    let st = streamingMultiRef.current;
    if (st.buffers.length !== n) {
      streamingMultiRef.current = initStreamingMultiState(n);
      st = streamingMultiRef.current;
    }

    let any = false;
    const tsFromTel = toHistoryEpochMs(streamTel.lastUpdateTime);
    const nowTick = Date.now();
    let tickTs = Number.isFinite(tsFromTel) ? tsFromTel : nowTick;
    if (series.some((s) => isLikelyButtonOrStatusFieldKey(s.fieldKey))) {
      tickTs = Math.max(tickTs, nowTick);
    }

    const chartCfg = streamChartWidgetCfgRef.current;
    for (let i = 0; i < n; i++) {
      const fk = series[i].fieldKey;
      const liveRaw = resolveTextWidgetRawScalar(tel, fk, chartCfg);
      if (liveRaw === undefined) continue;
      const raw = parseNumeric(liveRaw);
      if (raw == null || !Number.isFinite(raw)) continue;
      any = true;
      let val = raw;
      if (series[i].valueMode === 'delta') {
        const prev = st.lastRaw[i];
        st.lastRaw[i] = raw;
        val = prev == null ? 0 : raw - prev;
      }
      val = pointValueAfterWidgetFormula(chartCfg, fk, val);
      const tb = st.timeBuffers[i];
      const buf = st.buffers[i];
      if (tb.length && tb[tb.length - 1] === tickTs) {
        buf[buf.length - 1] = val;
      } else {
        buf.push(val);
        tb.push(tickTs);
        if (buf.length > 20) {
          buf.shift();
          tb.shift();
        }
      }
    }

    if (!any) return false;

    const raw0 = parseNumeric(resolveTextWidgetRawScalar(tel, series[0].fieldKey, chartCfg));
    const b0 = st.buffers[0];
    if (series[0].valueMode !== 'delta' && raw0 != null && Number.isFinite(raw0)) {
      const d0 = pointValueAfterWidgetFormula(chartCfg, series[0].fieldKey, raw0);
      lastStreamRef.current = d0;
      setStreamDisplay(d0);
    } else if (b0.length) {
      lastStreamRef.current = b0[b0.length - 1];
      setStreamDisplay(b0[b0.length - 1]);
    }

    applyLiveStreamChartLabels(chart, st, 'live');
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
    return true;
  }, [streamSeriesNormalized, telemetryLivePropsForPanelWidget, streamChartWidgetCfgMerged]);

  const streamPanelDeviceSig = useMemo(() => {
    if (variant !== 'panel') return '';
    const raw = widgetConfigs[dk(DASH_WIDGET.STREAM)]?.data?.panelBoundDeviceId;
    return raw != null ? String(raw).trim() : '';
  }, [variant, widgetConfigs, dk]);

  const barPanelDeviceSig = useMemo(() => {
    if (variant !== 'panel') return '';
    const raw = widgetConfigs[dk(DASH_WIDGET.BAR_CHART)]?.data?.panelBoundDeviceId;
    return raw != null ? String(raw).trim() : '';
  }, [variant, widgetConfigs, dk]);

  const trackingPanelDeviceSig = useMemo(() => {
    if (variant !== 'panel') return '';
    const raw = widgetConfigs[dk(DASH_WIDGET.TRACKING_MAP)]?.data?.panelBoundDeviceId;
    return raw != null ? String(raw).trim() : '';
  }, [variant, widgetConfigs, dk]);

  const streamHistoryDeviceId = useMemo(() => {
    if (variant === 'device') {
      return dashDeviceId != null && String(dashDeviceId).trim().length
        ? String(dashDeviceId).trim()
        : null;
    }
    if (variant !== 'panel') return controlDeviceId ? String(controlDeviceId) : null;
    if (streamPanelDeviceSig) return streamPanelDeviceSig;
    return controlDeviceId ? String(controlDeviceId) : null;
  }, [variant, streamPanelDeviceSig, controlDeviceId, dashDeviceId]);

  const barChartHistoryDeviceId = useMemo(() => {
    if (variant === 'device') {
      return dashDeviceId != null && String(dashDeviceId).trim().length
        ? String(dashDeviceId).trim()
        : null;
    }
    if (variant !== 'panel') return controlDeviceId ? String(controlDeviceId) : null;
    if (barPanelDeviceSig) return barPanelDeviceSig;
    return controlDeviceId ? String(controlDeviceId) : null;
  }, [variant, barPanelDeviceSig, controlDeviceId, dashDeviceId]);

  useEffect(() => {
    barChartLivePulseBufferRef.current = [];
    barChartLastBufferedPulseValRef.current = null;
  }, [barChartHistoryDeviceId, barChartCfgSig]);

  useEffect(() => {
    if (visibilityMap[DASH_WIDGET.BAR_CHART] === false) return undefined;
    if (!barChartLiveValueSig) return undefined;

    const barKey = dk(DASH_WIDGET.BAR_CHART);
    const fullCfg = loadAllWidgetConfigs()[barKey];
    const cfg = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.BAR_CHART), fullCfg);
    const fkRaw = cfg?.data?.fieldKey;
    const fk = fkRaw != null ? String(fkRaw).trim() : '';
    if (!fk || fk.startsWith('__bsd_') || !isLikelyButtonOrStatusFieldKey(fk)) return undefined;

    const tel = barWidgetTelSnapshotRef.current;
    if (!tel || typeof tel !== 'object' || Array.isArray(tel)) return undefined;

    const exp = expandMergedDeviceTelemetryLive(tel);
    const raw = resolveTextWidgetRawScalar(exp, fk, barChartWidgetCfgRef.current);
    const val = parseNumeric(raw);
    if (val == null || !Number.isFinite(val)) return undefined;

    if (barChartLastBufferedPulseValRef.current === val) return undefined;

    let tsMs = toHistoryEpochMs(tel.lastUpdateTime);
    if (!Number.isFinite(tsMs)) tsMs = Date.now();
    tsMs = Math.max(tsMs, Date.now());

    const buf = barChartLivePulseBufferRef.current;
    const prev = buf[buf.length - 1];
    if (prev && prev.val === val && Math.abs(prev.ts - tsMs) < 700) return undefined;

    buf.push({ ts: tsMs, val });
    barChartLastBufferedPulseValRef.current = val;
    if (buf.length > 720) buf.splice(0, buf.length - 720);
    return undefined;
  }, [barChartLiveValueSig, visibilityMap[DASH_WIDGET.BAR_CHART], dk]);

  const trackingMapHistoryDeviceId = useMemo(() => {
    if (variant === 'device') {
      return dashDeviceId != null && String(dashDeviceId).trim().length
        ? String(dashDeviceId).trim()
        : null;
    }
    if (variant !== 'panel') return controlDeviceId ? String(controlDeviceId) : null;
    if (trackingPanelDeviceSig) return trackingPanelDeviceSig;
    return controlDeviceId ? String(controlDeviceId) : null;
  }, [variant, trackingPanelDeviceSig, controlDeviceId, dashDeviceId]);

  useEffect(() => {
    if (streamTimePreset !== 'live') return undefined;
    const id = setInterval(() => {
      pushLiveStreamingTick();
    }, PANEL_LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [streamTimePreset, pushLiveStreamingTick]);

  useEffect(() => {
    if (streamTimePreset === 'live') return undefined;
    if (visibilityMap[DASH_WIDGET.STREAM] === false) return undefined;
    const id = setInterval(() => {
      setStreamHistoryPollEpoch((n) => n + 1);
    }, DASH_CHART_HISTORY_POLL_MS);
    return () => clearInterval(id);
  }, [streamTimePreset, visibilityMap[DASH_WIDGET.STREAM]]);

  /** Último evento en cuanto llega telemetría (sin esperar al siguiente tick del intervalo). */
  useEffect(() => {
    if (streamTimePreset !== 'live') return undefined;
    pushLiveStreamingTick();
    return undefined;
  }, [streamTimePreset, streamWidgetLivePaintKey, pushLiveStreamingTick]);

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
      applyLiveStreamChartLabels(chart, st2, 'live');
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
      chart.$streamTimestamps = [];
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
    if (visibilityMap[DASH_WIDGET.STREAM] === false) return undefined;

    let cancelled = false;
    const ticket = ++streamHistoryFetchTicketRef.current;
    const isCurrentFetch = () => ticket === streamHistoryFetchTicketRef.current;
    const now = Date.now();
    const bounds = streamHistoryDisplayBounds(streamTimePreset, now);
    if (!bounds) return undefined;
    const startMs = bounds.fromMs;
    const endMs = now;
    const series = streamSeriesNormalized;

    (async () => {
      const silentPollRefresh =
        streamHistoryPollEpoch > 0 &&
        Array.isArray(streamHistoryRowsRef.current) &&
        streamHistoryRowsRef.current.length > 0 &&
        streamHistoryRowsCacheKeyRef.current ===
          `${streamHistoryDeviceId}|${streamTimePreset}|${streamSeriesChartKey}`;

      setStreamHistoryError(null);
      if (!silentPollRefresh) {
        setStreamHistoryLoading(true);
        setStreamHistoryFetchedAt(null);
      }

      if (!streamHistoryDeviceId) {
        streamHistoryRowsRef.current = [];
        streamHistoryRowsCacheKeyRef.current = '';
        if (!cancelled && isCurrentFetch()) {
          setStreamHistoryLoading(false);
          setStreamHistoryError('Selecciona un dispositivo en el panel para ver el historial.');
          clearStreamingChart(streamingChartRef.current);
        }
        return;
      }

      if (!series.length) {
        streamHistoryRowsRef.current = [];
        streamHistoryRowsCacheKeyRef.current = '';
        if (!cancelled && isCurrentFetch()) {
          setStreamHistoryLoading(false);
          setStreamHistoryError('Añade al menos una serie en «Editar widget» → Datos.');
          clearStreamingChart(streamingChartRef.current);
        }
        return;
      }

      try {
        /** Una sola consulta sin filtro por clave: cada fila trae el JSON completo de propiedades (SQLite `telemetry`). */
        const pageCap = streamHistoryPageSize(streamTimePreset);
        let sharedRows = [];
        try {
          const local = await withTimeout(
            queryTelemetry(streamHistoryDeviceId, null, startMs, endMs, pageCap, {
              bucketMs: historyChartBucketMs(streamTimePreset),
            }),
            STREAM_HISTORY_FETCH_TIMEOUT_MS,
            'stream_telemetry_timeout'
          );
          sharedRows = normalizeTelemetryList(local);
        } catch (e) {
          console.warn('[BSD stream] queryTelemetry', e);
        }

        if (!cancelled && sharedRows.length === 0) {
          try {
            const resp = await withTimeout(
              fetchDeviceHistory(
                streamHistoryDeviceId,
                { startTime: startMs, endTime: endMs, pageSize: pageCap },
                credentials,
                token
              ),
              STREAM_HISTORY_FETCH_TIMEOUT_MS,
              'stream_history_timeout'
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

        if (cancelled || !isCurrentFetch()) return;

        streamHistoryRowsRef.current = sharedRows;
        streamHistoryRowsCacheKeyRef.current = `${streamHistoryDeviceId}|${streamTimePreset}|${streamSeriesChartKey}`;
        const streamTel = streamWidgetTelSnapshotRef.current;
        const streamCfg = streamChartWidgetCfgRef.current;
        const seriesPrepared = buildStreamSeriesPreparedFromRows(series, sharedRows, streamCfg);
        const seriesPreparedMerged = mergeLiveIntoStreamSeriesPrepared(seriesPrepared, streamTel, streamCfg);

        const presetForChart = streamTimePreset;
        const finishHistoryUi = () => {
          if (cancelled || !isCurrentFetch()) return;
          const lastPts = seriesPreparedMerged.map((sp) => sp.points[sp.points.length - 1]).filter(Boolean);
          if (lastPts.length) {
            setStreamDisplay(lastPts[0].val);
            setStreamHistoryFetchedAt(Date.now());
            setStreamHistoryError(null);
          } else {
            setStreamHistoryFetchedAt(null);
            setStreamHistoryError('Sin datos en este rango.');
          }
        };

        const tryPaintHistory = () => {
          const chart = streamingChartRef.current;
          if (!chart) return false;
          streamHistoryPendingRef.current = null;
          applyStreamingHistoryChartMulti(chart, seriesPreparedMerged, presetForChart);
          finishHistoryUi();
          requestAnimationFrame(() => safeChartResize(streamingChartRef.current));
          return true;
        };

        const hadAnyPoints = seriesPreparedMerged.some((sp) => sp.points.length);
        if (!hadAnyPoints) {
          streamHistoryPendingRef.current = null;
          const ch = streamingChartRef.current;
          if (ch) applyStreamingHistoryChartMulti(ch, seriesPreparedMerged, presetForChart);
          finishHistoryUi();
        } else {
          streamHistoryPendingRef.current = { seriesPrepared: seriesPreparedMerged, presetId: presetForChart };
          if (!tryPaintHistory()) finishHistoryUi();
        }
      } catch (err) {
        if (!cancelled && isCurrentFetch()) {
          setStreamHistoryError(err?.message || 'Error al cargar el historial');
        }
      } finally {
        if (isCurrentFetch()) setStreamHistoryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      streamHistoryPendingRef.current = null;
    };
  }, [
    streamTimePreset,
    streamHistoryDeviceId,
    streamSeriesNormalized,
    streamSeriesChartKey,
    streamChartWidgetCfgMerged,
    streamHistoryPollEpoch,
    credentials,
    token,
    visibilityMap[DASH_WIDGET.STREAM],
  ]);

  /** Misma curva histórica + última lectura en vivo (sin nuevo fetch a BD). */
  useEffect(() => {
    if (streamTimePreset === 'live') return undefined;
    if (visibilityMap[DASH_WIDGET.STREAM] === false) return undefined;
    const cacheOkEarly =
      streamHistoryRowsCacheKeyRef.current ===
      `${streamHistoryDeviceId}|${streamTimePreset}|${streamSeriesChartKey}`;
    if (streamHistoryLoading && !cacheOkEarly) return undefined;
    const chart = streamingChartRef.current;
    const series = streamSeriesNormalized;
    if (!chart || !series.length || !streamHistoryDeviceId) return undefined;
    const cacheOk =
      streamHistoryRowsCacheKeyRef.current ===
      `${streamHistoryDeviceId}|${streamTimePreset}|${streamSeriesChartKey}`;
    if (!cacheOk) return undefined;
    const rows = streamHistoryRowsRef.current;
    if (!Array.isArray(rows)) return undefined;
    const streamTel = streamWidgetTelSnapshotRef.current;
    const streamCfg = streamChartWidgetCfgRef.current;
    const merged = mergeLiveIntoStreamSeriesPrepared(
      buildStreamSeriesPreparedFromRows(series, rows, streamCfg),
      streamTel,
      streamCfg
    );
    applyStreamingHistoryChartMulti(chart, merged, streamTimePreset);
    const lastPts = merged.map((sp) => sp.points[sp.points.length - 1]).filter(Boolean);
    if (lastPts.length) {
      setStreamDisplay(lastPts[0].val);
      setStreamHistoryError(null);
    }
    requestAnimationFrame(() => safeChartResize(streamingChartRef.current));
    return undefined;
  }, [
    streamTimePreset,
    streamHistoryDeviceId,
    streamSeriesNormalized,
    streamSeriesChartKey,
    streamWidgetLivePaintKey,
    streamHistoryLoading,
    streamChartWidgetCfgMerged,
    visibilityMap[DASH_WIDGET.STREAM],
  ]);

  useEffect(() => {
    if (visibilityMap[DASH_WIDGET.BAR_CHART] === false) return undefined;
    const id = setInterval(() => {
      setBarAutoRefreshEpoch((n) => n + 1);
    }, DASH_CHART_HISTORY_POLL_MS);
    return () => clearInterval(id);
  }, [visibilityMap[DASH_WIDGET.BAR_CHART]]);

  useEffect(() => {
    if (visibilityMap[DASH_WIDGET.BAR_CHART] === false) {
      barChartEffectRunIdRef.current += 1;
      barChartHistoryFetchInFlightRef.current = false;
      barHistoryRowsRef.current = [];
      barHistoryRowsCacheKeyRef.current = '';
      if (barChartJsRef.current) {
        barChartJsRef.current.destroy();
        barChartJsRef.current = null;
      }
      setBarChartLoading(false);
      return undefined;
    }

    const runId = ++barChartEffectRunIdRef.current;
    let cancelled = false;
    let historyLoadGuard;
    const isStale = () => cancelled || runId !== barChartEffectRunIdRef.current;
    const barKey = dk(DASH_WIDGET.BAR_CHART);

    (async () => {
      const fullCfg = loadAllWidgetConfigs()[barKey];
      const cfg = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.BAR_CHART), fullCfg);
      const fkRaw = cfg?.data?.fieldKey;
      const fk = fkRaw != null ? String(fkRaw).trim() : '';

      if (!barChartHistoryDeviceId || !fk || fk.startsWith('__bsd_')) {
        barHistoryRowsRef.current = [];
        barHistoryRowsCacheKeyRef.current = '';
        if (!isStale()) {
          setBarChartError('Selecciona dispositivo y campo de telemetría en edición.');
          setBarChartLoading(false);
          setBarChartHint('');
          if (barChartJsRef.current) {
            barChartJsRef.current.destroy();
            barChartJsRef.current = null;
          }
        }
        return;
      }

      const rowCacheKey = `${barChartHistoryDeviceId}|${barChartCfgSig}|e${barAutoRefreshEpoch}`;
      const fastPath =
        barHistoryRowsCacheKeyRef.current === rowCacheKey && Array.isArray(barHistoryRowsRef.current);

      const now = Date.now();
      const barCfgEarly = barChartWidgetCfgRef.current;
      const instantComputed = computeBarChartSeriesFromRows(
        fastPath ? barHistoryRowsRef.current : [],
        cfg,
        barCfgEarly,
        fk,
        barWidgetTelSnapshotRef.current,
        now,
        barChartLivePulseBufferRef.current
      );
      let instantPainted = false;
      if (instantComputed && !isStale()) {
        const tryInstant = () => {
          if (isStale()) return false;
          const mounted = mountBarChartFromComputed({
            computed: instantComputed,
            cfg,
            fk,
            canvasRef: barChartCanvasRef,
            chartRef: barChartJsRef,
            tooltipBridgeRef: barChartTooltipBridgeRef,
          });
          if (mounted) {
            instantPainted = true;
            setBarChartLoading(false);
            setBarChartError(null);
            if (!fastPath) {
              setBarChartHint('Último valor en pantalla; cargando historial…');
            }
          }
          return Boolean(mounted);
        };
        if (!tryInstant()) requestAnimationFrame(tryInstant);
      }

      if (fastPath) {
        if (!isStale()) setBarChartLoading(false);
      } else if (!instantPainted) {
        setBarChartLoading(true);
        setBarChartError(null);
        setBarChartHint('');
      } else {
        setBarChartError(null);
      }

      historyLoadGuard = setTimeout(() => {
        if (!isStale()) setBarChartLoading(false);
      }, 8000);

      const barHistoryNetwork = !fastPath;
      if (barHistoryNetwork) barChartHistoryFetchInFlightRef.current = true;
      try {
      const gran = normalizeBarChartGranularity(cfg.timeframe?.granularity) || 'hour';
      const rollingWin = barChartPresetDisplayBounds(gran, now);
      let fromMs;
      let toMs;
      if (rollingWin) {
        ({ fromMs, toMs } = rollingWin);
      } else {
        fromMs = parseRelativeTime(cfg.timeframe?.from, now, 'from') ?? now - 90 * 86400000;
        toMs = parseRelativeTime(cfg.timeframe?.to, now, 'to') ?? now;
      }

      const fetchFrom = barChartHistoryFetchFromMs(gran, fromMs, toMs);
      const fetchTo = toMs;
      const pageSize =
        gran === 'year'
          ? 4000
          : gran === 'month'
            ? 3200
            : gran === 'week'
              ? 2400
              : gran === 'day'
                ? 2000
                : gran === 'minute'
                  ? 4000
                  : gran === 'hour'
                    ? 180
                    : 2000;

      let rows = [];
      let historyFetchTimedOut = false;
      if (fastPath) {
        rows = barHistoryRowsRef.current;
      } else {
        try {
          const raw = await withTimeout(
            queryTelemetry(barChartHistoryDeviceId, fk, fetchFrom, fetchTo, pageSize, {
              bucketMs: historyChartBucketMs(gran),
            }),
            BAR_CHART_FETCH_TIMEOUT_MS,
            'bar_telemetry_timeout'
          );
          rows = normalizeTelemetryList(raw);
        } catch (e) {
          if (String(e?.message) === 'bar_telemetry_timeout') historyFetchTimedOut = true;
          console.warn('[BSD bar chart] queryTelemetry', e);
        }
        if (!isStale() && (!rows || !rows.length)) {
          try {
            const resp = await withTimeout(
              fetchDeviceHistory(
                barChartHistoryDeviceId,
                { startTime: fetchFrom, endTime: fetchTo, pageSize },
                credentials,
                token
              ),
              BAR_CHART_FETCH_TIMEOUT_MS,
              'bar_history_timeout'
            );
            const list = resp.list || resp.data?.list || [];
            rows = list.map((item) => ({
              ts: item.ts,
              timestamp: item.timestamp,
              properties: item.properties,
            }));
          } catch (e2) {
            if (String(e2?.message) === 'bar_history_timeout') historyFetchTimedOut = true;
            console.warn('[BSD bar chart] fetchDeviceHistory', e2);
          }
        }
        if (isStale()) {
          setBarChartLoading(false);
          return;
        }
        barHistoryRowsRef.current = rows;
        barHistoryRowsCacheKeyRef.current = rowCacheKey;
      }

      if (isStale()) {
        setBarChartLoading(false);
        return;
      }

      const barCfg = barChartWidgetCfgRef.current;
      const computed = computeBarChartSeriesFromRows(
        rows,
        cfg,
        barCfg,
        fk,
        barWidgetTelSnapshotRef.current,
        now,
        barChartLivePulseBufferRef.current
      );
      if (!computed) {
        if (!isStale()) {
          if (barChartJsRef.current) {
            barChartJsRef.current.destroy();
            barChartJsRef.current = null;
          }
          setBarChartError(
            historyFetchTimedOut
              ? 'Historial: tiempo de espera agotado. Revisa la conexión o reduce el intervalo.'
              : rows?.length
                ? 'No hay valores numéricos en los minutos mostrados (ventana u operación).'
                : 'Sin datos en este intervalo.'
          );
          setBarChartLoading(false);
        }
        return;
      }

      const paintBarChart = () => {
        if (isStale()) return false;
        const mounted = mountBarChartFromComputed({
          computed,
          cfg,
          fk,
          canvasRef: barChartCanvasRef,
          chartRef: barChartJsRef,
          tooltipBridgeRef: barChartTooltipBridgeRef,
        });
        if (mounted && !isStale()) {
          setBarChartLoading(false);
          setBarChartError(null);
          setBarChartHint(
            mounted.truncated
              ? 'Muchos eventos en el intervalo: se muestran solo los más recientes (límite de rendimiento).'
              : ''
          );
        }
        return Boolean(mounted);
      };

      if (!paintBarChart()) {
        let attempts = 0;
        const retryPaint = () => {
          if (isStale()) return;
          if (paintBarChart()) return;
          attempts += 1;
          if (attempts < 160) requestAnimationFrame(retryPaint);
          else if (!isStale()) {
            setBarChartError('No se pudo mostrar el gráfico. Recarga o reintenta.');
            setBarChartLoading(false);
          }
        };
        requestAnimationFrame(retryPaint);
      }
      } finally {
        if (barHistoryNetwork) barChartHistoryFetchInFlightRef.current = false;
        clearTimeout(historyLoadGuard);
      }
    })();

    return () => {
      cancelled = true;
      if (historyLoadGuard) clearTimeout(historyLoadGuard);
    };
  }, [
    barChartCfgSig,
    barChartHistoryDeviceId,
    barChartWidgetCfgMerged,
    barAutoRefreshEpoch,
    credentials,
    token,
    variant,
    visibilityMap[DASH_WIDGET.BAR_CHART],
  ]);

  /** Precarga del gráfico de barras en cuanto hay telemetría (listado o /properties), sin esperar al historial. */
  useLayoutEffect(() => {
    if (visibilityMap[DASH_WIDGET.BAR_CHART] === false) return undefined;
    if (!barChartHistoryDeviceId) return undefined;
    if (barChartJsRef.current) return undefined;

    const barKey = dk(DASH_WIDGET.BAR_CHART);
    const fullCfg = loadAllWidgetConfigs()[barKey];
    const cfg = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.BAR_CHART), fullCfg);
    const fkRaw = cfg?.data?.fieldKey;
    const fk = fkRaw != null ? String(fkRaw).trim() : '';
    if (!fk || fk.startsWith('__bsd_')) return undefined;

    const computed = computeBarChartSeriesFromRows(
      barHistoryRowsRef.current || [],
      cfg,
      barChartWidgetCfgRef.current,
      fk,
      barWidgetTelSnapshotRef.current,
      Date.now(),
      barChartLivePulseBufferRef.current
    );
    if (!computed) return undefined;

    const mounted = mountBarChartFromComputed({
      computed,
      cfg,
      fk,
      canvasRef: barChartCanvasRef,
      chartRef: barChartJsRef,
      tooltipBridgeRef: barChartTooltipBridgeRef,
    });
    if (mounted) {
      setBarChartLoading(false);
      setBarChartError(null);
      if (!barHistoryRowsRef.current?.length) {
        setBarChartHint('Último valor en pantalla; cargando historial…');
      }
    }
    return undefined;
  }, [
    barChartLiveValueSig,
    barChartHistoryDeviceId,
    barChartCfgSig,
    visibilityMap[DASH_WIDGET.BAR_CHART],
    dk,
  ]);

  /** Repinta barras con telemetría en vivo sin re-disparar fetch (barChartLiveValueSig cambia muy a menudo). */
  useEffect(() => {
    if (visibilityMap[DASH_WIDGET.BAR_CHART] === false) return undefined;
    const chart = barChartJsRef.current;
    if (!chart) return undefined;
    if (!barChartHistoryDeviceId) return undefined;

    const barKey = dk(DASH_WIDGET.BAR_CHART);
    const fullCfg = loadAllWidgetConfigs()[barKey];
    const cfg = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.BAR_CHART), fullCfg);
    const fkRaw = cfg?.data?.fieldKey;
    const fk = fkRaw != null ? String(fkRaw).trim() : '';
    if (!fk || fk.startsWith('__bsd_')) return undefined;

    const barCfg = barChartWidgetCfgRef.current;
    const rows = barHistoryRowsRef.current || [];
    const computed = computeBarChartSeriesFromRows(
      rows,
      cfg,
      barCfg,
      fk,
      barWidgetTelSnapshotRef.current,
      Date.now(),
      barChartLivePulseBufferRef.current
    );
    if (!computed) return undefined;

    try {
      const cvs = barChartCanvasRef.current;
      const scrollWrap = cvs?.parentElement;
      let distFromRight = null;
      if (scrollWrap && scrollWrap.scrollWidth > scrollWrap.clientWidth) {
        distFromRight = scrollWrap.scrollWidth - scrollWrap.clientWidth - scrollWrap.scrollLeft;
      }

      chart.data.labels = computed.labels;
      chart.data.datasets[0].data = computed.values;
      chart.data.datasets[0].backgroundColor = computed.barFillColors;
      chart.data.datasets[0].borderRadius = computed.nBar > 200 ? 1 : 4;
      chart.data.datasets[0].maxBarThickness = computed.maxBarThickness;
      if (computed.hasTarget && chart.data.datasets[1]) {
        chart.data.datasets[1].data = computed.labels.map(() => computed.targetNum);
      }
      chart.options.scales.y.suggestedMin = computed.yMin;
      chart.options.scales.y.suggestedMax = computed.yMax;
      chart.options.scales.x.ticks.maxRotation = computed.nBar > 80 ? 60 : 0;
      chart.options.scales.x.ticks.maxTicksLimit =
        computed.nBar > 400 ? 16 : computed.nBar > 120 ? 12 : computed.nBar > 60 ? 10 : 24;
      const pxPerBar =
        computed.nBar > 800 ? 2 : computed.nBar > 400 ? 2.5 : computed.nBar > 144 ? 3 : computed.nBar > 60 ? 5 : 12;
      if (cvs) {
        if (computed.nBar > 36) {
          cvs.style.minWidth = `${Math.ceil(Math.max(320, computed.nBar * pxPerBar))}px`;
        } else {
          cvs.style.minWidth = '';
        }
      }
      chart.$barTooltipCtx = {
        fieldKey: fk,
        model: barChartTooltipBridgeRef.current.model,
        hints: barChartTooltipBridgeRef.current.hints,
        unit: computed.unit,
        dec: computed.dec,
        gauge: cfg.gauge,
      };
      chart.update('none');
      requestAnimationFrame(() => {
        const w = barChartCanvasRef.current?.parentElement;
        if (w && distFromRight != null) {
          const max = w.scrollWidth - w.clientWidth;
          if (max > 0) w.scrollLeft = Math.max(0, max - distFromRight);
        }
        if (barChartJsRef.current) safeChartResize(barChartJsRef.current);
      });
    } catch (e) {
      console.warn('[BSD bar chart] live repaint', e);
    }
    return undefined;
  }, [
    barChartLiveValueSig,
    barChartCfgSig,
    barChartHistoryDeviceId,
    barChartWidgetCfgMerged,
    visibilityMap[DASH_WIDGET.BAR_CHART],
    dk,
  ]);

  useLayoutEffect(() => {
    if (visibilityMap[DASH_WIDGET.BAR_CHART] === false) return undefined;
    if (barChartLoading) return undefined;
    const ch = barChartJsRef.current;
    if (!ch) return undefined;
    const id = requestAnimationFrame(() => {
      const chart = barChartJsRef.current;
      if (!chart) return;
      try {
        safeChartResize(chart);
        chart.update('none');
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [barChartCfgSig, barChartLoading, visibilityMap[DASH_WIDGET.BAR_CHART]]);

  const trackingMapStorageKey = dk(DASH_WIDGET.TRACKING_MAP);
  const trackingMapCfgMerged = useMemo(
    () =>
      mergeWidgetConfig(
        dashboardWidgetSensorStub(DASH_WIDGET.TRACKING_MAP),
        widgetConfigs[trackingMapStorageKey]
      ),
    [widgetConfigs, trackingMapStorageKey]
  );
  const trackingMapFetchSig = JSON.stringify({
    tr: trackingMapCfgMerged.data?.trackingTimeRange || 'day',
    tf: String(trackingMapCfgMerged.data?.trackingTelemetryField || '').trim(),
  });

  useEffect(() => {
    if (visibilityMap[DASH_WIDGET.TRACKING_MAP] === false) return undefined;
    if (!trackingMapHistoryDeviceId) {
      setTrackingPathPoints([]);
      setTrackingError(null);
      setTrackingLoading(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setTrackingLoading(true);
      setTrackingError(null);
      const full = loadAllWidgetConfigs()[trackingMapStorageKey];
      const cfg = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.TRACKING_MAP), full);
      const trRaw = String(cfg.data?.trackingTimeRange || '').toLowerCase();
      const range = trRaw === 'week' || trRaw === 'month' ? trRaw : 'day';
      const windowMs = trackingWindowEndMs(range);
      const endMs = Date.now();
      const startMs = endMs - windowMs;
      const telemetryField = String(cfg.data?.trackingTelemetryField || '').trim();
      const keys = {
        trackingTelemetryField: telemetryField,
        latitudeKey: 'latitude',
        longitudeKey: 'longitude',
        historyKey: 'history',
      };
      let rows = [];
      const propKey = telemetryField || null;
      try {
        rows = await queryTelemetry(trackingMapHistoryDeviceId, propKey, startMs, endMs);
      } catch (e) {
        console.warn('[BSD tracking map] queryTelemetry', e);
      }
      if (!cancelled && telemetryField && (!rows || !normalizeTelemetryList(rows).length)) {
        try {
          rows = await queryTelemetry(trackingMapHistoryDeviceId, null, startMs, endMs);
        } catch (e2) {
          console.warn('[BSD tracking map] queryTelemetry fallback', e2);
        }
      }
      if (!cancelled && (!rows || !normalizeTelemetryList(rows).length)) {
        try {
          const resp = await fetchDeviceHistory(
            trackingMapHistoryDeviceId,
            { startTime: startMs, endTime: endMs, pageSize: 8000 },
            credentials,
            token
          );
          const list = resp.list || resp.data?.list || [];
          rows = list.map((item) => ({
            ts: item.ts,
            timestamp: item.timestamp,
            properties: item.properties,
          }));
        } catch (e2) {
          console.warn('[BSD tracking map] fetchDeviceHistory', e2);
          if (!cancelled) {
            setTrackingPathPoints([]);
            setTrackingError(e2?.message || 'No se pudo cargar el historial');
            setTrackingLoading(false);
          }
          return;
        }
      }
      if (cancelled) return;
      const rawPts = collectTrackingPointsFromTelemetryRows(rows, keys);
      const slack = 120000;
      const filtered = rawPts.filter((p) => p.ts >= startMs - slack && p.ts <= endMs + slack);
      setTrackingPathPoints(filtered.map((p) => ({ lat: p.lat, lng: p.lng, ts: p.ts })));
      if (!filtered.length) setTrackingError('Sin puntos GPS en este periodo.');
      else setTrackingError(null);
      setTrackingLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    visibilityMap[DASH_WIDGET.TRACKING_MAP],
    trackingMapHistoryDeviceId,
    credentials,
    token,
    trackingMapFetchSig,
    trackingMapStorageKey,
  ]);

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
  };

  const wTitle = (wid, fb) => {
    const t = widgetConfigs[dk(wid)]?.basics?.title;
    return (t && String(t).trim()) || fb;
  };
  const wTitleStyle = (wid) => {
    const c = widgetConfigs[dk(wid)]?.appearance?.titleColor;
    if (!c) return undefined;
    const hex = String(c).trim().toLowerCase();
    const lightTheme =
      typeof document !== 'undefined' && !document.body.classList.contains('theme-dark');
    /** El default del cristal era blanco; en tarjetas porcelana se deja el color del tema. */
    if (lightTheme && (hex === '#fff' || hex === '#ffffff' || hex === 'white')) return undefined;
    return { color: c };
  };

  const mergeGridSlotShell = useCallback((slotId) => {
    const gridIt = gridLayoutItemByIdRef.current.get(String(slotId));
    if (!gridIt) return { className: 'bsd-grid-slot' };
    return {
      className: 'bsd-grid-slot',
      'data-grid': {
        i: String(gridIt.i),
        x: gridIt.x,
        y: gridIt.y,
        w: gridIt.w,
        h: gridIt.h,
        ...(gridIt.minW != null ? { minW: gridIt.minW } : {}),
        ...(gridIt.minH != null ? { minH: gridIt.minH } : {}),
      },
    };
  }, []);

  const mergeShell = useCallback(
    (wid, className) => {
      const cfg = widgetConfigs[dk(wid)];
      const fk = cfg?.data?.fieldKey != null ? String(cfg.data.fieldKey).trim() : '';
      let primaryRaw;
      let alternateRaw;
      if (fk && !fk.startsWith('__bsd_')) {
        const baseId = dashboardWidgetBaseId(wid);
        const telW = telemetryLivePropsForPanelWidget(wid);
        let scalar;
        if (baseId === DASH_WIDGET.TEXT) {
          scalar = resolveTextWidgetRawScalar(telW, fk, cfg);
        } else if (baseId === DASH_WIDGET.VEleta) {
          scalar = resolveWindDirectionScalar(telW, fk, cfg);
        } else {
          scalar = resolveTelemetryDisplaySource(telW, fk);
        }
        if (scalar !== undefined && scalar !== null) {
          if (baseId === DASH_WIDGET.TEXT && resolveLiveDeviceModelForPanelWidget(wid)) {
            const friendly = tryTelemetryDisplayLabel(
              resolveLiveDeviceModelForPanelWidget(wid),
              fk,
              scalar,
              resolveTelemetryHintsForPanelWidget(wid)
            );
            if (friendly != null && String(friendly).trim()) {
              primaryRaw = String(friendly).trim();
              alternateRaw = scalar;
            } else {
              primaryRaw = scalar;
            }
          } else {
            primaryRaw = scalar;
          }
        }
      }
      const app = appearanceWithConditionalBackground(cfg?.appearance, primaryRaw, alternateRaw);
      const st = buildBsdWidgetSurfaceStyle(app);
      const gridIt = gridLayoutItemByIdRef.current.get(String(wid));
      const dataGrid = gridIt
        ? {
            'data-grid': {
              i: String(gridIt.i),
              x: gridIt.x,
              y: gridIt.y,
              w: gridIt.w,
              h: gridIt.h,
              ...(gridIt.minW != null ? { minW: gridIt.minW } : {}),
              ...(gridIt.minH != null ? { minH: gridIt.minH } : {}),
            },
          }
        : {};
      return {
        className: [className, isWidgetBackgroundTransparent(app) ? 'bsd-widget-surface--clear' : '']
          .filter(Boolean)
          .join(' '),
        style: st || undefined,
        ...dataGrid,
      };
    },
    [
      widgetConfigs,
      dk,
      variant,
      telemetryLivePropsForPanelWidget,
      resolveLiveDeviceModelForPanelWidget,
      resolveTelemetryHintsForPanelWidget,
    ]
  );
  const streamCfgStore = widgetConfigs[dk(DASH_WIDGET.STREAM)];
  const streamUnit =
    streamCfgStore?.data?.unit != null && String(streamCfgStore.data.unit).length > 0
      ? streamCfgStore.data.unit
      : '°C';

  const openDashWidgetEdit = (wid, buildSensor, editScope = 'value') => {
    if (!canEditDashboard) return;
    openWidgetEditModal({
      storageKey: dk(wid),
      sensor: buildSensor(),
      editScope,
    });
  };

  const applyStreamTimePreset = useCallback((slotId, presetId) => {
    const id = STREAM_PRESET_IDS.has(presetId) ? presetId : 'live';
    setStreamTimePreset(id);
    const k = dk(slotId);
    const prev = widgetConfigsRef.current[k];
    const draft = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.STREAM), prev || {});
    draft.data = { ...draft.data, historyRangePreset: id };
    saveWidgetConfig(k, draft);
    scheduleBsdServerPersistRef.current?.();
    setWidgetConfigs(loadAllWidgetConfigs());
  }, [dk]);

  const applyValueDateFilter = useCallback(
    (slotId, preset, customPatch) => {
      const k = dk(slotId);
      const prev = widgetConfigsRef.current[k];
      const draft = mergeWidgetConfig(dashboardWidgetSensorStub(slotId), prev || {});
      if (customPatch && typeof customPatch === 'object') {
        draft.timeframe = { ...(draft.timeframe || {}) };
        if (customPatch.from != null) draft.timeframe.customFrom = customPatch.from;
        if (customPatch.to != null) draft.timeframe.customTo = customPatch.to;
      }
      applyValueDateFilterPreset(draft, preset);
      saveWidgetConfig(k, draft);
      scheduleBsdServerPersistRef.current?.();
      setWidgetConfigs(loadAllWidgetConfigs());
      if (preset === 'custom') {
        setDateFilterCustomSlotId(slotId);
        setDateFilterCustomDraft({
          from: String(draft.timeframe?.customFrom || ''),
          to: String(draft.timeframe?.customTo || ''),
        });
      } else {
        setDateFilterCustomSlotId((cur) => (cur === slotId ? null : cur));
      }
    },
    [dk]
  );

  const valueDateFilterBar = (slotId) => {
    const cfg = widgetConfigs[dk(slotId)];
    const preset = normalizeValueDateFilterPreset(cfg?.timeframe?.filterPreset);
    return (
      <>
        <ValueWidgetDateFilterButtons
          variant="widget"
          activePreset={preset}
          onSelect={(id) => applyValueDateFilter(slotId, id)}
        />
        {preset === 'custom' && dateFilterCustomSlotId === slotId ? (
          <ValueWidgetDateFilterCustomFields
            compact
            showApply
            customFrom={dateFilterCustomDraft.from}
            customTo={dateFilterCustomDraft.to}
            onChangeFrom={(v) => setDateFilterCustomDraft((d) => ({ ...d, from: v }))}
            onChangeTo={(v) => setDateFilterCustomDraft((d) => ({ ...d, to: v }))}
            onApply={() => applyValueDateFilter(slotId, 'custom', dateFilterCustomDraft)}
          />
        ) : null}
      </>
    );
  };

  const applyBarChartGranularity = useCallback((slotId, gran) => {
    const k = dk(slotId);
    const prev = widgetConfigs[k];
    const draft = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.BAR_CHART), prev);
    if (gran) applyHistoryGranularityPreset(draft, gran);
    else {
      draft.timeframe = draft.timeframe || {};
      draft.timeframe.granularity = '';
      draft.timeframe.mode = 'interval';
      if (!draft.timeframe.from) draft.timeframe.from = '90 días atrás';
      if (!draft.timeframe.to) draft.timeframe.to = 'now';
      if (!draft.timeframe.operation) draft.timeframe.operation = 'avg';
    }
    saveWidgetConfig(k, draft);
    scheduleBsdServerPersistRef.current?.();
    setWidgetConfigs(loadAllWidgetConfigs());
  }, [variant, widgetConfigs, dk]);

  const applyTrackingTimeRange = useCallback(
    (slotId, range) => {
      const k = dk(slotId);
      const prev = widgetConfigs[k];
      const draft = mergeWidgetConfig(dashboardWidgetSensorStub(DASH_WIDGET.TRACKING_MAP), prev);
      draft.data = { ...draft.data, trackingTimeRange: range };
      saveWidgetConfig(k, draft);
      scheduleBsdServerPersistRef.current?.();
      setWidgetConfigs(loadAllWidgetConfigs());
    },
    [widgetConfigs, dk]
  );

  const applyMapBaseLayer = useCallback(
    (wid, layerId) => {
      const k = dk(wid);
      const prev = widgetConfigsRef.current[k];
      const draft = mergeWidgetConfig(dashboardWidgetSensorStub(wid), prev || {});
      draft.data = { ...draft.data, mapBaseLayer: normalizeMapBaseLayerId(layerId) };
      saveWidgetConfig(k, draft);
      scheduleBsdServerPersistRef.current?.();
      setWidgetConfigs(loadAllWidgetConfigs());
    },
    [dk]
  );

  const removeDashWidget = useCallback(
    (wid, options = {}) => {
      if (!canEditDashboard) return;
      const resetConfig = Boolean(options.resetConfig);
      const removeFamily = Boolean(options.removeFamily);
      const widStr = String(wid);
      const baseId = dashboardWidgetBaseId(widStr);
      const isMulti = MULTI_INSTANCE_DASH_WIDGETS.has(baseId);

      let idsToRemove = [widStr];
      if (removeFamily && isMulti) {
        idsToRemove = (gridLayoutLatestRef.current || [])
          .map((it) => String(it.i))
          .filter((id) => dashboardWidgetBaseId(id) === baseId);
      }

      const cur = normalizeLayoutForPersistence(gridLayoutLatestRef.current || []);
      const removeSet = new Set(idsToRemove);
      const without = cur.filter((it) => !removeSet.has(String(it.i)));

      const visNext = { ...visibilityMapRef.current };
      if (isMulti) {
        const still = without.some((it) => dashboardWidgetBaseId(String(it.i)) === baseId);
        if (!still) visNext[baseId] = false;
      } else {
        visNext[widStr] = false;
      }
      visibilityMapRef.current = visNext;
      setVisibilityMap(() => {
        saveDashboardVisibility(variant, visNext, dashDeviceId, variant === 'panel' ? panelInstanceId : undefined,
        variant === 'panel' ? panelOwnerSegment : undefined);
        return visNext;
      });

      const normalized =
        computeBsdDashboardNormalizedLayout(
          without,
          without,
          variant,
          (panelDevicesRef.current?.length ?? 0) > 0 ? 1 : 0,
          visNext
        ) || normalizeLayoutForPersistence(without);
      const packed = resolveBsdDashboardGridLayout(normalized, visNext);
      gridLayoutLatestRef.current = packed;
      setGridLayout(packed);
      persistBsdGridLayoutDisk(packed);

      if (resetConfig) {
        try {
          const all = loadAllWidgetConfigs();
          if (all && typeof all === 'object') {
            const copy = { ...all };
            let changed = false;
            for (const id of idsToRemove) {
              const k = dk(id);
              if (Object.prototype.hasOwnProperty.call(copy, k)) {
                delete copy[k];
                changed = true;
              }
            }
            if (changed) {
              localStorage.setItem(BSD_VALUE_WIDGETS_STORAGE_KEY, JSON.stringify(copy));
              setWidgetConfigs(loadAllWidgetConfigs());
            }
          }
        } catch {
          /* ignore */
        }
      }
      scheduleBsdServerPersistRef.current?.();
    },
    [variant, canEditDashboard, dashDeviceId, dashboardGridLayoutKey, dk, persistBsdGridLayoutDisk, panelOwnerSegment]
  );

  /**
   * El grid (`react-grid-layout`) solo muestra un widget si existe una celda `layout[].i === key` del hijo.
   * Al activar visibilidad hay que asegurar esa fila (p. ej. Circular recién agregado).
   * Posición: primera celda libre (`placeNewBsdGridItem`) para no solapar al agregar desde la galería.
   */
  const ensureGridSlotForWidget = useCallback(
    (wid, visibilitySnapshot) => {
      const vis =
        visibilitySnapshot && typeof visibilitySnapshot === 'object' && !Array.isArray(visibilitySnapshot)
          ? visibilitySnapshot
          : visibilityMapRef.current;
      const slot = normalizeNewWidgetSlotTemplate(buildModerateBsdGridTemplateForWidget(String(wid)));
      if (!slot) return;
      const cur = normalizeLayoutForPersistence(gridLayoutLatestRef.current || []);
      const resolved = resolveBsdDashboardGridLayout(
        ensureBsdGridWidgetSlotAtFirstGap(cur, vis, slot),
        vis
      );
      gridLayoutLatestRef.current = resolved;
      setGridLayout(resolved);
      persistBsdGridLayoutDisk(resolved);
      setGridLayoutRepairEpoch((n) => n + 1);
    },
    [persistBsdGridLayoutDisk]
  );

  const addDashWidget = useCallback(
    (wid) => {
      const next = { ...visibilityMapRef.current, [wid]: true };
      visibilityMapRef.current = next;
      setVisibilityMap(() => {
        saveDashboardVisibility(variant, next, dashDeviceId, variant === 'panel' ? panelInstanceId : undefined,
        variant === 'panel' ? panelOwnerSegment : undefined);
        return next;
      });
      ensureGridSlotForWidget(wid, next);
    },
    [variant, dashDeviceId, ensureGridSlotForWidget, panelInstanceId, panelOwnerSegment]
  );

  const resolvePanelDeviceModel = useCallback(
    (devId) => {
      if (!devId) return '';
      const dev = (panelDevices || []).find((d) => String(d.deviceId) === String(devId));
      return dev?.model || dev?.productModel || '';
    },
    [panelDevices]
  );

  const availableDataFields = useMemo(() => {
    const baseKeys =
      telemetryLiveProps && typeof telemetryLiveProps === 'object' && !Array.isArray(telemetryLiveProps)
        ? Object.keys(telemetryLiveProps).filter(isTelemetryFieldPickerKey)
        : [];

    const fromConfigs = collectFieldKeysFromStoredWidgetConfigs(
      widgetConfigs,
      variant,
      dashDeviceId,
      variant === 'panel' ? panelInstanceId : undefined,
      variant === 'panel' ? panelOwnerSegment : undefined
    );

    const fromSensors = [];
    for (const s of sensors || []) {
      if (variant === 'device' && device?.deviceId != null && s?.sourceDeviceId != null) {
        if (String(s.sourceDeviceId) !== String(device.deviceId)) continue;
      }
      const pk = s?.propertyKey;
      if (pk != null && String(pk).trim() && isTelemetryFieldPickerKey(String(pk).trim())) {
        fromSensors.push(String(pk).trim());
      }
    }

    const fromDeviceRow = variant === 'device' ? collectScalarKeysFromDeviceLikeRecord(device) : [];
    const fromDeviceNestedProps =
      variant === 'device' && device?.properties && typeof device.properties === 'object'
        ? Object.keys(device.properties).filter((k) => {
            const v = device.properties[k];
            if (v == null) return false;
            if (typeof v === 'object' && !Array.isArray(v)) return false;
            return isTelemetryFieldPickerKey(k);
          })
        : [];

    const fromPanelDeviceRow =
      variant === 'panel' && controlDeviceId
        ? collectScalarKeysFromDeviceLikeRecord(
            (panelDevices || []).find((d) => String(d.deviceId) === String(controlDeviceId))
          )
        : [];

    const fromPanelAllTelemetry =
      variant === 'panel'
        ? Object.values(panelTelemetryExpandedByDeviceId || {}).flatMap((exp) =>
            exp && typeof exp === 'object' && !Array.isArray(exp)
              ? Object.keys(exp).filter(isTelemetryFieldPickerKey)
              : []
          )
        : [];

    const set = new Set([
      ...baseKeys,
      ...fromConfigs,
      ...fromSensors,
      ...fromDeviceRow,
      ...fromDeviceNestedProps,
      ...fromPanelDeviceRow,
      ...fromPanelAllTelemetry,
    ]);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [
    telemetryLiveProps,
    widgetConfigs,
    variant,
    dashDeviceId,
    sensors,
    device,
    controlDeviceId,
    panelDevices,
    panelTelemetryExpandedByDeviceId,
    panelInstanceId,
    panelOwnerSegment,
  ]);

  const panelDeviceSelectOptions = useMemo(
    () =>
      (panelDevices || []).map((d) => ({
        deviceId: String(d.deviceId),
        label:
          (d.name != null && String(d.name).trim()) ||
          (d.deviceName != null && String(d.deviceName).trim()) ||
          String(d.deviceId ?? ''),
      })),
    [panelDevices]
  );

  /** Claves escalares del listado de equipos (p. ej. último valor conocido) mientras llega `mergeDeviceLive` para la vista previa del modal. */
  const panelPreviewExtraDataKeysForModal = useMemo(() => {
    if (variant !== 'panel' || panelModalPreviewDeviceId == null || !String(panelModalPreviewDeviceId).trim()) {
      return [];
    }
    const dev = (panelDevices || []).find((d) => String(d.deviceId) === String(panelModalPreviewDeviceId));
    return collectScalarKeysFromDeviceLikeRecord(dev);
  }, [variant, panelDevices, panelModalPreviewDeviceId]);

  const getPanelTelemetryExpandedForModal = useCallback(
    (deviceId) => {
      if (deviceId == null || String(deviceId).trim() === '') return telemetryLiveProps;
      if (controlDeviceId && String(deviceId) === String(controlDeviceId)) return telemetryLiveProps;
      return panelTelemetryExpandedByDeviceId[String(deviceId)] || {};
    },
    [telemetryLiveProps, controlDeviceId, panelTelemetryExpandedByDeviceId]
  );

  const getPanelLiveDeviceModelForModal = useCallback(
    (deviceId) => {
      if (deviceId == null || String(deviceId).trim() === '') return liveDeviceModel;
      const dev = panelDevices.find((d) => String(d.deviceId) === String(deviceId));
      return dev?.model != null ? String(dev.model) : '';
    },
    [liveDeviceModel, panelDevices]
  );

  const getPanelTelemetryHintsForModal = useCallback(
    (deviceId) => {
      if (deviceId == null || String(deviceId).trim() === '') return telemetryHintMap;
      return getTelemetryLabelHintsForDevice(String(deviceId));
    },
    [telemetryHintMap]
  );

  const getPanelDownlinksForModal = useCallback(
    (deviceId) => {
      if (deviceId == null || String(deviceId).trim() === '') return downlinkList;
      return loadDownlinksFromStorage(
        String(deviceId),
        deviceModelForDownlinks(deviceId, null, panelDevices)
      );
    },
    [downlinkList, panelDevices]
  );

  const visibleSensorsForGrid = useMemo(
    () => sensors.filter((s) => !hiddenSensorCardKeys.has(`${s.sourceDeviceId}|${s.propertyKey}`)),
    [sensors, hiddenSensorCardKeys]
  );

  const buildDashboardWidgetSensor = useCallback(
    (wid) => {
      const pk = `__bsd_${wid}`;
      switch (dashboardWidgetBaseId(wid)) {
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
            value: 0,
            unit: '',
            icon: '⚡',
            threshold: 1,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.DOWNLINK:
          return {
            id: 0,
            name: 'Downlink',
            value: 0,
            unit: 'cmds',
            icon: '⚡',
            threshold: 10,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.IMAGE: {
          const imgUrl = imageUrlBySlot[wid];
          return {
            id: 0,
            name: 'Imagen',
            value: imgUrl ? 1 : 0,
            unit: '',
            icon: '🖼️',
            threshold: 1,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        }
        case DASH_WIDGET.MAP: {
          const coords = mapCoordsBySlot[wid];
          return {
            id: 0,
            name: 'Mapa',
            value: coords ? 1 : 0,
            unit: '',
            icon: '📍',
            threshold: 1,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        }
        case DASH_WIDGET.TRACKING_MAP:
          return {
            id: 0,
            name: 'Mapa de rastreo',
            value: trackingPathPoints.length,
            unit: 'pts',
            icon: '🛰️',
            threshold: 1000,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.SATISFACTION: {
          const su = satisfactionUiBySlot[wid];
          return {
            id: 0,
            name: 'Circular',
            value: su?.rawValue != null ? su.rawValue : su?.ringPct ?? 0,
            unit: '%',
            icon: '◎',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        }
        case DASH_WIDGET.CONTAINER: {
          const cu = containerUiBySlot[wid];
          return {
            id: 0,
            name: 'Contenedor',
            value: cu?.rawValue != null ? cu.rawValue : cu?.ringPct ?? 0,
            unit: '%',
            icon: '🛢',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        }
        case DASH_WIDGET.BATTERY_LEVEL: {
          const bu = batteryLevelUiBySlot[wid];
          return {
            id: 0,
            name: 'Nivel Batería',
            value: bu?.rawValue != null ? bu.rawValue : bu?.ringPct ?? 0,
            unit: '%',
            icon: '🔋',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        }
        case DASH_WIDGET.METRIC_CIRCULAR: {
          const ui = metricCircularUiBySlot[wid];
          return {
            id: 0,
            name: 'Métrica circular',
            value: ui?.rawValue != null ? ui.rawValue : 0,
            unit: ui?.unitDisplay ?? '',
            icon: '◔',
            threshold: ui?.scaleHi ?? 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        }
        case DASH_WIDGET.BAR_CHART:
          return {
            id: 0,
            name: 'Grafico Barras',
            value: 0,
            unit: '',
            icon: '📊',
            threshold: 100,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.TEXT:
          return {
            id: 0,
            name: 'Texto',
            value: 0,
            unit: widgetConfigs[dk(wid)]?.data?.unit ? String(widgetConfigs[dk(wid)].data.unit) : '',
            icon: '📝',
            threshold: 1,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        case DASH_WIDGET.VEleta: {
          const vu = veletaWidgetUiBySlot[wid];
          return {
            id: 0,
            name: 'Veleta',
            value: vu?.degrees != null ? vu.degrees : 0,
            unit: '°',
            icon: '🧭',
            threshold: 360,
            propertyKey: pk,
            sourceDeviceId: 'dashboard',
          };
        }
        case DASH_WIDGET.STREAM:
          return {
            id: 0,
            name: 'Grafico Lineal',
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
      imageUrlBySlot,
      mapCoordsBySlot,
      trackingPathPoints.length,
      satisfactionUiBySlot,
      containerUiBySlot,
      batteryLevelUiBySlot,
      metricCircularUiBySlot,
      veletaWidgetUiBySlot,
      widgetConfigs,
      variant,
      streamDisplay,
      streamUnit,
    ]
  );

  const duplicateDashWidget = useCallback(
    (sourceWid) => {
      if (!canEditDashboard) return;
      const widStr = String(sourceWid);
      const baseId = dashboardWidgetBaseId(widStr);
      if (baseId === DASH_WIDGET.PANEL_DEVICE_BAR || baseId === DASH_WIDGET.SENSOR_GRID) return;
      if (!MULTI_INSTANCE_DASH_WIDGETS.has(baseId)) return;

      const newId = makeDashboardWidgetCloneId(baseId);
      cloneWidgetConfigBetweenKeys(dk(widStr), dk(newId), baseId);

      const curVis = { ...visibilityMapRef.current, [baseId]: true };
      visibilityMapRef.current = curVis;
      setVisibilityMap(() => {
        saveDashboardVisibility(
          variant,
          curVis,
          dashDeviceId,
          variant === 'panel' ? panelInstanceId : undefined,
          variant === 'panel' ? panelOwnerSegment : undefined
        );
        return curVis;
      });

      const cur = normalizeLayoutForPersistence(gridLayoutLatestRef.current || []);
      const slot = normalizeNewWidgetSlotTemplate({ ...buildModerateBsdGridTemplateForWidget(newId), i: newId });
      const resolved = resolveBsdDashboardGridLayout(
        appendBsdGridWidgetAtFirstGap(cur, curVis, slot),
        curVis
      );
      gridLayoutLatestRef.current = resolved;
      setGridLayout(resolved);
      persistBsdGridLayoutDisk(resolved);
      setGridLayoutRepairEpoch((n) => n + 1);
      setWidgetConfigs(loadAllWidgetConfigs());
      scheduleBsdServerPersistRef.current?.();

      openWidgetEditModal({
        storageKey: dk(newId),
        sensor: buildDashboardWidgetSensor(newId),
        editScope: 'value',
      });
    },
    [
      canEditDashboard,
      variant,
      dashDeviceId,
      dk,
      persistBsdGridLayoutDisk,
      buildDashboardWidgetSensor,
      openWidgetEditModal,
      panelInstanceId,
      panelOwnerSegment,
    ]
  );

  const duplicateSensorCardAsTextWidget = useCallback(
    (sensor) => {
      if (!canEditDashboard) return;
      const baseId = DASH_WIDGET.TEXT;
      const newId = makeDashboardWidgetCloneId(baseId);
      const srcCfg = getWidgetConfig(sensor);
      const stub = dashboardWidgetSensorStub(baseId);
      const merged = mergeWidgetConfig(stub, srcCfg ? JSON.parse(JSON.stringify(srcCfg)) : null);
      merged.basics = {
        ...(merged.basics || {}),
        title: srcCfg?.basics?.title || sensor.name || String(sensor.propertyKey || 'Texto'),
      };
      merged.data = {
        ...(merged.data || {}),
        fieldKey: srcCfg?.data?.fieldKey || sensor.propertyKey,
        unit: srcCfg?.data?.unit != null ? srcCfg.data.unit : sensor.unit || '',
      };
      if (variant === 'panel' && sensor.sourceDeviceId && sensor.sourceDeviceId !== 'demo') {
        merged.data.panelBoundDeviceId = String(sensor.sourceDeviceId);
      }
      saveWidgetConfig(dk(newId), merged);

      const curVis = { ...visibilityMapRef.current, [baseId]: true };
      visibilityMapRef.current = curVis;
      setVisibilityMap(() => {
        saveDashboardVisibility(
          variant,
          curVis,
          dashDeviceId,
          variant === 'panel' ? panelInstanceId : undefined,
          variant === 'panel' ? panelOwnerSegment : undefined
        );
        return curVis;
      });

      const cur = normalizeLayoutForPersistence(gridLayoutLatestRef.current || []);
      const slot = normalizeNewWidgetSlotTemplate({ ...buildModerateBsdGridTemplateForWidget(newId), i: newId });
      const resolved = resolveBsdDashboardGridLayout(
        appendBsdGridWidgetAtFirstGap(cur, curVis, slot),
        curVis
      );
      gridLayoutLatestRef.current = resolved;
      setGridLayout(resolved);
      persistBsdGridLayoutDisk(resolved);
      setGridLayoutRepairEpoch((n) => n + 1);
      setWidgetConfigs(loadAllWidgetConfigs());
      scheduleBsdServerPersistRef.current?.();

      openWidgetEditModal({
        storageKey: dk(newId),
        sensor: buildDashboardWidgetSensor(newId),
        editScope: 'value',
      });
    },
    [
      canEditDashboard,
      getWidgetConfig,
      variant,
      dashDeviceId,
      dk,
      persistBsdGridLayoutDisk,
      buildDashboardWidgetSensor,
      openWidgetEditModal,
      panelInstanceId,
      panelOwnerSegment,
    ]
  );

  const dashWidgetChrome = useCallback(
    (wid, onEditClick) => {
      const baseId = dashboardWidgetBaseId(String(wid));
      const canDuplicate =
        baseId !== DASH_WIDGET.PANEL_DEVICE_BAR && baseId !== DASH_WIDGET.SENSOR_GRID;
      return (
        <div className="bsd-widget-actions">
          {canDuplicate ? (
            <button
              type="button"
              className="bsd-widget-duplicate-btn"
              onClick={(e) => {
                e.stopPropagation();
                duplicateDashWidget(wid);
              }}
              aria-label="Duplicar widget"
              title="Duplicar widget"
            >
              <Copy size={16} />
            </button>
          ) : null}
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
    },
    [duplicateDashWidget, removeDashWidget]
  );

  /** Misma galería que Dispositivos; en Panel Control el equipo se elige al editar el widget (`panelBoundDeviceId`). */
  const addableWidgetMenuEntries = useMemo(
    () => getDashboardWidgetMenuEntries().filter((e) => !e.panelOnly),
    []
  );

  const closeWidgetGallery = useCallback(() => {
    setWidgetGalleryOpen(false);
    setWidgetGallerySearch('');
    setWidgetGalleryCategory('all');
  }, []);

  const widgetGalleryFilterOptions = useMemo(
    () => [
      { id: 'all', label: 'Todas las categorías' },
      { id: 'display', label: 'Visualización' },
      { id: 'charts', label: 'Gráficos' },
      { id: 'controls', label: 'Controles' },
      { id: 'data', label: 'Datos y tablas' },
      { id: 'maps', label: 'Mapas y ubicación' },
      { id: 'special', label: 'Especiales' },
    ],
    []
  );

  const galleryFilteredMenuEntries = useMemo(() => {
    let list = addableWidgetMenuEntries;
    if (widgetGalleryCategory !== 'all') {
      list = list.filter((e) => e.category === widgetGalleryCategory);
    }
    const q = widgetGallerySearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((e) => {
      const lab = String(e.label || '').toLowerCase();
      const desc = String(e.description || '').toLowerCase();
      return lab.includes(q) || desc.includes(q);
    });
  }, [addableWidgetMenuEntries, widgetGallerySearch, widgetGalleryCategory]);

  useEffect(() => {
    if (!dashboardEditMode) closeWidgetGallery();
  }, [dashboardEditMode, closeWidgetGallery]);

  useEffect(() => {
    if (!widgetGalleryOpen) return undefined;
    const onKey = (ev) => {
      if (ev.key === 'Escape') closeWidgetGallery();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [widgetGalleryOpen, closeWidgetGallery]);

  const addDashboardWidgetCloneAndOpen = useCallback(
    (baseId) => {
      if (!canEditDashboard || !MULTI_INSTANCE_DASH_WIDGETS.has(baseId)) return;
      const newId = makeDashboardWidgetCloneId(baseId);
      const curVis = { ...visibilityMapRef.current, [baseId]: true };
      visibilityMapRef.current = curVis;
      setVisibilityMap(() => {
        saveDashboardVisibility(variant, curVis, dashDeviceId, variant === 'panel' ? panelInstanceId : undefined,
        variant === 'panel' ? panelOwnerSegment : undefined);
        return curVis;
      });
      const cur = normalizeLayoutForPersistence(gridLayoutLatestRef.current || []);
      const sameFamily = cur.filter((it) => dashboardWidgetBaseId(String(it.i)) === baseId);
      const srcSlot = sameFamily.length ? String(sameFamily[sameFamily.length - 1].i) : baseId;
      cloneWidgetConfigBetweenKeys(dk(srcSlot), dk(newId), baseId);
      const slot = normalizeNewWidgetSlotTemplate({ ...buildModerateBsdGridTemplateForWidget(newId), i: newId });
      const resolved = resolveBsdDashboardGridLayout(
        appendBsdGridWidgetAtFirstGap(cur, curVis, slot),
        curVis
      );
      gridLayoutLatestRef.current = resolved;
      setGridLayout(resolved);
      persistBsdGridLayoutDisk(resolved);
      setGridLayoutRepairEpoch((n) => n + 1);
      setWidgetConfigs(loadAllWidgetConfigs());
      scheduleBsdServerPersistRef.current?.();
      openWidgetEditModal({
        storageKey: dk(newId),
        sensor: buildDashboardWidgetSensor(newId),
        editScope: 'value',
      });
      queueMicrotask(() => {
        closeWidgetGallery();
      });
    },
    [
      variant,
      dashDeviceId,
      persistBsdGridLayoutDisk,
      canEditDashboard,
      closeWidgetGallery,
      dk,
      buildDashboardWidgetSensor,
      openWidgetEditModal,
      panelInstanceId,
      panelOwnerSegment,
    ]
  );

  const addDashboardWidgetAndOpenConfig = useCallback(
    (wid) => {
      if (!canEditDashboard) return;
      if (MULTI_INSTANCE_DASH_WIDGETS.has(wid)) {
        const slots = (gridLayoutLatestRef.current || [])
          .map((it) => String(it.i))
          .filter((id) => dashboardWidgetBaseId(id) === wid);
        if (slots.length > 0) {
          addDashboardWidgetCloneAndOpen(wid);
          return;
        }
      }
      addDashWidget(wid);
      setGridLayoutRepairEpoch((n) => n + 1);
      openWidgetEditModal({
        storageKey: dk(wid),
        sensor: buildDashboardWidgetSensor(wid),
        editScope: 'value',
      });
      queueMicrotask(() => {
        closeWidgetGallery();
      });
    },
    [addDashWidget, addDashboardWidgetCloneAndOpen, buildDashboardWidgetSensor, canEditDashboard, closeWidgetGallery, dk, openWidgetEditModal]
  );

  const onWidgetGalleryPick = useCallback(
    (entryId) => {
      if (!canEditDashboard) return;
      const isMulti = MULTI_INSTANCE_DASH_WIDGETS.has(entryId);
      const nSlots = (gridLayoutLatestRef.current || []).filter(
        (it) => dashboardWidgetBaseId(String(it.i)) === entryId
      ).length;
      if (isMulti && nSlots > 0) {
        addDashboardWidgetCloneAndOpen(entryId);
      } else {
        addDashboardWidgetAndOpenConfig(entryId);
      }
    },
    [canEditDashboard, addDashboardWidgetCloneAndOpen, addDashboardWidgetAndOpenConfig]
  );

  const dashboardToolbar = canEditDashboard ? (
    <div className="bsd-dashboard-toolbar">
      {!dashboardEditMode ? (
        <button type="button" className="bsd-btn-dashboard-edit" onClick={() => setDashboardEditMode(true)}>
          Editar
        </button>
      ) : (
        <>
          <button
            type="button"
            className="bsd-widget-menu-summary bsd-widget-gallery-trigger"
            onClick={() => setWidgetGalleryOpen(true)}
          >
            <LayoutGrid size={16} aria-hidden />
            Agregar widget
          </button>
          <button
            type="button"
            className="bsd-btn-dashboard-done"
            onClick={() => {
              flushSync(() => {
                persistDashboardGridLayoutNow(gridLayoutLatestRef.current);
              });
              if (bsdServerPushTimerRef.current != null) {
                clearTimeout(bsdServerPushTimerRef.current);
                bsdServerPushTimerRef.current = null;
              }
              void runBsdServerPushNowRef.current();
              setDashboardEditMode(false);
            }}
          >
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
      : 'SYSCOM-IOT';
  const subtitle =
    variant === 'device' && device
      ? `${device.model || 'IoT'} · ${device.sn || device.deviceId || ''}`
      : 'Monitoreo inteligente | Alertas en tiempo real | Análisis predictivo';

  return (
    <>
    <div
      className={`bsd-root ${embedded ? 'bsd-root--embedded' : ''} ${dashboardLayoutLocked ? 'bsd-dashboard-edit-off' : ''}`}
    >
      <div className="dashboard-container" ref={gridWidthMeasureRef}>
        {!(embedded && variant === 'device') && (
          <div className="dashboard-header">
            <div className="dashboard-header-top">
              <div className="title">
                <h1>{title}</h1>
                <p>{subtitle}</p>
              </div>
              {dashboardToolbar}
            </div>
            {variant === 'panel' && (
              <div className="bsd-panel-workspace-bar bsd-panel-workspace-bar--below-title">
                <div className="bsd-panel-workspace-tabs" role="tablist" aria-label="Paneles de control">
                  {panelWorkspace.panels.map((p) => {
                    const canRemove =
                      dashboardEditMode && panelWorkspace.panels.length > 1 && p.id !== 'main';
                    return (
                      <div key={p.id} className="bsd-panel-tab-with-actions">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={p.id === panelInstanceId}
                          className={`bsd-panel-tab ${p.id === panelInstanceId ? 'bsd-panel-tab--active' : ''}`}
                          onClick={() => selectPanelTab(p.id)}
                        >
                          {p.name}
                        </button>
                        {canRemove ? (
                          <button
                            type="button"
                            className="bsd-panel-tab-delete"
                            title={`Eliminar panel «${p.name}»`}
                            aria-label={`Eliminar panel ${p.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              requestPanelDelete(p.id);
                            }}
                          >
                            <X size={14} strokeWidth={2.25} aria-hidden />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div className="bsd-panel-workspace-actions">
                  <button type="button" className="bsd-panel-workspace-btn" onClick={addPanelTab}>
                    <Plus size={14} strokeWidth={2.25} aria-hidden /> Panel
                  </button>
                  <button
                    type="button"
                    className="bsd-panel-workspace-btn"
                    onClick={renameActivePanel}
                    title="Renombrar panel activo"
                  >
                    <Pencil size={14} aria-hidden /> Renombrar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {embedded && variant === 'device' && <div className="bsd-embedded-toolbar">{dashboardToolbar}</div>}

        <div
          className={
            variant === 'panel'
              ? `bsd-panel-widgets-canvas${
                  (gridLayout?.length ?? 0) <= 6 ? ' bsd-panel-widgets-canvas--compact' : ''
                }`
              : 'bsd-dashboard-inner-wrap'
          }
        >
        <div
          ref={innerRef}
          className={embedded && variant === 'device' ? 'bsd-embedded-main' : 'bsd-dashboard-inner'}
        >
        {(() => {
          const gridBody = flattenDashboardGridChildren(
            <>
        {variant === 'panel' && panelDevices.length > 0 && isVis(DASH_WIDGET.PANEL_DEVICE_BAR) && rglLayoutIdSet.has(DASH_WIDGET.PANEL_DEVICE_BAR) && (
          <div key={DASH_WIDGET.PANEL_DEVICE_BAR} {...mergeShell(DASH_WIDGET.PANEL_DEVICE_BAR, 'widget bsd-panel-device-bar bsd-widget-editable')}>
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
                  localStorage.setItem(
                    panelOwnerSegment ? panelControlDeviceStorageKey(panelOwnerSegment) : 'bsd_panel_control_device',
                    v
                  );
                }}
                aria-label="Dispositivo para switch y downlinks"
              >
                {panelDevices.map((d) => {
                  const label = d.name || d.sn || d.deviceId;
                  const deui = panelDeviceDeuiLabel(d);
                  return (
                    <option key={d.deviceId} value={String(d.deviceId)}>
                      {deui ? `${label} · ${deui}` : label}
                    </option>
                  );
                })}
              </select>
              <p className="bsd-control-hint" style={{ marginTop: 8 }}>
                El downlink se envía al <strong>DevEUI</strong> del dispositivo dado de alta (no al que aparezca solo en telemetría de otro ID). Compare con el último uplink en el historial.
              </p>
            </div>
          </div>
        )}

          {isVis(DASH_WIDGET.SWITCH) &&
            dashWidgetSlotIds(DASH_WIDGET.SWITCH).map((slotId) => (
              <div key={slotId} {...mergeGridSlotShell(slotId)}>
              <BsdSwitchWidgetSlot
                slotId={slotId}
                variant={variant}
                device={device}
                controlDeviceId={controlDeviceId}
                canSendLnsCommands={canSendLnsCommands}
                dk={dk}
                widgetConfigs={widgetConfigs}
                resolveWidgetBoundDeviceId={resolveWidgetBoundDeviceId}
                telemetryLivePropsForPanelWidget={telemetryLivePropsForPanelWidget}
                liveProps={liveProps}
                downlinkList={downlinkList}
                panelDevices={panelDevices}
                credentials={credentials}
                token={token}
                expandTelemetryLive={expandMergedDeviceTelemetryLive}
                wTitle={wTitle}
                wTitleStyle={wTitleStyle}
                mergeShell={mergeShell}
                dashWidgetChrome={dashWidgetChrome}
                openDashWidgetEdit={openDashWidgetEdit}
              />
              </div>
            ))}

          {isVis(DASH_WIDGET.DOWNLINK) &&
            dashWidgetSlotIds(DASH_WIDGET.DOWNLINK).map((slotId) => (
              <div key={slotId} {...mergeGridSlotShell(slotId)}>
              <BsdDownlinkWidgetSlot
                slotId={slotId}
                variant={variant}
                device={device}
                controlDeviceId={controlDeviceId}
                canSendLnsCommands={canSendLnsCommands}
                dk={dk}
                widgetConfigs={widgetConfigs}
                resolveWidgetBoundDeviceId={resolveWidgetBoundDeviceId}
                downlinkList={downlinkList}
                panelDevices={panelDevices}
                credentials={credentials}
                token={token}
                lastTelemetryAtLabel={lastTelemetryAtLabel}
                wTitle={wTitle}
                wTitleStyle={wTitleStyle}
                mergeShell={mergeShell}
                dashWidgetChrome={dashWidgetChrome}
                openDashWidgetEdit={openDashWidgetEdit}
              />
              </div>
            ))}

          {isVis(DASH_WIDGET.IMAGE) &&
            dashWidgetSlotIds(DASH_WIDGET.IMAGE).map((slotId) => {
              const imageUrl = imageUrlBySlot[slotId];
              return (
          <div key={slotId} {...mergeShell(slotId, 'widget bsd-control-widget bsd-widget-editable bsd-image-widget')}>
            {dashWidgetChrome(slotId, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(slotId, () => ({
                id: 0,
                name: 'Imagen',
                value: imageUrl ? 1 : 0,
                unit: '',
                icon: '🖼️',
                threshold: 1,
                propertyKey: `__bsd_${slotId}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(slotId)}>
                <ImageIcon size={18} className="bsd-lucide-glow" strokeWidth={2} /> {wTitle(slotId, 'Imagen')}
              </div>
            </div>
            <div className="bsd-image-widget-body">
              {imageUrl ? (
                <img src={imageUrl} alt="" className="bsd-preview-img" />
              ) : (
                <div className="bsd-image-placeholder">
                  <ImageIcon size={40} strokeWidth={1} />
                  <span>Configura la imagen en <strong>Básicos</strong> (archivo o URL) o publica una URL en telemetría.</span>
                </div>
              )}
            </div>
          </div>
              );
            })}

          {isVis(DASH_WIDGET.MAP) &&
            dashWidgetSlotIds(DASH_WIDGET.MAP).map((slotId) => {
              const mapCoords = mapCoordsBySlot[slotId];
              const mapBaseLayerId = mapBaseLayerBySlot[slotId];
              return (
          <div key={slotId} {...mergeShell(slotId, 'widget bsd-control-widget bsd-widget-editable bsd-map-widget')}>
            {dashWidgetChrome(slotId, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(slotId, () => ({
                id: 0,
                name: 'Mapa',
                value: mapCoords ? 1 : 0,
                unit: '',
                icon: '📍',
                threshold: 1,
                propertyKey: `__bsd_${slotId}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header">
              <div className="widget-title" style={wTitleStyle(slotId)}>
                <MapPin size={18} className="bsd-lucide-glow" strokeWidth={2} /> {wTitle(slotId, 'Mapa')}
              </div>
            </div>
            <div className="bsd-map-widget-body">
              {mapCoords ? (
                <>
                  <BsdMapLayerMenu value={mapBaseLayerId} onChange={(id) => applyMapBaseLayer(slotId, id)} />
                  <BsdLeafletStaticMap lat={mapCoords.lat} lng={mapCoords.lng} baseLayerId={mapBaseLayerId} className="bsd-map-leaflet" />
                </>
              ) : (
                <div className="bsd-map-placeholder">
                  <MapPin size={40} strokeWidth={1} />
                  <span>Indica latitud y longitud en <strong>Básicos</strong> o envía <code>latitude</code> / <code>longitude</code> en telemetría.</span>
                </div>
              )}
            </div>
          </div>
              );
            })}

          {isVis(DASH_WIDGET.TRACKING_MAP) &&
            dashWidgetSlotIds(DASH_WIDGET.TRACKING_MAP).map((slotId) => {
              const trackingMapBaseLayerId = trackingMapBaseLayerBySlot[slotId];
              return (
          <div key={slotId} {...mergeShell(slotId, 'widget bsd-widget-editable bsd-tracking-map-widget')}>
            {dashWidgetChrome(slotId, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(slotId, () => ({
                id: 0,
                name: 'Mapa de rastreo',
                value: trackingPathPoints.length,
                unit: '',
                icon: '🛰️',
                threshold: 1000,
                propertyKey: `__bsd_${slotId}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header bsd-tracking-map-widget__header">
              <div className="widget-title" style={wTitleStyle(slotId)}>
                <Route size={18} className="bsd-lucide-glow" strokeWidth={2} /> {wTitle(slotId, 'Mapa de rastreo')}
              </div>
              <div className="bsd-tracking-map-presets" role="group" aria-label="Periodo del historial GPS">
                {[{ id: 'day', lab: 'Día' }, { id: 'week', lab: 'Semana' }, { id: 'month', lab: 'Mes' }].map(({ id, lab }) => (
                  <button key={id} type="button" className={`bsd-bar-chart-preset${(widgetConfigs[dk(slotId)]?.data?.trackingTimeRange || 'day') === id ? ' active' : ''}`} onClick={() => applyTrackingTimeRange(slotId, id)}>{lab}</button>
                ))}
              </div>
            </div>
            <div className="bsd-tracking-map-status" style={wTitleStyle(slotId)}>
              {trackingLoading ? 'Cargando trayectoria…' : [trackingError || (trackingPathPoints.length ? `${trackingPathPoints.length} puntos` : ''), lastTelemetryAtLabel].filter(Boolean).join(' · ')}
            </div>
            <div className="bsd-tracking-map-body">
              <BsdMapLayerMenu value={trackingMapBaseLayerId} onChange={(id) => applyMapBaseLayer(slotId, id)} />
              <BsdLeafletTrackingMap latLngs={trackingPathPoints} className="bsd-tracking-map-leaflet" baseLayerId={trackingMapBaseLayerId} />
            </div>
          </div>
              );
            })}

          {isVis(DASH_WIDGET.SATISFACTION) &&
            dashWidgetSlotIds(DASH_WIDGET.SATISFACTION).map((slotId) => {
              const satisfactionUi = satisfactionUiBySlot[slotId];
              const slotGradId = `${gradId}-${String(slotId).replace(/[^a-zA-Z0-9_-]/g, '')}`;
              const lo = satisfactionUi?.scaleMin ?? 0;
              const hi = satisfactionUi?.scaleMax ?? 100;
              const cfg = widgetConfigs[dk(slotId)];
              const val = resolveGaugeColorLookupValue(cfg, satisfactionUi);
              const satisfactionArcStroke = colorForValueInRanges(val, satisfactionUi?.ranges || [], lo, hi) || `url(#bsd-circ-grad-${slotGradId})`;
              const satisfactionArcDashOffset = BSD_CIRCULAR_GAUGE_LEN - ((satisfactionUi?.ringPct ?? 0) / 100) * BSD_CIRCULAR_GAUGE_LEN;
              return (
          <div key={slotId} {...mergeShell(slotId, 'widget bsd-widget-editable bsd-circular-widget')}>
            {dashWidgetChrome(slotId, (e) => { e.stopPropagation(); openDashWidgetEdit(slotId, () => ({ id: 0, name: 'Circular', value: satisfactionUi?.rawValue != null ? satisfactionUi.rawValue : satisfactionUi?.ringPct ?? 0, unit: '%', icon: '◎', threshold: 100, propertyKey: `__bsd_${slotId}`, sourceDeviceId: 'dashboard' })); })}
            <div className="widget-header bsd-value-date-filter-header"><div className="widget-title" style={wTitleStyle(slotId)}><span>◎</span> {wTitle(slotId, 'Circular')}</div>{valueDateFilterBar(slotId)}</div>
            <div className="bsd-circular-gauge">
              <svg className="bsd-circular-gauge__svg" viewBox="0 0 200 200" width="100%" height="100%" aria-hidden>
                <defs><linearGradient id={`bsd-circ-grad-${slotGradId}`} x1="28%" y1="12%" x2="72%" y2="92%"><stop offset="0%" stopColor="#ff9a8b" /><stop offset="45%" stopColor="#ff7b7a" /><stop offset="100%" stopColor="#ff5569" /></linearGradient></defs>
                <circle className="bsd-circular-gauge__track" cx="100" cy="100" r={BSD_CIRCULAR_GAUGE_R} fill="none" stroke="#e4e4ec" strokeWidth={BSD_CIRCULAR_GAUGE_STROKE} />
                <circle className="bsd-circular-gauge__arc" cx="100" cy="100" r={BSD_CIRCULAR_GAUGE_R} fill="none" stroke={satisfactionArcStroke} strokeWidth={BSD_CIRCULAR_GAUGE_STROKE} strokeLinecap="round" strokeDasharray={BSD_CIRCULAR_GAUGE_LEN} strokeDashoffset={satisfactionArcDashOffset} />
              </svg>
              <div className="bsd-circular-gauge__hub"><span className="bsd-circular-gauge__value">{satisfactionUi?.centerLabel ?? '—'}</span></div>
            </div>
            {satisfactionUi?.lastAtLine ? <div className="bsd-circular-gauge__foot-at" style={wTitleStyle(slotId)}>{satisfactionUi.lastAtLine}</div> : null}
          </div>
              );
            })}

          {isVis(DASH_WIDGET.CONTAINER) &&
            dashWidgetSlotIds(DASH_WIDGET.CONTAINER).map((slotId) => {
              const containerUi = containerUiBySlot[slotId];
              const lo = containerUi?.scaleMin ?? 0; const hi = containerUi?.scaleMax ?? 100;
              const cfg = widgetConfigs[dk(slotId)];
              const val = resolveGaugeColorLookupValue(cfg, containerUi);
              const containerLiquidColor = colorForValueInRanges(val, containerUi?.ranges || [], lo, hi) || '#22c55e';
              return (
          <div key={slotId} {...mergeShell(slotId, 'widget bsd-widget-editable')}>
            {dashWidgetChrome(slotId, (e) => { e.stopPropagation(); openDashWidgetEdit(slotId, () => ({ id: 0, name: 'Contenedor', value: containerUi?.rawValue != null ? containerUi.rawValue : containerUi?.ringPct ?? 0, unit: '%', icon: '🛢', threshold: 100, propertyKey: `__bsd_${slotId}`, sourceDeviceId: 'dashboard' })); })}
            <div className="widget-header bsd-value-date-filter-header"><div className="widget-title" style={wTitleStyle(slotId)}><span aria-hidden>🛢</span> {wTitle(slotId, 'Contenedor')}</div>{valueDateFilterBar(slotId)}</div>
            <BsdContainerTankView fillPct={containerUi?.ringPct ?? 0} fillColor={containerLiquidColor} centerLabel={containerUi?.centerLabel ?? '—'} lastAtLine={containerUi?.lastAtLine} titleColor={wTitleStyle(slotId)?.color} />
          </div>
              );
            })}

          {isVis(DASH_WIDGET.BATTERY_LEVEL) &&
            dashWidgetSlotIds(DASH_WIDGET.BATTERY_LEVEL).map((slotId) => {
              const batteryLevelUi = batteryLevelUiBySlot[slotId];
              const lo = batteryLevelUi?.scaleMin ?? 0; const hi = batteryLevelUi?.scaleMax ?? 100;
              const cfg = widgetConfigs[dk(slotId)];
              const val = resolveGaugeColorLookupValue(cfg, batteryLevelUi);
              const batteryFillColor = colorForValueInRanges(val, batteryLevelUi?.ranges || [], lo, hi) || '#f97316';
              return (
          <div key={slotId} {...mergeShell(slotId, 'widget bsd-widget-editable')}>
            {dashWidgetChrome(slotId, (e) => { e.stopPropagation(); openDashWidgetEdit(slotId, () => ({ id: 0, name: 'Nivel Batería', value: batteryLevelUi?.rawValue != null ? batteryLevelUi.rawValue : batteryLevelUi?.ringPct ?? 0, unit: '%', icon: '🔋', threshold: 100, propertyKey: `__bsd_${slotId}`, sourceDeviceId: 'dashboard' })); })}
            <div className="widget-header"><div className="widget-title" style={wTitleStyle(slotId)}><span aria-hidden>🔋</span> {wTitle(slotId, 'Nivel Batería')}</div></div>
            <BsdBatteryLevelView fillPct={batteryLevelUi?.ringPct ?? 0} fillColor={batteryFillColor} centerLabel={batteryLevelUi?.centerLabel ?? '—'} lastAtLine={batteryLevelUi?.lastAtLine} titleColor={wTitleStyle(slotId)?.color} />
          </div>
              );
            })}

          {isVis(DASH_WIDGET.METRIC_CIRCULAR) &&
            metricCircularDashSlotIds.map((slotId) => {
              const ui = metricCircularUiBySlot[slotId];
              const mcTicks = buildMetricCircularTicksFromUi(ui);
              const gid = `${metricCircularDomId}-${String(slotId).replace(/[^a-zA-Z0-9_-]/g, '')}`;
              const mcRanges = Array.isArray(ui?.ranges) ? ui.ranges : [];
              const mcUseRangeColors = mcRanges.length > 0;
              const mcT = ui?.needleT != null ? ui.needleT : 0;
              const mcHasLive = ui?.rawValue != null && Number.isFinite(ui.rawValue);
              const mcRangeStroke =
                mcUseRangeColors && mcHasLive
                  ? colorForValueInRanges(ui.rawValue, mcRanges, ui.scaleLo, ui.scaleHi) || '#a5b4fc'
                  : null;
              const mcArcStroke = mcUseRangeColors
                ? mcRangeStroke || 'rgba(255,255,255,0.22)'
                : ui?.gradientMode === 'thermal'
                  ? `url(#bsd-mc-thermal-${gid})`
                  : `url(#bsd-mc-traffic-${gid})`;
              /** Siempre recortar el arco con dasharray: sin esto, en modo degradado se dibuja el 100% del trazo. */
              const arcProgressT = mcHasLive ? Math.min(1, Math.max(0, mcT)) : 0;
              const mcArcDash = MC_ARC_GEOM_LEN;
              const mcArcDashOff = MC_ARC_GEOM_LEN * (1 - arcProgressT);
              const mcArcFilterStyle = mcUseRangeColors
                ? { filter: 'drop-shadow(0 2px 10px rgba(15,23,42,0.28))' }
                : undefined;
              const mcNeedleFill = mcUseRangeColors && mcRangeStroke ? mcRangeStroke : undefined;
              return (
                <div key={slotId} {...mergeShell(slotId, 'widget widget--metric-circular bsd-widget-editable')}>
                  {dashWidgetChrome(slotId, (e) => {
                    e.stopPropagation();
                    openDashWidgetEdit(slotId, () => ({
                      id: 0,
                      name: 'Métrica circular',
                      value: ui?.rawValue != null ? ui.rawValue : 0,
                      unit: ui?.unitDisplay ?? '',
                      icon: '◔',
                      threshold: ui?.scaleHi ?? 100,
                      propertyKey: `__bsd_${slotId}`,
                      sourceDeviceId: 'dashboard',
                    }));
                  })}
                  <div className="widget-header bsd-value-date-filter-header">
                    <div className="widget-title" style={wTitleStyle(slotId)}>
                      <span aria-hidden>◔</span> {wTitle(slotId, 'Métrica circular')}
                    </div>
                    {valueDateFilterBar(slotId)}
                  </div>
                  <div className="bsd-metric-circular">
                    <div className="bsd-metric-circular__chart">
                    <svg
                      className="bsd-metric-circular__svg"
                      viewBox="0 0 240 152"
                      preserveAspectRatio="xMidYMid meet"
                      width="100%"
                      height="100%"
                      aria-hidden
                    >
                      {!mcUseRangeColors ? (
                        <defs>
                          <linearGradient
                            id={`bsd-mc-traffic-${gid}`}
                            x1="4%"
                            y1="92%"
                            x2="96%"
                            y2="8%"
                            gradientUnits="userSpaceOnUse"
                          >
                            <stop offset="0%" stopColor="#ff4d2d" />
                            <stop offset="28%" stopColor="#ff9f1c" />
                            <stop offset="52%" stopColor="#ffd60a" />
                            <stop offset="78%" stopColor="#84cc16" />
                            <stop offset="100%" stopColor="#16a34a" />
                          </linearGradient>
                          <linearGradient
                            id={`bsd-mc-thermal-${gid}`}
                            x1="8%"
                            y1="88%"
                            x2="92%"
                            y2="12%"
                            gradientUnits="userSpaceOnUse"
                          >
                            <stop offset="0%" stopColor="#1d4ed8" />
                            <stop offset="30%" stopColor="#22d3ee" />
                            <stop offset="55%" stopColor="#facc15" />
                            <stop offset="82%" stopColor="#fb923c" />
                            <stop offset="100%" stopColor="#dc2626" />
                          </linearGradient>
                        </defs>
                      ) : null}
                      <path
                        className="bsd-metric-circular__track"
                        d={MC_ARC_PATH_D}
                        fill="none"
                        strokeWidth={17}
                        strokeLinecap="round"
                      />
                      <path
                        className="bsd-metric-circular__arc"
                        d={MC_ARC_PATH_D}
                        fill="none"
                        strokeWidth={17}
                        strokeLinecap="round"
                        stroke={mcArcStroke}
                        strokeDasharray={mcArcDash}
                        strokeDashoffset={mcArcDashOff}
                        style={mcArcFilterStyle}
                      />
                      {mcTicks.map((tk) => {
                        const inner = mcPoint(MC_CX, MC_CY, MC_R + 10, tk.theta);
                        const outer = mcPoint(MC_CX, MC_CY, MC_R + 20, tk.theta);
                        const lab = mcPoint(MC_CX, MC_CY, MC_R + 34, tk.theta);
                        return (
                          <g key={tk.f}>
                            <line
                              className="bsd-metric-circular__tick"
                              x1={inner.x}
                              y1={inner.y}
                              x2={outer.x}
                              y2={outer.y}
                            />
                            <text
                              className="bsd-metric-circular__tick-label"
                              x={lab.x}
                              y={lab.y}
                              dominantBaseline="middle"
                              textAnchor="middle"
                            >
                              {tk.label}
                            </text>
                          </g>
                        );
                      })}
                      {(() => {
                        const t = ui?.needleT != null ? ui.needleT : 0;
                        const th = MC_ARC_START + t * MC_ARC_SWEEP;
                        const deg = (th * 180) / Math.PI;
                        const fade = ui?.needleT != null ? 1 : 0.38;
                        return (
                          <g
                            className="bsd-metric-circular__needle"
                            style={{ opacity: fade }}
                            transform={`translate(${MC_CX},${MC_CY}) rotate(${deg})`}
                          >
                            <polygon
                              points="58,-5 78,0 58,5"
                              className="bsd-metric-circular__needle-shape"
                              fill={mcNeedleFill}
                            />
                          </g>
                        );
                      })()}
                      <text
                        className="bsd-metric-circular__center-val"
                        x={MC_CX}
                        y={MC_CY - 4}
                        textAnchor="middle"
                      >
                        {ui?.centerMain}
                      </text>
                      {ui?.svgSubtitleLine ? (
                        <text
                          className="bsd-metric-circular__center-sub"
                          x={MC_CX}
                          y={MC_CY + 16}
                          textAnchor="middle"
                        >
                          {ui.svgSubtitleLine}
                        </text>
                      ) : null}
                    </svg>
                    </div>
                  {ui?.lastAtLine ? (
                    <div className="bsd-metric-circular__lastat" style={wTitleStyle(slotId)}>
                      {ui.lastAtLine}
                    </div>
                  ) : null}
                  </div>
                </div>
              );
            })}

          {isVis(DASH_WIDGET.TEXT) &&
            textDashSlotIds.map((slotId) => {
              const tw = textWidgetUiBySlot[slotId];
              return (
                <div key={slotId} {...mergeShell(slotId, 'widget bsd-widget-editable bsd-text-widget')}>
                  {dashWidgetChrome(slotId, (e) => {
                    e.stopPropagation();
                    openDashWidgetEdit(slotId, () => ({
                      id: 0,
                      name: 'Texto',
                      value: 0,
                      unit: widgetConfigs[dk(slotId)]?.data?.unit
                        ? String(widgetConfigs[dk(slotId)].data.unit)
                        : '',
                      icon: '📝',
                      threshold: 1,
                      propertyKey: `__bsd_${slotId}`,
                      sourceDeviceId: 'dashboard',
                    }));
                  })}
                  <div className="widget-header bsd-text-widget__header bsd-value-date-filter-header">
                    <div className="widget-title bsd-text-widget__title" style={wTitleStyle(slotId)}>
                      <BsdTextWidgetSignalIcon className="bsd-text-widget__title-icon" />
                      {wTitle(slotId, 'Texto')}
                    </div>
                    {valueDateFilterBar(slotId)}
                  </div>
                  <div className="bsd-text-widget__body">
                    <div className="bsd-text-widget__value">{tw?.display}</div>
                    {tw?.hint && tw.display !== tw.hint ? (
                      <div className="bsd-text-widget__hint">{tw.hint}</div>
                    ) : null}
                  </div>
                  {tw?.lastAtLine ? (
                    <div className="bsd-text-widget__footer" style={wTitleStyle(slotId)}>
                      {tw.lastAtLine}
                    </div>
                  ) : null}
                </div>
              );
            })}

          {isVis(DASH_WIDGET.VEleta) &&
            veletaDashSlotIds.map((slotId) => {
              const vu = veletaWidgetUiBySlot[slotId];
              return (
                <div key={slotId} {...mergeShell(slotId, 'widget bsd-widget-editable bsd-veleta-widget')}>
                  {dashWidgetChrome(slotId, (e) => {
                    e.stopPropagation();
                    openDashWidgetEdit(slotId, () => ({
                      id: 0,
                      name: 'Veleta',
                      value: vu?.degrees != null ? vu.degrees : 0,
                      unit: '°',
                      icon: '🧭',
                      threshold: 360,
                      propertyKey: `__bsd_${slotId}`,
                      sourceDeviceId: 'dashboard',
                    }));
                  })}
                  <div className="widget-header bsd-veleta-widget__header">
                    <div className="widget-title bsd-veleta-widget__title" style={wTitleStyle(slotId)}>
                      <Compass size={18} className="bsd-lucide-glow" strokeWidth={2} aria-hidden />
                      {wTitle(slotId, 'Veleta')}
                    </div>
                  </div>
                  <div className="bsd-veleta-widget__body">
                    <BsdWindVaneWidget degrees={vu?.degrees ?? null} />
                    <div className="bsd-veleta-widget__readout">
                      <span className="bsd-veleta-widget__deg">{vu?.displayDeg ?? '—'}</span>
                      <span className="bsd-veleta-widget__cardinal">{vu?.cardinal ?? ''}</span>
                    </div>
                  </div>
                  {vu?.lastAtLine ? (
                    <div className="bsd-veleta-widget__footer" style={wTitleStyle(slotId)}>
                      {vu.lastAtLine}
                    </div>
                  ) : null}
                </div>
              );
            })}

          {isVis(DASH_WIDGET.BAR_CHART) &&
            dashWidgetSlotIds(DASH_WIDGET.BAR_CHART).map((slotId) => (
          <div key={slotId} {...mergeShell(slotId, 'widget bsd-widget-editable bsd-bar-chart-widget')}>
            {dashWidgetChrome(slotId, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(slotId, () => ({
                id: 0,
                name: 'Grafico Barras',
                value: 0,
                unit: '',
                icon: '📊',
                threshold: 100,
                propertyKey: `__bsd_${slotId}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header bsd-bar-chart-widget__header">
              <div className="widget-title" style={wTitleStyle(slotId)}>
                <span aria-hidden>📊</span> {wTitle(slotId, 'Grafico Barras')}
              </div>
              <div className="bsd-bar-chart-presets" role="group" aria-label="Agrupación del historial">
                {(() => {
                  const raw = normalizeBarChartGranularity(widgetConfigs[dk(slotId)]?.timeframe?.granularity);
                  const activeGran = BAR_CHART_WIDGET_GRANULARITY_OPTIONS.some((o) => o.value === raw) ? raw : 'hour';
                  return BAR_CHART_WIDGET_GRANULARITY_OPTIONS.map(({ value, label }) => (
                    <button key={value} type="button" className={`bsd-bar-chart-preset${activeGran === value ? ' active' : ''}`} onClick={() => applyBarChartGranularity(slotId, value)}>{label}</button>
                  ));
                })()}
              </div>
            </div>
            <div className="bsd-bar-chart-status" style={wTitleStyle(slotId)}>
              {barChartLoading ? 'Cargando historial…' : [barChartError, barChartHint, lastTelemetryAtLabel].filter(Boolean).join(' · ') || ''}
            </div>
            <div className="bsd-bar-chart-canvas-wrap">
              {slotId === dashWidgetSlotIds(DASH_WIDGET.BAR_CHART)[0] ? (
                <canvas ref={barChartCanvasRef} className="bsd-bar-chart-canvas" />
              ) : (
                <div className="bsd-control-hint">Gráfico activo en la primera instancia del tablero.</div>
              )}
            </div>
          </div>
            ))}

        {isVis(DASH_WIDGET.SENSOR_GRID) && rglLayoutIdSet.has(DASH_WIDGET.SENSOR_GRID) && (
        <div key={DASH_WIDGET.SENSOR_GRID} {...mergeShell(DASH_WIDGET.SENSOR_GRID, 'widget bsd-sensor-grid-shell bsd-widget-editable')}>
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
            const fieldForDisplay = cfg?.data?.fieldKey || sensor.propertyKey;
            const effDeviceId = variant === 'device' ? dashDeviceId : controlDeviceId;
            const telForRow =
              variant === 'panel' && sensor.sourceDeviceId && sensor.sourceDeviceId !== 'demo'
                ? effDeviceId != null && String(sensor.sourceDeviceId) === String(effDeviceId)
                  ? telemetryLiveProps
                  : panelTelemetryExpandedByDeviceId[String(sensor.sourceDeviceId)]
                : telemetryLiveProps;
            const rawForLabel =
              sensor.sourceDeviceId &&
              sensor.sourceDeviceId !== 'demo' &&
              telForRow &&
              typeof telForRow === 'object'
                ? resolveTelemetryDisplaySource(telForRow, fieldForDisplay)
                : undefined;
            const rowModel = resolveTelemetryRowModel(sensor.sourceDeviceId);
            const rowHints = telemetryHintsForSensor(sensor.sourceDeviceId);
            const valueLabel =
              rawForLabel !== undefined && rawForLabel !== null
                ? tryTelemetryDisplayLabel(rowModel, fieldForDisplay, rawForLabel, rowHints)
                : tryTelemetryDisplayLabel(rowModel, fieldForDisplay, displayVal, rowHints);
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
            const subtitleBase = isValueDateFilterActive(cfg)
              ? formatValueDateFilterLabel(cfg)
              : cfg?.timeframe?.mode === 'interval'
                ? gran
                  ? `Historial (${gran})`
                  : 'Intervalo'
                : 'En vivo';
            const rowLastLine = formatLastTelemetryUpdateLine(telForRow?.lastUpdateTime);
            const subtitle =
              String(sensor.sourceDeviceId) === String(effDeviceId) && lastTelemetryAtLabel
                ? `${subtitleBase} · ${lastTelemetryAtLabel}`
                : rowLastLine
                  ? `${subtitleBase} · ${rowLastLine}`
                  : subtitleBase;
            const statusLabel =
              status === 'normal' ? '✓ NORMAL' : status === 'warning' ? '⚠ ALERTA' : '🔴 CRÍTICO';
            const rangeAccent = colorForValueInRanges(
              displayVal,
              cfg?.gauge?.ranges || [],
              Number(cfg?.gauge?.scaleMin) || 0,
              Number(cfg?.gauge?.scaleMax) || 50
            );
            const scalarForRule =
              rawForLabel !== undefined && rawForLabel !== null ? rawForLabel : displayVal;
            const primaryForCond =
              valueLabel != null && String(valueLabel).trim()
                ? String(valueLabel).trim()
                : scalarForRule;
            const altForCond =
              primaryForCond !== scalarForRule &&
              scalarForRule !== undefined &&
              scalarForRule !== null
                ? scalarForRule
                : undefined;
            const effCardAppearance = appearanceWithConditionalBackground(
              cfg?.appearance,
              primaryForCond,
              altForCond
            );
            const cardSurface = buildBsdWidgetSurfaceStyle(effCardAppearance);
            const cardClear = isWidgetBackgroundTransparent(effCardAppearance);
            return (
              <div
                key={sensor.id}
                role={canEditDashboard ? 'button' : undefined}
                tabIndex={canEditDashboard ? 0 : undefined}
                className={['sensor-card', cardClear ? 'bsd-widget-surface--clear' : ''].filter(Boolean).join(' ')}
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
                  ...(cardSurface || {}),
                  ...(rangeAccent
                    ? { borderColor: `${rangeAccent}aa`, boxShadow: `0 0 26px ${rangeAccent}40` }
                    : {}),
                }}
              >
                {canEditDashboard && (
                  <div className="sensor-card__actions">
                    <button
                      type="button"
                      className="sensor-card__duplicate"
                      onClick={(e) => {
                        e.stopPropagation();
                        duplicateSensorCardAsTextWidget(sensor);
                      }}
                      aria-label="Duplicar como widget Texto"
                      title="Duplicar como widget Texto"
                    >
                      <Copy size={16} />
                    </button>
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
                      inverseFill={Boolean(cfg?.gauge?.inverseFill)}
                      title={cardTitle}
                      titleColor={titleColor}
                      subtitle={subtitle}
                      compact
                      theme="dark"
                      valueLabel={valueLabel || undefined}
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
                      {valueLabel ||
                        (typeof displayVal === 'number' && !Number.isInteger(displayVal)
                          ? displayVal.toFixed(decimals)
                          : displayVal)}
                      {valueLabel ? null : <span className="sensor-unit">{unit}</span>}
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

          {isVis(DASH_WIDGET.STREAM) &&
            dashWidgetSlotIds(DASH_WIDGET.STREAM).map((slotId) => (
          <div key={slotId} {...mergeShell(slotId, 'widget bsd-widget-editable bsd-stream-widget-wrap')}>
            {dashWidgetChrome(slotId, (e) => {
              e.stopPropagation();
              openDashWidgetEdit(slotId, () => ({
                id: 0,
                name: 'Grafico Lineal',
                value: streamDisplay,
                unit: streamUnit,
                icon: '📡',
                threshold: 100,
                propertyKey: `__bsd_${slotId}`,
                sourceDeviceId: 'dashboard',
              }));
            })}
            <div className="widget-header bsd-stream-widget-header">
              <div className="bsd-stream-widget-head-main">
                <div className="widget-title" style={wTitleStyle(slotId)}>
                  <span>📡</span> {wTitle(slotId, 'Grafico Lineal')}
                </div>
                <div className="bsd-stream-status" style={wTitleStyle(slotId)}>
                  {streamTimePreset === 'live' ? (
                    <>
                      <span className="live-badge" aria-hidden />
                      <span>En vivo{lastTelemetryAtLabel ? ` · ${lastTelemetryAtLabel}` : ''}</span>
                    </>
                  ) : streamHistoryLoading ? (
                    <span>Cargando historial…</span>
                  ) : (
                    <span>{[streamHistoryError, streamHistoryFetchedAt ? `Actualizado ${new Date(streamHistoryFetchedAt).toLocaleTimeString()}` : streamHistoryError ? null : 'Historial', lastTelemetryAtLabel].filter(Boolean).join(' · ')}</span>
                  )}
                </div>
              </div>
              <div className="bsd-stream-presets" role="group" aria-label="Rango temporal del gráfico">
                {STREAM_TIME_PRESETS.map((p) => (
                  <button key={p.id} type="button" className={`bsd-stream-preset${streamTimePreset === p.id ? ' active' : ''}`} onClick={() => applyStreamTimePreset(slotId, p.id)}>{p.label}</button>
                ))}
              </div>
            </div>
            <div className={`streaming-container${streamSeriesNormalized.length > 1 ? ' streaming-container--multi' : ''}`}>
              {slotId === dashWidgetSlotIds(DASH_WIDGET.STREAM)[0] ? (
                <div className="bsd-stream-chart-canvas-wrap" ref={streamChartWrapRef}>
                  <canvas ref={streamingRef} className="bsd-stream-chart-canvas" />
                </div>
              ) : (
                <div className="bsd-control-hint">Gráfico activo en la primera instancia del tablero.</div>
              )}
            </div>
          </div>
            ))}

            </>
          );
          /**
           * Siempre `GridLayout`: alternar con `BsdStaticDashboardGrid` al pulsar «Listo» desmontaba hijos
           * (otro tipo de raíz + key distinta) → canvas del gráfico lineal nuevo, Chart.js destruido y el fetch
           * de historial no se repetía → gráfico vacío en modo lectura.
           */
          return (
            /**
             * Sin firma de layout en `key`: remontar RGL en cada drag/persist destruía el gesto
             * (widgets a 1 celda, lag) y al pulsar «Listo» recompactaba el tablero.
             */
            <GridLayout
              key={`bsd-dash-${dashboardGridLayoutKey}-r${gridLayoutRepairEpoch}`}
              className={`bsd-dash-grid-layout${gridLayoutInteracting ? ' bsd-dash-grid-layout--dragging' : ''}${dashStackWidgets ? ' bsd-dash-grid-layout--stacked' : ''}`}
              width={gridWidth}
              layout={gridLayoutForViewport}
              cols={12}
              rowHeight={36}
              margin={dashStackWidgets ? [10, 12] : [18, 18]}
              containerPadding={[0, 0]}
              onLayoutChange={handleGridLayoutChange}
              onDragStart={handleGridDragStart}
              onDragStop={handleGridDragStop}
              onResizeStart={handleGridResizeStart}
              onResizeStop={handleGridResizeStop}
              isDraggable={!dashboardLayoutLocked && !dashStackWidgets}
              isResizable={!dashboardLayoutLocked && !dashStackWidgets}
              draggableCancel=".bsd-widget-actions,.bsd-widget-duplicate-btn,.bsd-widget-edit-btn,.bsd-widget-remove-btn,.sensor-card__duplicate,.bsd-widget-menu-summary,.bsd-widget-menu-panel,.bsd-widget-gallery-overlay,.bsd-widget-gallery-modal,.bsd-widget-gallery-card,.bsd-widget-gallery-filters,.bsd-widget-gallery-search,input,textarea,select,option,button,.bsd-switch-3d,.bsd-downlink-btn,.bsd-emergency-body,.sensor-card,.alert-item,.year-btn,.bsd-stream-preset,canvas,.bsd-map-iframe,.leaflet-container,.leaflet-pane,.bsd-map-leaflet,.bsd-tracking-map-leaflet,.bsd-map-layer-menu,.bsd-map-layer-menu__trigger,.bsd-map-layer-menu__list,.bsd-map-layer-menu__opt,.bsd-panel-device-bar-inner label,.bsd-file-label"
              compactType={null}
              preventCollision
              allowOverlap={false}
              useCSSTransforms
            >
              {gridBody}
            </GridLayout>
          );
        })()}

        {variant === 'device' && typeof onRefresh === 'function' && (
          <div className="bsd-footer-refresh">
            <button type="button" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
              {refreshing ? t('common.loading') : t('common.refresh')}
            </button>
          </div>
        )}
        </div>
        </div>

        <WidgetEditModal
          key={widgetEditSession}
          open={Boolean(editModalCtx)}
          sensor={editModalCtx?.sensor ?? null}
          initialConfig={editModalCtx ? widgetConfigs[editModalCtx.storageKey] ?? null : null}
          editScope={editModalCtx?.editScope ?? 'value'}
          liveProps={telemetryLiveProps}
          liveDeviceModel={liveDeviceModel}
          telemetryHintMap={telemetryHintMap}
          availableDataFields={availableDataFields}
          availableDownlinks={downlinkList}
          bsdDashboardVariant={variant}
          panelDeviceSelectOptions={variant === 'panel' ? panelDeviceSelectOptions : null}
          panelFallbackDeviceId={controlDeviceId}
          getPanelTelemetryExpanded={variant === 'panel' ? getPanelTelemetryExpandedForModal : undefined}
          getPanelLiveDeviceModel={variant === 'panel' ? getPanelLiveDeviceModelForModal : undefined}
          getPanelTelemetryHints={variant === 'panel' ? getPanelTelemetryHintsForModal : undefined}
          getPanelDownlinks={variant === 'panel' ? getPanelDownlinksForModal : undefined}
          onPanelPreviewDeviceIdChange={variant === 'panel' ? setPanelModalPreviewDeviceId : undefined}
          panelPreviewExtraDataKeys={variant === 'panel' ? panelPreviewExtraDataKeysForModal : []}
          onSave={(cfg, meta) => {
            if (!editModalCtx) return;
            const oldKey = editModalCtx.storageKey;
            const key = meta?.dashboardTargetKey ?? oldKey;
            const saveWid = dashboardWidgetIdFromStorageKey(key);
            const cfgToSave =
              saveWid === DASH_WIDGET.STREAM
                ? {
                    ...cfg,
                    data: {
                      ...(cfg.data != null && typeof cfg.data === 'object' ? cfg.data : {}),
                      historyRangePreset: streamTimePresetRef.current,
                    },
                  }
                : cfg;
            saveWidgetConfig(key, cfgToSave);
            scheduleBsdServerPersistRef.current?.();

            if (meta?.dashboardTargetKey && meta.dashboardTargetKey !== oldKey) {
              const oldWid = dashboardWidgetIdFromStorageKey(oldKey);
              const newWid = dashboardWidgetIdFromStorageKey(meta.dashboardTargetKey);
              if (oldWid && newWid && oldWid !== newWid) {
                const visNext = { ...visibilityMapRef.current, [oldWid]: false, [newWid]: true };
                // `flushDashboardGridLayoutToStorage` corre en el mismo tick; la ref aún no refleja el setState.
                visibilityMapRef.current = visNext;
                setVisibilityMap(() => {
                  saveDashboardVisibility(variant, visNext, dashDeviceId, variant === 'panel' ? panelInstanceId : undefined,
        variant === 'panel' ? panelOwnerSegment : undefined);
                  return visNext;
                });
                const layout = normalizeLayoutForPersistence([...(gridLayoutLatestRef.current || [])]);
                const idx = layout.findIndex((it) => String(it.i) === String(oldWid));
                let normalized;
                if (idx >= 0) {
                  layout[idx] = { ...layout[idx], i: newWid };
                  normalized = resolveBsdDashboardGridLayout(
                    clampLayoutItemsToModerateMins(layout),
                    visNext
                  );
                } else {
                  normalized = appendBsdGridWidgetAtFirstGap(
                    layout,
                    visNext,
                    buildModerateBsdGridTemplateForWidget(newWid)
                  );
                }
                gridLayoutLatestRef.current = normalized;
                setGridLayout(normalized);
                persistBsdGridLayoutDisk(normalized);
              }
            }

            const shownWid = dashboardWidgetIdFromStorageKey(key);
            if (shownWid && isDashboardMultiLayoutSlotId(shownWid)) {
              const visShown = { ...visibilityMapRef.current, [shownWid]: true };
              visibilityMapRef.current = visShown;
              saveDashboardVisibility(variant, visShown, dashDeviceId, variant === 'panel' ? panelInstanceId : undefined,
        variant === 'panel' ? panelOwnerSegment : undefined);
              setVisibilityMap(visShown);
              ensureGridSlotForWidget(shownWid, visShown);
            }

            setWidgetConfigs(loadAllWidgetConfigs());
            if (saveWid === DASH_WIDGET.STREAM && streamTimePresetRef.current !== 'live') {
              setStreamHistoryPollEpoch((n) => n + 1);
            }
            if (saveWid === DASH_WIDGET.BAR_CHART) {
              setBarAutoRefreshEpoch((n) => n + 1);
            }
          }}
          onClose={() => setEditModalCtx(null)}
        />

        {widgetGalleryOpen &&
          createPortal(
            <div
              className="bsd-widget-gallery-overlay"
              role="dialog"
              aria-modal="true"
              aria-labelledby="bsd-widget-gallery-title"
              onClick={closeWidgetGallery}
            >
              <div className="bsd-widget-gallery-modal" onClick={(ev) => ev.stopPropagation()}>
                <header className="bsd-widget-gallery-header">
                  <div className="bsd-widget-gallery-header-text">
                    <h2 id="bsd-widget-gallery-title" className="bsd-widget-gallery-title">
                      Agregar widget
                    </h2>
                    <p className="bsd-widget-gallery-subtitle">
                      Elige entre los tipos de widget del tablero para visualizar e interactuar con tus datos.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="bsd-widget-gallery-close"
                    onClick={closeWidgetGallery}
                    aria-label="Cerrar"
                  >
                    <X size={22} strokeWidth={2} />
                  </button>
                </header>
                <label className="bsd-widget-gallery-search">
                  <Search size={18} aria-hidden />
                  <input
                    type="search"
                    value={widgetGallerySearch}
                    onChange={(ev) => setWidgetGallerySearch(ev.target.value)}
                    placeholder="Buscar widgets…"
                    autoComplete="off"
                    enterKeyHint="search"
                  />
                </label>
                <div className="bsd-widget-gallery-filters" role="tablist" aria-label="Categorías">
                  {widgetGalleryFilterOptions.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="tab"
                      aria-selected={widgetGalleryCategory === opt.id}
                      className={`bsd-widget-gallery-filter${widgetGalleryCategory === opt.id ? ' active' : ''}`}
                      onClick={() => setWidgetGalleryCategory(opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="bsd-widget-gallery-grid">
                  {galleryFilteredMenuEntries.length === 0 ? (
                    <p className="bsd-widget-gallery-empty">No hay widgets en esta categoría o búsqueda.</p>
                  ) : (
                    galleryFilteredMenuEntries.map((e) => {
                      const Ico = widgetGalleryLucideIcon(e.id);
                      return (
                        <button
                          key={e.id}
                          type="button"
                          className="bsd-widget-gallery-card"
                          onClick={() => {
                            closeWidgetGallery();
                            onWidgetGalleryPick(e.id);
                          }}
                        >
                          <span className="bsd-widget-gallery-card__icon" aria-hidden>
                            <Ico size={22} strokeWidth={2} />
                          </span>
                          <span className="bsd-widget-gallery-card__name">{e.label}</span>
                          <span className="bsd-widget-gallery-card__desc">{e.description}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>,
            document.body
          )}
      </div>
    </div>
    <CenteredAlertModal
      open={panelDelete != null}
      title="Eliminar panel"
      message={
        panelDelete
          ? `¿Seguro que deseas eliminar el panel **${panelDelete.name}**? Se borrarán sus widgets y el diseño de esta pestaña.`
          : ''
      }
      variant="warning"
      cancelLabel="Cancelar"
      confirmLabel="Eliminar"
      confirmDanger
      onClose={closePanelDeleteDialog}
      onConfirm={commitPanelDelete}
    />
    </>
  );
}
