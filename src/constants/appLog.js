/** Evento global para añadir líneas al registro inferior sin acoplar módulos al contexto React. */
export const SYSCOM_APP_LOG_EVENT = 'syscom-app-log';

/** Claves de categoría usadas en filtros y colores del panel de registro. */
export const APP_LOG_CATEGORY_LABELS = {
  sensor: 'Sensor',
  gateway: 'Gateway',
  action: 'Acción',
  realtime: 'Tiempo real',
  api: 'API',
  system: 'Sistema',
};

/** @typedef {keyof typeof APP_LOG_CATEGORY_LABELS} AppLogCategory */

const VALID = new Set(Object.keys(APP_LOG_CATEGORY_LABELS));

/**
 * @param {string} [c]
 * @returns {keyof typeof APP_LOG_CATEGORY_LABELS}
 */
export function normalizeAppLogCategory(c) {
  const k = String(c || '').trim();
  return VALID.has(k) ? k : 'system';
}

/**
 * @param {'info' | 'warn' | 'error'} level
 * @param {string} message
 * @param {{ category?: string, data?: unknown }} [opts]
 */
export function dispatchAppLog(level, message, opts = {}) {
  try {
    if (typeof window === 'undefined') return;
    const category = normalizeAppLogCategory(opts.category);
    window.dispatchEvent(
      new CustomEvent(SYSCOM_APP_LOG_EVENT, {
        detail: {
          level: level || 'info',
          message: message == null ? '' : String(message),
          category,
          data: opts.data,
        },
      }),
    );
  } catch {
    /* ignore */
  }
}
