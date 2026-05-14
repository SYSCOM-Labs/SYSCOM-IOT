/**
 * Serializa / aplica en localStorage la configuración BSD del panel (variant `panel`)
 * para sincronizar con el servidor por usuario, segmento de cuenta e id de panel.
 */

import {
  loadAllWidgetConfigs,
  saveDashboardVisibility,
  BSD_VALUE_WIDGETS_STORAGE_KEY,
  loadDashboardVisibility,
  dashboardWidgetConfigNamespace,
} from '../components/dashboard/widgetConfigUtils';
import { dashboardGridLayoutStorageKey, readStoredBsdGridLayout } from '../components/dashboard/bsdDashboardLayout';

/**
 * @param {string | null | undefined} panelOwnerSegment
 * @param {string | null | undefined} panelInstanceId
 * @returns {Record<string, unknown> | null}
 */
export function collectPanelBsdBundle(panelOwnerSegment, panelInstanceId) {
  if (typeof localStorage === 'undefined') return null;
  const pid = panelInstanceId != null && String(panelInstanceId).trim() ? String(panelInstanceId).trim() : 'main';
  const segRaw = panelOwnerSegment != null && String(panelOwnerSegment).trim() ? String(panelOwnerSegment).trim() : '';
  const segForNs = segRaw || null;
  const ns = dashboardWidgetConfigNamespace('panel', null, pid, segForNs);
  const prefix = `panel|${ns}|`;
  const all = loadAllWidgetConfigs();
  const valueWidgets = {};
  for (const [k, v] of Object.entries(all)) {
    if (String(k).startsWith(prefix) && v != null && typeof v === 'object') {
      valueWidgets[k] = v;
    }
  }
  const gridKey = dashboardGridLayoutStorageKey('panel', null, pid, segRaw || undefined);
  const gridLayout = readStoredBsdGridLayout(gridKey);
  const visibility = loadDashboardVisibility('panel', null, pid, segForNs);
  return {
    valueWidgets,
    gridLayout,
    visibility: { ...visibility },
  };
}

/**
 * @param {string | null | undefined} panelOwnerSegment
 * @param {string | null | undefined} panelInstanceId
 * @param {Record<string, unknown> | null | undefined} bundle
 */
export function applyPanelBsdBundle(panelOwnerSegment, panelInstanceId, bundle) {
  if (typeof localStorage === 'undefined' || !bundle || typeof bundle !== 'object') return;
  const pid = panelInstanceId != null && String(panelInstanceId).trim() ? String(panelInstanceId).trim() : 'main';
  const segRaw = panelOwnerSegment != null && String(panelOwnerSegment).trim() ? String(panelOwnerSegment).trim() : '';
  const segForNs = segRaw || null;
  const ns = dashboardWidgetConfigNamespace('panel', null, pid, segForNs);
  const prefix = `panel|${ns}|`;

  const vw = bundle.valueWidgets;
  if (vw && typeof vw === 'object') {
    const all = loadAllWidgetConfigs();
    const next = { ...all };
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
    const gridKey = dashboardGridLayoutStorageKey('panel', null, pid, segRaw || undefined);
    try {
      localStorage.setItem(gridKey, JSON.stringify(gl));
    } catch {
      /* ignore */
    }
  }

  const vis = bundle.visibility;
  if (vis && typeof vis === 'object') {
    saveDashboardVisibility('panel', { ...vis }, null, pid, segForNs);
  }
}
