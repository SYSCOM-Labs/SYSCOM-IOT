/**
 * Base de la API HTTP.
 * - Desarrollo: `/api` → Vite proxy → backend (vite.config.js).
 * - Producción (mismo dominio que el front): `/api` → Express.
 * - Opcional: VITE_API_BASE=https://tu-api.com/api si front y API están separados (debe terminar en /api).
 */
export function getApiBase() {
  const raw = import.meta.env.VITE_API_BASE;
  if (raw != null && String(raw).trim() !== '') {
    return String(raw).trim().replace(/\/$/, '');
  }
  return '/api';
}

/** Origen público para URLs de ingesta (Ajustes / gateway). Mismo host que la página en despliegue típico. */
export function getPublicServerOrigin() {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin.replace(/\/$/, '');
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
