/** Intervalos de refresco en vivo (panel / dispositivo). SSE es la vía principal; esto es respaldo HTTP. */

function parsePositiveMs(s, fallback) {
  const n = parseInt(String(s ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};

/** Poll widgets en panel (SSE es la vía principal; esto es respaldo). */
export const PANEL_LIVE_REFRESH_MS = parsePositiveMs(env.VITE_SYSCOM_PANEL_LIVE_POLL_MS, 6000);

/** Vista dispositivo / modal (sin alwaysFetchProperties cada tick si hay SSE). */
export const DEVICE_LIVE_REFRESH_MS = parsePositiveMs(env.VITE_SYSCOM_DEVICE_LIVE_POLL_MS, 8000);

/** Tras SSE, omitir GET /devices/latest y merge pesado (ms). */
export const PANEL_SSE_SKIP_HTTP_MS = parsePositiveMs(env.VITE_SYSCOM_PANEL_SSE_SKIP_HTTP_MS, 10000);

export const PANEL_DEVICES_LIST_REFRESH_MS = parsePositiveMs(env.VITE_SYSCOM_PANEL_DEVICES_LIST_POLL_MS, 30000);

export const PANEL_PROPERTIES_FETCH_MIN_MS = parsePositiveMs(env.VITE_SYSCOM_PANEL_PROPERTIES_MIN_MS, 120000);

/** Reconsulta historial de gráficos (Hora/Día/…); intervalo largo reduce carga SQLite. */
export const DASH_CHART_HISTORY_POLL_MS = parsePositiveMs(env.VITE_SYSCOM_CHART_HISTORY_POLL_MS, 20000);
