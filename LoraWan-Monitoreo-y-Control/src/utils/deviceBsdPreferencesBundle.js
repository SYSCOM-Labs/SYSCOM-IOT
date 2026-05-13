/**
 * Serializa / aplica en localStorage la configuración BSD de un dispositivo
 * (widgets `device|<id>|*`, rejilla, visibilidad, downlinks) para sincronizar con el servidor al asignar equipos.
 */

import {
  loadAllWidgetConfigs,
  saveDashboardVisibility,
  BSD_VALUE_WIDGETS_STORAGE_KEY,
  loadDashboardVisibility,
} from '../components/dashboard/widgetConfigUtils';
import { dashboardGridLayoutStorageKey, readStoredBsdGridLayout } from '../components/dashboard/bsdDashboardLayout';
import { readDownlinksFromLocalStorage, downlinksLocalStorageKey } from '../services/deviceTemplates';

/**
 * @param {string | number | null | undefined} deviceId
 * @returns {Record<string, unknown> | null}
 */
export function collectDeviceBsdBundle(deviceId) {
  const id = deviceId != null ? String(deviceId).trim() : '';
  if (!id || typeof localStorage === 'undefined') return null;
  const prefix = `device|${id}|`;
  const all = loadAllWidgetConfigs();
  const valueWidgets = {};
  for (const [k, v] of Object.entries(all)) {
    if (String(k).startsWith(prefix) && v != null && typeof v === 'object') {
      valueWidgets[k] = v;
    }
  }
  /** Migración incompleta: widgets aún bajo `device|dashboard|dw_*` al abrir vista dispositivo. */
  const legacyPrefix = 'device|dashboard|';
  for (const [k, v] of Object.entries(all)) {
    if (!String(k).startsWith(legacyPrefix) || v == null || typeof v !== 'object') continue;
    const suffix = String(k).slice(legacyPrefix.length);
    const nk = `${prefix}${suffix}`;
    if (valueWidgets[nk] == null) valueWidgets[nk] = v;
  }
  const gridKey = dashboardGridLayoutStorageKey('device', id, undefined, undefined);
  const gridLayout = readStoredBsdGridLayout(gridKey);
  const visibility = loadDashboardVisibility('device', id);
  const downlinks = readDownlinksFromLocalStorage(id);
  return {
    valueWidgets,
    gridLayout,
    visibility: { ...visibility },
    downlinks,
  };
}

/**
 * @param {string} deviceId
 * @param {Record<string, unknown> | null | undefined} bundle
 */
export function applyDeviceBsdBundle(deviceId, bundle) {
  const id = deviceId != null ? String(deviceId).trim() : '';
  if (!id || !bundle || typeof bundle !== 'object' || typeof localStorage === 'undefined') return;

  const vw = bundle.valueWidgets;
  if (vw && typeof vw === 'object') {
    const all = loadAllWidgetConfigs();
    const next = { ...all };
    const prefix = `device|${id}|`;
    for (const k of Object.keys(next)) {
      if (String(k).startsWith(prefix)) delete next[k];
    }
    for (const [k, v] of Object.entries(vw)) {
      if (String(k).startsWith(prefix) && v != null && typeof v === 'object') next[k] = v;
    }
    try {
      localStorage.setItem(BSD_VALUE_WIDGETS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
  }

  const gl = bundle.gridLayout;
  if (Array.isArray(gl)) {
    const gridKey = dashboardGridLayoutStorageKey('device', id, undefined, undefined);
    try {
      localStorage.setItem(gridKey, JSON.stringify(gl));
    } catch {
      /* ignore */
    }
  }

  const vis = bundle.visibility;
  if (vis && typeof vis === 'object') {
    saveDashboardVisibility('device', { ...vis }, id);
  }

  const dl = bundle.downlinks;
  if (Array.isArray(dl)) {
    try {
      localStorage.setItem(downlinksLocalStorageKey(id), JSON.stringify(dl));
    } catch {
      /* ignore */
    }
  }
}

/** @param {Record<string, unknown> | null | undefined} bundle */
export function deviceBsdBundleIsEmpty(bundle) {
  if (!bundle || typeof bundle !== 'object') return true;
  const vw = bundle.valueWidgets;
  const nVw = vw && typeof vw === 'object' ? Object.keys(vw).length : 0;
  const gl = bundle.gridLayout;
  const nGl = Array.isArray(gl) ? gl.length : 0;
  const dl = bundle.downlinks;
  const nDl = Array.isArray(dl) ? dl.filter((r) => r && String(r.hex || '').trim()).length : 0;
  const vis = bundle.visibility;
  const visKeys = vis && typeof vis === 'object' ? Object.keys(vis).filter((k) => vis[k] === false) : [];
  return nVw === 0 && nGl === 0 && nDl === 0 && visKeys.length === 0;
}
