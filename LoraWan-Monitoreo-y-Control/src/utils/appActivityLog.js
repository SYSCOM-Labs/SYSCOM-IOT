/**
 * Registro de actividad global (vista en Ajustes → Log). Emite `CustomEvent` en `window`.
 * @typedef {{ level?: 'info'|'success'|'warn'|'error', tag?: string, message: string, detail?: unknown }} AppActivityEntry
 */

export const SYSCOM_APP_ACTIVITY = 'syscom-app-activity';

/**
 * @param {AppActivityEntry} entry
 */
export function pushAppActivityLog(entry) {
  if (typeof window === 'undefined') return;
  const level = entry.level && ['info', 'success', 'warn', 'error'].includes(entry.level) ? entry.level : 'info';
  const tag = entry.tag != null && String(entry.tag).trim() ? String(entry.tag).trim() : 'App';
  window.dispatchEvent(
    new CustomEvent(SYSCOM_APP_ACTIVITY, {
      detail: {
        ts: Date.now(),
        level,
        tag,
        message: String(entry.message || ''),
        detail: entry.detail,
      },
    })
  );
}
