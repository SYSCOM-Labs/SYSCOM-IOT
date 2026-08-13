import { getMobileServerApiBase, getMobileServerOrigin, isMobileApp } from '../utils/mobilePlatform.js';

/**
 * Asegura que la base absoluta termine en `/api` (Express monta rutas bajo `/api/...`).
 * @param {string} base
 */
export function normalizeApiBase(base) {
  const b = String(base || '').trim().replace(/\/$/, '');
  if (!b) return '/api';
  if (!/^https?:\/\//i.test(b)) {
    if (b === '/api' || b.endsWith('/api')) return b.startsWith('/') ? b : `/${b}`;
    return b.startsWith('/') ? `${b.replace(/\/$/, '')}/api`.replace(/^\/+/, '/') : `/${b}/api`;
  }
  try {
    const u = new URL(b);
    let p = u.pathname || '';
    if (p.endsWith('/')) p = p.slice(0, -1);
    if (!p || p === '/') {
      u.pathname = '/api';
    } else if (!p.endsWith('/api')) {
      u.pathname = `${p}/api`;
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return /\/api$/i.test(b) ? b : `${b}/api`;
  }
}

/**
 * Base de la API HTTP.
 * - Desarrollo: `/api` → Vite proxy → backend (vite.config.js).
 * - Producción (mismo dominio que el front): `/api` → Express.
 * - Opcional: VITE_API_BASE=https://tu-api.com/api (si solo pone el host, se añade `/api` automáticamente).
 */
export function getApiBase() {
  if (isMobileApp()) {
    const mobile = getMobileServerApiBase();
    if (mobile) return normalizeApiBase(mobile);
  }
  const raw = import.meta.env.VITE_API_BASE;
  if (raw != null && String(raw).trim() !== '') {
    return normalizeApiBase(String(raw).trim());
  }
  return '/api';
}

/** Origen público para URLs de ingesta (Ajustes / gateway). Mismo host que la página en despliegue típico. */
export function getPublicServerOrigin() {
  if (isMobileApp()) {
    const mo = getMobileServerOrigin();
    if (mo) return mo;
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = window.location.origin.replace(/\/$/, '');
    if (origin && !/^capacitor:/i.test(origin) && origin !== 'https://localhost') {
      return origin;
    }
  }
  const o = import.meta.env.VITE_PUBLIC_ORIGIN;
  if (o != null && String(o).trim() !== '') {
    return String(o).trim().replace(/\/$/, '');
  }
  return 'http://localhost:3001';
}

/**
 * URL de Server-Sent Events (JWT en query; EventSource no admite Bearer).
 *
 * En **desarrollo** con `getApiBase()` relativo (`/api`), el stream va **directo al backend**
 * (`http://localhost:PORT/api/...`) para evitar `ECONNRESET` del proxy HTTP de Vite con SSE largo.
 * Ajuste puerto con `VITE_DEV_API_PORT` o origen completo con `VITE_SSE_ORIGIN`.
 * Forzar el proxy antiguo: `VITE_SSE_VIA_PROXY=1`.
 */
export function getEventsStreamUrl(token) {
  const base = getApiBase().replace(/\/$/, '');
  const enc = encodeURIComponent(token || '');
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return `${base}/events/stream?token=${enc}`;
  }
  if (isMobileApp()) {
    const mobile = getMobileServerApiBase();
    if (mobile) return `${mobile.replace(/\/$/, '')}/events/stream?token=${enc}`;
  }
  if (typeof window === 'undefined') return `${base}/events/stream?token=${enc}`;

  const viaProxy = String(import.meta.env.VITE_SSE_VIA_PROXY || '').trim() === '1';
  if (import.meta.env.DEV && !viaProxy) {
    const explicit = import.meta.env.VITE_SSE_ORIGIN || import.meta.env.VITE_DEV_API_ORIGIN;
    const origin =
      explicit != null && String(explicit).trim() !== ''
        ? String(explicit).trim().replace(/\/$/, '')
        : `http://localhost:${String(import.meta.env.VITE_DEV_API_PORT || '3001').trim()}`;
    return `${origin}/api/events/stream?token=${enc}`;
  }

  const path = base.startsWith('/') ? base : `/${base}`;
  return `${window.location.origin}${path}/events/stream?token=${enc}`;
}
