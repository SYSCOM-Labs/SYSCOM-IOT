import { getTelemetryPropertyValue } from '../../utils/telemetryPropertyPath';

/** @typedef {{ id: string; name: string; value: number; color: string }} GaugeRangeRow */

export const BSD_VALUE_WIDGETS_STORAGE_KEY = 'bsd_value_widgets_v1';
const STORAGE_KEY = BSD_VALUE_WIDGETS_STORAGE_KEY;
export const VISIBILITY_STORAGE_KEY = 'bsd_dashboard_visible_v1';

/** Espacio de trabajo: varios paneles de control con nombres propios (solo variant panel). */
export const BSD_PANEL_WORKSPACE_KEY = 'bsd_panel_workspace_v1';

/** Prefijo localStorage para dispositivo de control del panel (aislado por usuario). */
export const PANEL_CONTROL_DEVICE_KEY = 'bsd_panel_control_device';

/**
 * Segmento estable por cuenta (no por rol: cada login tiene su propio tablero).
 * @param {object | null | undefined} userLike p. ej. `user` / `userProfile` de Auth
 * @returns {string} segmento seguro para claves; vacío si no hay sesión
 */
export function resolvePanelOwnerSegment(userLike) {
  if (!userLike || typeof userLike !== 'object') return '';
  const raw = userLike.id ?? userLike.userId ?? userLike.sub ?? userLike.email;
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  return s
    .replace(/[^a-zA-Z0-9@._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 96);
}

export function panelWorkspaceStorageKey(ownerSegment) {
  const seg = ownerSegment != null && String(ownerSegment).trim() ? String(ownerSegment).trim() : '';
  if (!seg) return BSD_PANEL_WORKSPACE_KEY;
  return `${BSD_PANEL_WORKSPACE_KEY}_o_${seg}`;
}

export function panelControlDeviceStorageKey(ownerSegment) {
  const seg = ownerSegment != null && String(ownerSegment).trim() ? String(ownerSegment).trim() : '';
  if (!seg) return PANEL_CONTROL_DEVICE_KEY;
  return `${PANEL_CONTROL_DEVICE_KEY}_o_${seg}`;
}

/** IDs de widgets fijos del dashboard (Panel / Dispositivo). */
export const DASH_WIDGET = {
  SWITCH: 'dw_switch',
  DOWNLINK: 'dw_downlink',
  IMAGE: 'dw_image',
  MAP: 'dw_map',
  /** Trayectoria GPS desde historial de telemetría (p. ej. rastreadores LoRaWAN). */
  TRACKING_MAP: 'dw_tracking_map',
  SATISFACTION: 'dw_satisfaction',
  /** Medidor semicircular (temperatura, humedad, nivel, etc.). */
  METRIC_CIRCULAR: 'dw_metric_circular',
  /** Valor de telemetría solo como texto (sin gráficos). */
  TEXT: 'dw_text',
  STREAM: 'dw_stream',
  /** Historial en barras + línea objetivo (presupuesto / umbral). */
  BAR_CHART: 'dw_bar_chart',
  PANEL_DEVICE_BAR: 'dw_panel_device_bar',
  SENSOR_GRID: 'dw_sensor_grid',
};

/** Tipos de widget que pueden repetirse en el mismo tablero (id de celda `base__…`). */
export const MULTI_INSTANCE_DASH_WIDGETS = new Set([DASH_WIDGET.TEXT, DASH_WIDGET.METRIC_CIRCULAR]);

/**
 * Id base del tipo de widget (`dw_text`) a partir del id de celda (`dw_text` o `dw_text__abc`).
 * @param {string} slotId
 */
export function dashboardWidgetBaseId(slotId) {
  const s = String(slotId ?? '');
  for (const base of MULTI_INSTANCE_DASH_WIDGETS) {
    if (s === base) return base;
    const prefix = `${base}__`;
    if (s.startsWith(prefix)) return base;
  }
  return s;
}

/**
 * @param {string} baseId p. ej. DASH_WIDGET.TEXT
 */
export function makeDashboardWidgetCloneId(baseId) {
  const b = String(baseId);
  return `${b}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** @param {string} storageOrSlotId id de celda o clave parcial */
export function isDashboardMultiLayoutSlotId(storageOrSlotId) {
  const s = String(storageOrSlotId ?? '');
  if (!s) return false;
  if (Object.values(DASH_WIDGET).includes(s)) return true;
  const b = dashboardWidgetBaseId(s);
  if (!MULTI_INSTANCE_DASH_WIDGETS.has(b)) return false;
  return s === b || s.startsWith(`${b}__`);
}

/**
 * Categoría para el selector modal de widgets (filtros).
 * @typedef {'controls' | 'display' | 'charts' | 'maps' | 'data' | 'special'} DashboardWidgetCategory
 */

/** @returns {{ id: string; label: string; description: string; category: DashboardWidgetCategory; panelOnly?: boolean }[]} */
export function getDashboardWidgetMenuEntries() {
  return [
    {
      id: DASH_WIDGET.PANEL_DEVICE_BAR,
      label: 'Barra de dispositivos',
      description: 'Selector y acciones rápidas para los equipos del panel.',
      category: 'special',
      /** No aparece en la galería «Agregar widget» (ni Panel ni Dispositivo); puede existir en layouts guardados. */
      panelOnly: true,
    },
    {
      id: DASH_WIDGET.SWITCH,
      label: 'Switch',
      description: 'Control tipo interruptor vinculado a downlinks on/off.',
      category: 'controls',
    },
    {
      id: DASH_WIDGET.DOWNLINK,
      label: 'Downlink',
      description: 'Botones para enviar comandos configurados al dispositivo.',
      category: 'controls',
    },
    {
      id: DASH_WIDGET.IMAGE,
      label: 'Imagen',
      description: 'Muestra una imagen fija o subida para contexto visual.',
      category: 'display',
    },
    {
      id: DASH_WIDGET.MAP,
      label: 'Mapa',
      description: 'Ubicación fija o en vivo; coordenadas en la configuración del widget.',
      category: 'maps',
    },
    {
      id: DASH_WIDGET.TRACKING_MAP,
      label: 'Mapa de rastreo',
      description: 'Trayectoria desde el historial de coordenadas (día, semana, mes).',
      category: 'maps',
    },
    {
      id: DASH_WIDGET.SATISFACTION,
      label: 'Circular',
      description: 'Indicador circular tipo gauge para un valor en porcentaje.',
      category: 'charts',
    },
    {
      id: DASH_WIDGET.METRIC_CIRCULAR,
      label: 'Métrica circular',
      description: 'Medidor semicircular con aguja; puedes repetir con otro campo.',
      category: 'charts',
    },
    {
      id: DASH_WIDGET.TEXT,
      label: 'Texto',
      description: 'Valor de telemetría como número o texto; varias copias permitidas.',
      category: 'data',
    },
    {
      id: DASH_WIDGET.STREAM,
      label: 'Grafico Lineal',
      description: 'Serie temporal en vivo y rangos Hora / Día / Semana / Mes (misma lógica que el gráfico de barras).',
      category: 'charts',
    },
    {
      id: DASH_WIDGET.BAR_CHART,
      label: 'Gráfico de barras',
      description: 'Historial agregado en barras con umbral u objetivo.',
      category: 'charts',
    },
    {
      id: DASH_WIDGET.SENSOR_GRID,
      label: 'Cuadrícula de sensores',
      description: 'Tarjetas compactas con varios sensores y sus indicadores.',
      category: 'data',
    },
  ];
}

/**
 * Panel y vista dispositivo: ningún widget fijo visible hasta que el usuario lo añada desde «Agregar widget»
 * (o equivalente). Así el tablero queda vacío al primer acceso y no se rellena solo con telemetría.
 */
export function defaultDashboardVisibilityForVariant(_variant) {
  const m = {};
  for (const { id } of getDashboardWidgetMenuEntries()) m[id] = false;
  return m;
}

export function defaultDashboardVisibility() {
  return defaultDashboardVisibilityForVariant('device');
}

/** Listado de pestaña Básicos al editar widgets fijos del tablero BSD. */
export const DASHBOARD_BASICS_WIDGET_OPTIONS = [
  { id: DASH_WIDGET.SATISFACTION, label: 'Circular Widget' },
  { id: DASH_WIDGET.METRIC_CIRCULAR, label: 'Métrica circular Widget' },
  { id: DASH_WIDGET.TEXT, label: 'Texto Widget' },
  { id: DASH_WIDGET.SENSOR_GRID, label: 'Multi-Sensor Panel Widget' },
  { id: DASH_WIDGET.STREAM, label: 'Grafico Lineal Widget' },
  { id: DASH_WIDGET.BAR_CHART, label: 'Grafico Barras Widget' },
  { id: DASH_WIDGET.MAP, label: 'Mapa' },
  { id: DASH_WIDGET.TRACKING_MAP, label: 'Mapa de rastreo' },
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
 * @param {string} dashWidgetId ej. DASH_WIDGET.SATISFACTION → dw_satisfaction
 * @returns {{ id: number; name: string; propertyKey: string; value: number; unit: string; threshold: number; sourceDeviceId: string }}
 */
export function dashboardWidgetSensorStub(dashWidgetId) {
  const slot = String(dashWidgetId);
  const baseId = dashboardWidgetBaseId(slot);
  const opt = DASHBOARD_BASICS_WIDGET_OPTIONS.find((o) => o.id === baseId);
  const baseName = opt
    ? String(opt.label)
        .replace(/\s+Widget\s*$/i, '')
        .trim() || opt.label
    : String(baseId);
  const name = slot !== baseId ? `${baseName} · copia` : baseName;
  return {
    id: 0,
    name,
    propertyKey: `__bsd_${slot}`,
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

/** `variant|dashboard|dw_*` o `device|<deviceId>|dw_*` → `dw_*` */
export function dashboardWidgetIdFromStorageKey(storageKey) {
  const parts = String(storageKey || '').split('|');
  if (parts.length < 3) return null;
  if (parts[0] !== 'panel' && parts[0] !== 'device') return null;
  return parts[2] || null;
}

/**
 * @param {'panel' | 'device'} variant
 * @param {string | number | null | undefined} [deviceId] obligatorio en `variant === 'device'` para aislar por equipo
 */
export function loadDashboardVisibility(variant, deviceId = null, panelInstanceId = null, panelOwnerSegment = null) {
  try {
    const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    const root = raw ? JSON.parse(raw) : {};
    let branch;
    if (variant === 'device' && deviceId != null && String(deviceId).trim().length) {
      const k = `device:${String(deviceId).trim()}`;
      branch = root[k];
      /** No usar `root.device`: antes mezclaba visibilidad entre distintos equipos. */
    } else if (variant === 'panel') {
      const pid = panelInstanceId != null && String(panelInstanceId).trim() ? String(panelInstanceId).trim() : 'main';
      const seg = panelOwnerSegment != null && String(panelOwnerSegment).trim() ? String(panelOwnerSegment).trim() : '';
      if (seg) branch = root[`panel:${seg}:${pid}`];
      if (!branch || typeof branch !== 'object') {
        branch = root[`panel:${pid}`];
      }
      if ((!branch || typeof branch !== 'object') && pid === 'main') branch = root.panel;
    } else {
      branch = root[variant];
    }
    return {
      ...defaultDashboardVisibilityForVariant(variant),
      ...(branch && typeof branch === 'object' ? branch : {}),
    };
  } catch {
    return defaultDashboardVisibilityForVariant(variant);
  }
}

/**
 * @param {'panel' | 'device'} variant
 * @param {Record<string, boolean>} map
 * @param {string | number | null | undefined} [deviceId] en vista dispositivo, persiste solo para ese `deviceId`
 */
export function saveDashboardVisibility(variant, map, deviceId = null, panelInstanceId = null, panelOwnerSegment = null) {
  try {
    let root = {};
    const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') root = p;
    }
    if (variant === 'device') {
      const id = deviceId != null && String(deviceId).trim();
      if (!id) {
        // Sin id estable, escribir en `root.device` mezclaría equipos; solo persistir vista panel.
        return;
      }
      root[`device:${String(deviceId).trim()}`] = { ...map };
    } else if (variant === 'panel') {
      const pid = panelInstanceId != null && String(panelInstanceId).trim() ? String(panelInstanceId).trim() : 'main';
      const seg = panelOwnerSegment != null && String(panelOwnerSegment).trim() ? String(panelOwnerSegment).trim() : '';
      if (seg) {
        root[`panel:${seg}:${pid}`] = { ...map };
      } else {
        root[`panel:${pid}`] = { ...map };
      }
    } else {
      root[variant] = { ...map };
    }
    localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify(root));
  } catch {
    /* ignore */
  }
}

/** @returns {{ panels: { id: string; name: string }[]; activePanelId: string } | null } */
export function loadPanelWorkspace(ownerSegment) {
  const key = panelWorkspaceStorageKey(ownerSegment);
  try {
    const raw = localStorage.getItem(key);
    if (!raw && ownerSegment && key !== BSD_PANEL_WORKSPACE_KEY) {
      const legacy = localStorage.getItem(BSD_PANEL_WORKSPACE_KEY);
      if (legacy) return JSON.parse(legacy);
    }
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o?.panels?.length && o.activePanelId) return o;
  } catch {
    /* ignore */
  }
  return null;
}

export function savePanelWorkspace(workspace, ownerSegment) {
  try {
    const key = panelWorkspaceStorageKey(ownerSegment);
    localStorage.setItem(key, JSON.stringify(workspace));
  } catch {
    /* ignore */
  }
}

/**
 * Copia datos legacy del panel (sin usuario) a la clave del usuario actual una sola vez por sesión.
 */
export function migrateLegacyPanelDataToOwner(ownerSegment) {
  if (!ownerSegment || typeof localStorage === 'undefined') return;
  let flagOk = false;
  try {
    const flag = `bsd_panel_scoped_migrated_${ownerSegment}`;
    if (sessionStorage.getItem(flag) === '1') return;
    flagOk = true;
  } catch {
    /* ignore */
  }

  migrateBsdPanelWorkspaceAndConfigsOnce();

  const wsKey = panelWorkspaceStorageKey(ownerSegment);
  try {
    if (!localStorage.getItem(wsKey)) {
      const legacyWs = localStorage.getItem(BSD_PANEL_WORKSPACE_KEY);
      if (legacyWs) localStorage.setItem(wsKey, legacyWs);
    }
  } catch {
    /* ignore */
  }

  try {
    const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    const root = raw ? JSON.parse(raw) : {};
    let visChanged = false;
    for (const k of Object.keys(root)) {
      if (!k.startsWith('panel:')) continue;
      const parts = k.split(':');
      if (parts.length !== 2) continue;
      const pid = parts[1];
      const scoped = `panel:${ownerSegment}:${pid}`;
      if (!root[scoped] && root[k] && typeof root[k] === 'object') {
        root[scoped] = { ...root[k] };
        visChanged = true;
      }
    }
    if (root.panel && typeof root.panel === 'object' && !root[`panel:${ownerSegment}:main`]) {
      root[`panel:${ownerSegment}:main`] = { ...root.panel };
      visChanged = true;
    }
    if (visChanged) localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify(root));
  } catch {
    /* ignore */
  }

  try {
    const all = loadAllWidgetConfigs();
    let next = null;
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('panel|dashboard_')) continue;
      const parts = k.split('|');
      if (parts.length < 3) continue;
      const ns = parts[1];
      if (!ns.startsWith('dashboard_')) continue;
      if (ns.startsWith(`dashboard_${ownerSegment}_`)) continue;
      const rest = ns.slice('dashboard_'.length);
      const newNs = `dashboard_${ownerSegment}_${rest}`;
      const nk = `panel|${newNs}|${parts[2]}`;
      const pool = next || all;
      if (pool[nk] === undefined) {
        if (!next) next = { ...all };
        next[nk] = v;
      }
    }
    if (next) localStorage.setItem(BSD_VALUE_WIDGETS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }

  try {
    const legacyMain = localStorage.getItem('bsd_dash_grid_v1_panel_main');
    const newMainKey = `bsd_dash_grid_v1_panel_o_${ownerSegment}_main`;
    if (legacyMain && !localStorage.getItem(newMainKey)) {
      localStorage.setItem(newMainKey, legacyMain);
    }
    const oldGrid = localStorage.getItem('bsd_dash_grid_v1_panel');
    const altNew = `bsd_dash_grid_v1_panel_o_${ownerSegment}_main`;
    if (oldGrid && !localStorage.getItem(altNew)) {
      localStorage.setItem(altNew, oldGrid);
    }
  } catch {
    /* ignore */
  }

  try {
    const legacyDev = localStorage.getItem(PANEL_CONTROL_DEVICE_KEY);
    const nk = panelControlDeviceStorageKey(ownerSegment);
    if (legacyDev && !localStorage.getItem(nk)) {
      localStorage.setItem(nk, legacyDev);
    }
  } catch {
    /* ignore */
  }

  if (flagOk) {
    try {
      sessionStorage.setItem(`bsd_panel_scoped_migrated_${ownerSegment}`, '1');
    } catch {
      /* ignore */
    }
  }
}

/**
 * Migra claves legacy `panel|dashboard|` → `panel|dashboard_main|` y crea el workspace si faltaba.
 * Idempotente; llamar una vez al montar el panel de control.
 */
export function migrateBsdPanelWorkspaceAndConfigsOnce() {
  if (typeof localStorage === 'undefined') return;
  let ws = loadPanelWorkspace();
  if (!ws) {
    ws = { panels: [{ id: 'main', name: 'Panel principal' }], activePanelId: 'main' };
    savePanelWorkspace(ws);
  }
  const all = loadAllWidgetConfigs();
  let changed = false;
  const oldPrefix = 'panel|dashboard|';
  const newPrefix = 'panel|dashboard_main|';
  for (const k of Object.keys(all)) {
    if (k.startsWith(oldPrefix)) {
      const suffix = k.slice(oldPrefix.length);
      const nk = newPrefix + suffix;
      if (all[nk] === undefined) {
        all[nk] = all[k];
        changed = true;
      }
    }
  }
  if (changed) {
    try {
      localStorage.setItem(BSD_VALUE_WIDGETS_STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }
  try {
    const raw = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    const root = raw ? JSON.parse(raw) : {};
    if (root.panel && !root['panel:main']) {
      root['panel:main'] = { ...root.panel };
      localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify(root));
    }
  } catch {
    /* ignore */
  }
  try {
    const oldGrid = localStorage.getItem('bsd_dash_grid_v1_panel');
    const newKey = 'bsd_dash_grid_v1_panel_main';
    if (oldGrid && !localStorage.getItem(newKey)) {
      localStorage.setItem(newKey, oldGrid);
    }
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
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
  { value: 'year', label: 'Año' },
];

/** Presets del gráfico de barras en tablero y en edición (sin «intervalo completo», minuto ni año). */
export const BAR_CHART_WIDGET_GRANULARITY_OPTIONS = [
  { value: 'hour', label: 'Hora' },
  { value: 'day', label: 'Día' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
];

/**
 * Alinea granularidad guardada (ES/EN, mayúsculas, acentos) con las ramas del gráfico de barras.
 * @param {unknown} raw
 * @returns {string}
 */
/**
 * Inicio del intervalo a consultar en BD para el gráfico de barras (última hora / día / semana / mes).
 * Respeta `from` del widget si es más reciente (intervalo manual más corto).
 */
export function barChartHistoryFetchFromMs(granularity, fromMs, toMs) {
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return from;
  const g = normalizeBarChartGranularity(granularity);
  let span = null;
  if (g === 'hour') span = 60 * 60000;
  else if (g === 'day') span = 24 * 3600000;
  else if (g === 'week') span = 7 * 86400000;
  else if (g === 'month') span = 30 * 86400000;
  else return from;
  return Math.max(from, to - span);
}

export function normalizeBarChartGranularity(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const map = {
    '': '',
    minute: 'minute',
    minuto: 'minute',
    hour: 'hour',
    hora: 'hour',
    day: 'day',
    dia: 'day',
    week: 'week',
    semana: 'week',
    month: 'month',
    mes: 'month',
    year: 'year',
    ano: 'year',
  };
  return map[s] !== undefined ? map[s] : s;
}

/**
 * Ajusta el intervalo temporal según la resolución y activa agregación (promedio por defecto).
 * @param {Record<string, unknown>} draft
 * @param {string} granularity '' | minute | hour | day | week | month | year
 */
export function applyHistoryGranularityPreset(draft, granularity) {
  draft.timeframe = draft.timeframe || {};
  if (!granularity) {
    draft.timeframe.granularity = '';
    return;
  }
  switch (granularity) {
    case 'minute':
      draft.timeframe.from = '60 minutos atrás';
      break;
    case 'hour':
      draft.timeframe.from = '60 minutos atrás';
      break;
    case 'day':
      draft.timeframe.from = '24 horas atrás';
      break;
    case 'week':
      draft.timeframe.from = '7 días atrás';
      break;
    case 'month':
      draft.timeframe.from = '30 días atrás';
      break;
    case 'year': {
      const now = Date.now();
      draft.timeframe.from = new Date(now - 86400000 * 3650).toISOString();
      draft.timeframe.to = 'now';
      break;
    }
    default:
      draft.timeframe.granularity = '';
      return;
  }
  draft.timeframe.mode = 'interval';
  if (granularity !== 'year') {
    draft.timeframe.to = 'now';
  }
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

/** Normaliza a `#rrggbb` o `null` si no es un color hex válido. */
export function parseCssHex(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let h = s.startsWith('#') ? s.slice(1) : s;
  if (/^[0-9a-f]{3}$/i.test(h)) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return `#${h.toLowerCase()}`;
}

function hexToRgbTuple(hex) {
  const norm = parseCssHex(hex);
  if (!norm) return null;
  const n = parseInt(norm.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbTupleToHex(rgb) {
  const { r, g, b } = rgb;
  const to = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Luminancia relativa WCAG 2.1 (0–1). */
export function relativeLuminanceFromHex(hex) {
  const rgb = hexToRgbTuple(hex);
  if (!rgb) return 0;
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(rgb.r);
  const G = lin(rgb.g);
  const B = lin(rgb.b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** Contraste entre dos colores (#rrggbb). */
export function contrastRatioHex(fgHex, bgHex) {
  const L1 = relativeLuminanceFromHex(fgHex);
  const L2 = relativeLuminanceFromHex(bgHex);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * @typedef {{
 *   enabled?: boolean;
 *   operator?: 'eq' | 'gt' | 'lt' | 'gte' | 'lte';
 *   compareValue?: string;
 *   backgroundColor?: string;
 * }} ConditionalBackgroundRule
 */

export function isLikelyButtonOrStatusFieldKey(fk) {
  const k = String(fk || '').toLowerCase();
  return (
    k.includes('button') ||
    k.includes('pulsador') ||
    k.includes('boton') ||
    k.includes('botón') ||
    k === 'press' ||
    k.includes('estatus') ||
    k.includes('estado')
  );
}

/**
 * Valor a mostrar / comparar: clave del usuario y alias típicos de gateway
 * (p. ej. `button_event` → `button_event_status`).
 * @param {Record<string, unknown> | null | undefined} telemetryLiveProps
 * @param {string | null | undefined} fkStr
 */
export function resolveTelemetryDisplaySource(telemetryLiveProps, fkStr) {
  if (!telemetryLiveProps || typeof telemetryLiveProps !== 'object' || Array.isArray(telemetryLiveProps)) {
    return undefined;
  }
  const fk = fkStr != null ? String(fkStr).trim() : '';
  if (!fk) return undefined;
  const primary = getTelemetryPropertyValue(telemetryLiveProps, fk);
  if (primary !== undefined) {
    if (primary && typeof primary === 'object' && !Array.isArray(primary) && primary.status != null) {
      return primary.status;
    }
    return primary;
  }
  if (!isLikelyButtonOrStatusFieldKey(fk)) return undefined;
  const st = getTelemetryPropertyValue(telemetryLiveProps, 'button_event_status');
  if (st !== undefined) return st;
  const be = getTelemetryPropertyValue(telemetryLiveProps, 'button_event');
  if (be !== undefined) return be;
  const press = getTelemetryPropertyValue(telemetryLiveProps, 'press');
  if (press !== undefined) return press;
  return undefined;
}

/** Títulos típicos del widget Texto que en la práctica muestran estado de pulsador / salida aunque el `fieldKey` sea genérico. */
export function textWidgetTitleSuggestsButtonOrStatus(cfg) {
  const t = String(cfg?.basics?.title || '').toLowerCase();
  return /bot[oó]n|pulsador|button|estatus|estado|salida|output|input/.test(t);
}

/**
 * Valor crudo alineado con el widget Texto del tablero: campo configurado + alias y claves típicas de gateway.
 * @param {Record<string, unknown> | null | undefined} telemetryLiveProps
 * @param {string} fkStr
 * @param {Record<string, unknown> | null | undefined} cfg
 */
export function resolveTextWidgetRawScalar(telemetryLiveProps, fkStr, cfg) {
  let v = resolveTelemetryDisplaySource(telemetryLiveProps, fkStr);
  if (v !== undefined && v !== null && !(typeof v === 'string' && !String(v).trim())) return v;
  const probe = isLikelyButtonOrStatusFieldKey(fkStr) || textWidgetTitleSuggestsButtonOrStatus(cfg);
  if (!probe) return undefined;
  const keys = [
    'button_event_status',
    'button_event',
    'press',
    'gpio_input_1',
    'gpio_input_2',
    'gpio_input_3',
    'gpio_input_4',
  ];
  for (const k of keys) {
    const alt = getTelemetryPropertyValue(telemetryLiveProps, k);
    if (alt !== undefined && alt !== null && !(typeof alt === 'string' && !String(alt).trim())) return alt;
    if (alt && typeof alt === 'object' && !Array.isArray(alt) && alt.status != null) return alt.status;
  }
  return undefined;
}

function comparableNumberFromTelemetryScalar(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const t = v.trim().replace(',', '.');
    const n = parseFloat(t);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * ¿Se cumple la regla opcional de fondo? `eq` admite número o texto (sin distinguir mayúsculas);
 * `gt`/`lt`/… solo si ambos lados son numéricos.
 * @param {ConditionalBackgroundRule | null | undefined} rule
 * @param {unknown} actualRaw valor en vivo del campo del widget (o derivado)
 */
export function conditionalBackgroundRuleMatches(rule, actualRaw) {
  if (!rule || typeof rule !== 'object' || !rule.enabled) return false;
  const op = String(rule.operator || 'eq').toLowerCase();
  const rawTarget = rule.compareValue != null ? String(rule.compareValue) : '';
  const bg = String(rule.backgroundColor || '').trim();
  if (!bg || !parseCssHex(bg)) return false;
  if (actualRaw === undefined || actualRaw === null) return false;

  const aNum = comparableNumberFromTelemetryScalar(actualRaw);
  const tNum = comparableNumberFromTelemetryScalar(rawTarget);

  if (op === 'eq') {
    if (aNum != null && tNum != null) return Math.abs(aNum - tNum) < 1e-6;
    return String(actualRaw).trim().toLowerCase() === rawTarget.trim().toLowerCase();
  }
  if (aNum == null || tNum == null) return false;
  switch (op) {
    case 'gt':
      return aNum > tNum;
    case 'lt':
      return aNum < tNum;
    case 'gte':
      return aNum >= tNum - 1e-9;
    case 'lte':
      return aNum <= tNum + 1e-9;
    default:
      return false;
  }
}

/**
 * Aplica color de fondo condicional sobre la apariencia base (no muta el objeto original).
 * Si `alternateRaw` se pasa (p. ej. escalar crudo además de la etiqueta en pantalla), la regla cumple si coincide cualquiera.
 * @param {Record<string, unknown> | null | undefined} appearance
 * @param {unknown} actualRaw
 * @param {unknown} [alternateRaw]
 */
export function appearanceWithConditionalBackground(appearance, actualRaw, alternateRaw) {
  if (!appearance || typeof appearance !== 'object') return appearance;
  const rule = /** @type {ConditionalBackgroundRule | undefined} */ (appearance.conditionalBackground);
  let match = conditionalBackgroundRuleMatches(rule, actualRaw);
  if (
    !match &&
    alternateRaw !== undefined &&
    alternateRaw !== null &&
    alternateRaw !== actualRaw
  ) {
    match = conditionalBackgroundRuleMatches(rule, alternateRaw);
  }
  if (!match) return appearance;
  const bg = String(rule.backgroundColor || '').trim();
  if (!bg) return appearance;
  return { ...appearance, widgetBackgroundColor: bg };
}

/** Fondo del tablero BSD sin tinte (solo vidrio / borde). */
export function isWidgetBackgroundTransparent(appearance) {
  const raw = String(appearance?.widgetBackgroundColor ?? '').trim().toLowerCase();
  return raw === 'transparent' || raw === 'none' || raw === 'sin' || raw === 'sin fondo';
}

/**
 * Estilos inline para la tarjeta `.widget` (o tarjeta de sensor) según apariencia guardada.
 * `null` = usar gradiente cristal por defecto del CSS.
 * @param {Record<string, unknown> | null | undefined} appearance
 */
export function buildBsdWidgetSurfaceStyle(appearance) {
  if (!appearance || typeof appearance !== 'object') return null;
  const raw = String(appearance.widgetBackgroundColor ?? '').trim();
  if (!raw) return null;
  if (isWidgetBackgroundTransparent(appearance)) {
    return {
      background: 'transparent',
      backgroundImage: 'none',
      /* Sin backdrop-filter: el blur mezcla la capa decorativa cyan de .bsd-root y genera manchas. */
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
      boxShadow:
        '0 12px 36px rgba(8, 47, 73, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.28)',
      borderColor: 'rgba(186, 230, 253, 0.42)',
    };
  }
  const hex = parseCssHex(raw);
  if (!hex) return null;
  const n = hex.slice(1);
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const top = `rgba(${r},${g},${b},0.52)`;
  const mid = `rgba(${r},${g},${b},0.6)`;
  const bot = `rgba(${r},${g},${b},0.48)`;
  return {
    background: `linear-gradient(165deg, ${top} 0%, ${mid} 45%, ${bot} 100%)`,
    borderColor: 'rgba(255, 255, 255, 0.4)',
    /* Sin blur: el vidrio del CSS mezcla el cian del tablero y el color elegido no se ve fiel. */
    backdropFilter: 'none',
    WebkitBackdropFilter: 'none',
    boxShadow:
      '0 20px 48px -16px rgba(8, 47, 73, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.45), inset 0 -1px 0 rgba(12, 74, 110, 0.18)',
  };
}

const DOWNLINK_TEXT_CONTRAST_MIN = 4.5;

/**
 * Color de etiqueta del botón: prioriza el color del título; si no alcanza contraste sobre el fondo,
 * mezcla el título hacia un neutro oscuro o claro hasta cumplir WCAG (sigue “emparentado” con el título).
 * @param {string} titleColorHex
 * @param {string} buttonBgHex fondo del botón (#rrggbb)
 */
export function resolveDownlinkButtonTextColor(titleColorHex, buttonBgHex) {
  const bg = parseCssHex(buttonBgHex);
  const tc = parseCssHex(titleColorHex) || parseCssHex('#e0e7ff');
  if (!bg || !tc) return tc || '#e0e7ff';
  if (contrastRatioHex(tc, bg) >= DOWNLINK_TEXT_CONTRAST_MIN) return tc;
  const rgbT = hexToRgbTuple(tc);
  if (!rgbT) return '#f8fafc';
  const Lbg = relativeLuminanceFromHex(bg);
  const toward = Lbg > 0.45 ? { r: 15, g: 23, b: 42 } : { r: 248, g: 250, b: 252 };
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    const m = {
      r: rgbT.r + (toward.r - rgbT.r) * t,
      g: rgbT.g + (toward.g - rgbT.g) * t,
      b: rgbT.b + (toward.b - rgbT.b) * t,
    };
    const hx = rgbTupleToHex(m);
    if (contrastRatioHex(hx, bg) >= DOWNLINK_TEXT_CONTRAST_MIN) return hx;
  }
  return Lbg > 0.45 ? '#0f172a' : '#f8fafc';
}

/** Fila del editor / config: botón de downlink en el widget de panel. */
export function defaultDownlinkButtonRow() {
  return {
    id: `dlb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    hex: '',
    label: '',
    /** Fondo del botón (hex). Vacío = estilo cristal por defecto del tablero. */
    buttonColor: '',
  };
}

/**
 * Garantiza `data.downlinkButtons` (migra `downlinkDefaultHex` legacy).
 * @param {Record<string, unknown> | null | undefined} data
 */
export function ensureDownlinkButtonsDraft(data) {
  const d = data && typeof data === 'object' ? { ...data } : {};
  const raw = d.downlinkButtons;
  if (Array.isArray(raw) && raw.length > 0) {
    const downlinkButtons = raw.map((r, i) => ({
      id:
        r && r.id != null && String(r.id).trim()
          ? String(r.id).trim()
          : `dlb_${Date.now()}_${i}`,
      hex: r && r.hex != null ? String(r.hex) : '',
      label: r && r.label != null ? String(r.label) : '',
      buttonColor:
        r && r.buttonColor != null && String(r.buttonColor).trim()
          ? String(r.buttonColor).trim()
          : '',
    }));
    return { ...d, downlinkButtons };
  }
  const legacy = normalizeDownlinkHex(d.downlinkDefaultHex);
  if (legacy) {
    return { ...d, downlinkButtons: [{ id: 'dlb_legacy', hex: legacy, label: '', buttonColor: '' }] };
  }
  return { ...d, downlinkButtons: [defaultDownlinkButtonRow()] };
}

/**
 * Normaliza botones al guardar; mantiene `downlinkDefaultHex` = primer HEX válido (compat).
 * @param {Record<string, unknown> | null | undefined} data
 */
export function normalizeDownlinkButtonsForSave(data) {
  const ensured = ensureDownlinkButtonsDraft(data);
  const withNormHex = (ensured.downlinkButtons || []).map((r) => ({
    id: r.id,
    hex: normalizeDownlinkHex(r.hex) || '',
    label: String(r.label || '').trim(),
    buttonColor: parseCssHex(r.buttonColor) || '',
  }));
  const valid = withNormHex.filter((r) => r.hex);
  const downlinkButtons = valid.length > 0 ? valid : [defaultDownlinkButtonRow()];
  return {
    ...ensured,
    downlinkButtons,
    downlinkDefaultHex: valid[0]?.hex || '',
  };
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
        chartType: 'area',
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

/**
 * Progreso 0–1 del llenado del arco entre scaleLo y scaleHi.
 * Con inverseFill, un menor valor de telemetría implica mayor llenado (p. ej. distancia al líquido menor = más llenado).
 * Los colores por rangos siguen evaluándose con el valor físico (colorForValueInRanges sobre la lectura real).
 */
export function gaugeFillProgressT(n, scaleLo, scaleHi, inverseFill) {
  const lo = Number.isFinite(scaleLo) ? scaleLo : 0;
  const hi = Number.isFinite(scaleHi) && scaleHi > lo ? scaleHi : lo + 1;
  const span = hi - lo;
  if (!Number.isFinite(n) || span <= 0) return 0;
  const clamped = Math.min(hi, Math.max(lo, n));
  const tNorm = (clamped - lo) / span;
  const inv = Boolean(inverseFill);
  return inv ? 1 - tNorm : tNorm;
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
    appearance: {
      ...base.appearance,
      ...(s.appearance || {}),
      conditionalBackground: {
        ...base.appearance.conditionalBackground,
        ...(s.appearance?.conditionalBackground && typeof s.appearance.conditionalBackground === 'object'
          ? s.appearance.conditionalBackground
          : {}),
      },
    },
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
  const isMetricCircular = pk === `__bsd_${DASH_WIDGET.METRIC_CIRCULAR}`;
  const isStreamChart = pk === `__bsd_${DASH_WIDGET.STREAM}`;
  const isBarChart = pk === `__bsd_${DASH_WIDGET.BAR_CHART}`;
  const isTextWidget = pk === `__bsd_${DASH_WIDGET.TEXT}`;
  const isImageWidget = pk === `__bsd_${DASH_WIDGET.IMAGE}`;
  const isMapWidget = pk === `__bsd_${DASH_WIDGET.MAP}`;
  const isTrackingMapWidget = pk === `__bsd_${DASH_WIDGET.TRACKING_MAP}`;
  const baseMax =
    typeof sensor.threshold === 'number' && sensor.threshold > 0
      ? Math.max(sensor.threshold * 1.2, sensor.value * 1.1 || sensor.threshold)
      : 50;
  const step = baseMax / 5;
  /** Escala por defecto del anillo: 0–100 (p. ej. batería %); antes 60 hacía que valores >60 llenaran el 100 %. */
  const mcScale = 100;
  const mcStep = mcScale / 5;
  return {
    basics: {
      title: sensor.name || pk,
      preset: 'none',
      titleTranslations: [],
    },
    data: {
      fieldKey:
        isMetricCircular ||
        isStreamChart ||
        isBarChart ||
        isTextWidget ||
        isImageWidget ||
        isMapWidget ||
        isTrackingMapWidget
          ? ''
          : pk,
      unit: sensor.unit || '',
      /** Fórmula opcional: transforma el valor mostrado (p. ej. `(Valor) / 1000`). */
      formulaEnabled: false,
      formulaExpression: '',
      /** Vacío = misma clave que `fieldKey`. */
      formulaSourceKey: '',
      decimals: isMetricCircular ? 1 : isBarChart ? 1 : 2,
      ...(isMetricCircular ? { metricSubtitle: '', metricGradient: 'traffic' } : {}),
      ...(isStreamChart ? { historyRangePreset: 'live' } : {}),
      ...(isBarChart
        ? { barChartTarget: '', barLegendActual: 'Actual', barLegendTarget: 'Objetivo' }
        : {}),
      ...(isImageWidget ? { uploadedImageDataUrl: '' } : {}),
      ...(isMapWidget ? { savedLatitude: '', savedLongitude: '' } : {}),
      ...(isTrackingMapWidget
        ? {
            trackingTimeRange: 'day',
            /** Vacío = todo el payload por fila (p. ej. AT101 con latitude/longitude/history en raíz). */
            trackingTelemetryField: '',
          }
        : {}),
    },
    appearance: {
      titleColor:
        isMetricCircular ? '#0e7490' : isBarChart || isTextWidget || isTrackingMapWidget ? '#ffffff' : '#f97316',
      /** Vacío = cristal BSD; `transparent` = sin tinte; o `#rrggbb` */
      widgetBackgroundColor: '',
      /** Opcional: si el valor del campo cumple la condición, sustituye temporalmente el fondo del widget. */
      conditionalBackground: {
        enabled: false,
        operator: 'eq',
        compareValue: '',
        backgroundColor: '#22c55e',
      },
    },
    gauge: {
      indicatorType: 'numeric',
      scaleMin: 0,
      scaleMax: isMetricCircular ? mcScale : isTextWidget ? 100 : Math.round(baseMax * 10) / 10,
      ranges: isMetricCircular
        ? [
            { id: 'r1', name: '', value: Math.round(mcStep * 10) / 10, color: '#22c55e' },
            { id: 'r2', name: '', value: Math.round(mcStep * 2 * 10) / 10, color: '#eab308' },
            { id: 'r3', name: '', value: Math.round(mcStep * 3 * 10) / 10, color: '#f97316' },
            { id: 'r4', name: '', value: Math.round(mcStep * 4 * 10) / 10, color: '#ef4444' },
            { id: 'r5', name: '', value: mcScale, color: '#dc2626' },
          ]
        : [
            { id: 'r1', name: '', value: Math.round(step * 10) / 10, color: '#48bb78' },
            { id: 'r2', name: '', value: Math.round(step * 2 * 10) / 10, color: '#48bb78' },
            { id: 'r3', name: '', value: Math.round(step * 3 * 10) / 10, color: '#48bb78' },
            { id: 'r4', name: '', value: Math.round(step * 4 * 10) / 10, color: '#ed8936' },
            { id: 'r5', name: '', value: Math.round(baseMax * 10) / 10, color: '#f56565' },
          ],
    },
    timeframe: isBarChart
      ? {
          mode: 'interval',
          operation: 'avg',
          from: '60 minutos atrás',
          to: 'now',
          granularity: 'hour',
          timezone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC',
        }
      : {
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

/**
 * Namespace para widgets fijos del BSD: en panel es `dashboard`; en vista dispositivo, el id del equipo
 * (`device|<id>|dw_*`) para que cada dispositivo tenga su propia configuración.
 *
 * @param {'panel' | 'device'} variant
 * @param {string | number | null | undefined} deviceId
 */
/**
 * @param {'panel' | 'device'} variant
 * @param {string | number | null | undefined} deviceId
 * @param {string | null | undefined} [panelInstanceId] id del panel (solo variant panel); defecto `main`
 */
export function dashboardWidgetConfigNamespace(variant, deviceId, panelInstanceId, panelOwnerSegment = null) {
  if (variant === 'device' && deviceId != null && String(deviceId).trim().length) {
    return String(deviceId).trim();
  }
  if (variant === 'panel') {
    const pid = panelInstanceId != null && String(panelInstanceId).trim() ? String(panelInstanceId).trim() : 'main';
    const seg = panelOwnerSegment != null && String(panelOwnerSegment).trim() ? String(panelOwnerSegment).trim() : '';
    if (seg) return `dashboard_${seg}_${pid}`;
    return `dashboard_${pid}`;
  }
  return 'dashboard';
}

/**
 * Clave localStorage para un tile fijo del tablero (mapa, barras, streaming, etc.).
 * @param {'panel' | 'device'} variant
 * @param {string | number | null | undefined} deviceId
 * @param {string} dashWidgetId ej. DASH_WIDGET.MAP
 * @param {string | null | undefined} [panelInstanceId]
 * @param {string | null | undefined} [panelOwnerSegment] segmento de cuenta (vista panel)
 */
export function dashboardWidgetStorageKey(variant, deviceId, dashWidgetId, panelInstanceId, panelOwnerSegment = null) {
  return widgetStorageKey(
    variant,
    dashboardWidgetConfigNamespace(variant, deviceId, panelInstanceId, panelOwnerSegment),
    dashWidgetId
  );
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

/**
 * Persistencia permanente en `localStorage` (`BSD_VALUE_WIDGETS_STORAGE_KEY`): título, campo, rangos,
 * apariencia y demás ajustes del modal «Editar widget». La clave `storageKey` incluye variante (panel/dispositivo),
 * namespace de panel/usuario y id del widget (`variant|namespace|dw_*`), así cada equipo y panel conserva su propia configuración manual.
 */
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
  const esHours = s.match(/^(\d+)\s*horas?\s+atr[aá]s$/);
  if (esHours) {
    const n = parseInt(esHours[1], 10);
    return nowMs - n * 3600000;
  }
  const esMinutes = s.match(/^(\d+)\s*minutos?\s+atr[aá]s$/);
  if (esMinutes) {
    const n = parseInt(esMinutes[1], 10);
    return nowMs - n * 60000;
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
