/**
 * Detección de app móvil (Capacitor / build VITE_SYSCOM_MOBILE) y URL del servidor SYSCOM.
 */

export const MOBILE_SERVER_ORIGIN_KEY = 'sycom_mobile_server_origin';

/** Build móvil explícito (`vite build --mode mobile`). */
export function isMobileBuild() {
  return String(import.meta.env.VITE_SYSCOM_MOBILE || '').trim() === '1';
}

/** Ejecutándose dentro de WebView nativa Capacitor. */
export function isCapacitorNative() {
  if (typeof window === 'undefined') return false;
  try {
    const cap = window.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) return true;
    if (cap && cap.platform && cap.platform !== 'web') return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** App móvil SYSCOM (APK o build mobile en navegador). */
export function isMobileApp() {
  return isMobileBuild() || isCapacitorNative();
}

/** Origen guardado por el usuario (sin `/api`). */
export function getMobileServerOrigin() {
  if (typeof localStorage === 'undefined') return getMobileDefaultServerOrigin();
  try {
    const saved = String(localStorage.getItem(MOBILE_SERVER_ORIGIN_KEY) || '').trim().replace(/\/$/, '');
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  return getMobileDefaultServerOrigin();
}

/** Valor inicial en login (`.env.mobile` → `VITE_MOBILE_DEFAULT_SERVER`). */
export function getMobileDefaultServerOrigin() {
  const raw = import.meta.env.VITE_MOBILE_DEFAULT_SERVER;
  if (raw != null && String(raw).trim()) {
    return normalizeServerOriginInput(String(raw).trim()) || '';
  }
  return '';
}

export function setMobileServerOrigin(origin) {
  const o = String(origin || '').trim().replace(/\/$/, '');
  if (typeof localStorage === 'undefined') return;
  try {
    if (!o) localStorage.removeItem(MOBILE_SERVER_ORIGIN_KEY);
    else localStorage.setItem(MOBILE_SERVER_ORIGIN_KEY, o);
  } catch {
    /* ignore */
  }
}

/** Base API absoluta para peticiones desde la APK. */
export function getMobileServerApiBase() {
  const o = getMobileServerOrigin();
  if (!o) return '';
  if (/\/api\/?$/i.test(o)) return o.replace(/\/$/, '');
  return `${o}/api`;
}

export function normalizeServerOriginInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    u.pathname = u.pathname.replace(/\/$/, '').replace(/\/api\/?$/i, '');
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
  } catch {
    return '';
  }
}
