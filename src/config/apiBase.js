/**
 * Base de la API HTTP.
 * - Desarrollo: `/api` → Vite proxy → backend (vite.config.js).
 * - Producción (mismo dominio que el front): `/api` → Express.
 * - Opcional: VITE_API_BASE=https://tu-api.com/api si front y API están separados.
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
 * Desarrollo: mismo origen que la página + proxy `/api` → backend.
 */
export function getEventsStreamUrl(token) {
  const base = getApiBase().replace(/\/$/, '');
  const enc = encodeURIComponent(token || '');
  if (base.startsWith('http://') || base.startsWith('https://')) {
    return `${base}/events/stream?token=${enc}`;
  }
  if (typeof window === 'undefined') return `${base}/events/stream?token=${enc}`;
  const path = base.startsWith('/') ? base : `/${base}`;
  return `${window.location.origin}${path}/events/stream?token=${enc}`;
}
