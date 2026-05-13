/** Foto opcional en barra superior y menú lateral (data URL en localStorage). */
export const BAR_AVATAR_STORAGE_KEY = 'syscom_iot_bar_avatar';
export const BAR_PREFS_CHANGED_EVENT = 'syscom-bar-prefs-changed';
export const BAR_AVATAR_MAX_BYTES = 800 * 1024;

export function notifyBarPrefsChanged() {
  try {
    window.dispatchEvent(new CustomEvent(BAR_PREFS_CHANGED_EVENT));
  } catch {
    /* SSR */
  }
}

export function readBarAvatarOverride() {
  try {
    const v = localStorage.getItem(BAR_AVATAR_STORAGE_KEY);
    if (typeof v === 'string' && v.startsWith('data:image/')) return v;
  } catch {
    /* ignore */
  }
  return null;
}
