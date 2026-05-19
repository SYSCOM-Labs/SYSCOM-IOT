import { getApiBase, getPublicServerOrigin } from '../config/apiBase';
import { clearPrimedDeviceSharedPresets } from './deviceTemplates';

// Local auth service — replaces Firebase Auth + Firestore

const API = getApiBase();

/** Origen del servidor (sin /api) para mostrar URLs de ingesta al gateway. */
export const getServerOrigin = () => getPublicServerOrigin();

const getToken = () => localStorage.getItem('local_token');
const setToken = (t) => localStorage.setItem('local_token', t);

/**
 * Segmento payload del JWT (base64url). `jsonwebtoken` en el servidor usa URL-safe;
 * `atob` falla si no se normaliza (+ / y padding).
 */
export function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad !== 0) return null;
  try {
    const json = atob(b64);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Guarda JWT de sesión (p. ej. retorno OAuth) y notifica a `AuthContext`. */
export function applySessionToken(t) {
  if (!t || typeof t !== 'string') return;
  setToken(t);
  try {
    window.dispatchEvent(new CustomEvent('syscom-token-refreshed', { detail: { token: t } }));
  } catch {
    /* SSR */
  }
}
const removeToken = () => localStorage.removeItem('local_token');

const headers = () => ({
  'Content-Type': 'application/json',
  ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {})
});

/** Evita pantallas «Cargando…» colgadas si la API no responde. */
export async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`Tiempo de espera agotado (${ms}ms) al contactar el servidor`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const handle = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallback =
      data.error ||
      data.errMsg ||
      (typeof data.message === 'string' && data.message) ||
      `Error HTTP ${res.status}${res.statusText ? ` (${res.statusText})` : ''}`;
    const err = new Error(fallback.trim() || 'Error del servidor');
    if (data.code) err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
};

// ── Auth ───────────────────────────────────────────────────
export const localLogin = async (email, password) => {
  const data = await handle(await fetch(`${API}/auth/login`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ email, password })
  }));
  setToken(data.token);
  return data;
};

/**
 * Comprueba si el correo está registrado en SYSCOM IoT (sin contraseña).
 * @returns {Promise<{ exists: boolean, accountKind?: 'staff'|'user', profileName?: string }>}
 */
export const checkEmailRegistered = async (email) => {
  const norm = String(email || '').trim().toLowerCase();
  const res = await fetch(`${API}/auth/check-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: norm }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
};

export const localLogout = () => {
  removeToken();
  clearPrimedDeviceSharedPresets();
};

export const getMe = async () => {
  return handle(await fetchWithTimeout(`${API}/auth/me`, { headers: headers() }, 8000));
};

export const checkSetup = async () => {
  const res = await fetchWithTimeout(`${API}/setup/status`, { cache: 'no-store' }, 6000);
  return handle(res);
};

export const createAdmin = async (email, password, profileName) => {
  return handle(await fetch(`${API}/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, profileName }),
  }));
};

export const completeFirstPassword = async (newPassword) => {
  const data = await handle(
    await fetch(`${API}/auth/first-password`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ newPassword }),
    })
  );
  setToken(data.token);
  return data;
};

export const isTokenValid = () => {
  const token = getToken();
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return false;
  return payload.exp * 1000 > Date.now();
};

let refreshPromise = null;

/** Renueva JWT (POST /api/auth/refresh). Coalescido si hay varias peticiones en paralelo. */
export const refreshSession = async () => {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const data = await handle(
        await fetchWithTimeout(
          `${API}/auth/refresh`,
          {
            method: 'POST',
            headers: headers(),
          },
          8000
        )
      );
      if (data.token) setToken(data.token);
      try {
        window.dispatchEvent(new CustomEvent('syscom-token-refreshed', { detail: { token: data.token } }));
      } catch {
        /* SSR */
      }
      return data;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
};

export const getLocalUser = () => {
  const token = getToken();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload || payload.id == null) return null;
  const out = {
    id: payload.id,
    email: payload.email,
    role: payload.role,
    profileName: payload.profileName,
    mustChangePassword: Boolean(payload.mustChangePassword),
    avatarUrl: payload.avatarUrl,
    nav: payload.nav && typeof payload.nav === 'object' ? payload.nav : {},
  };
  const imp = payload.impersonatorId != null && String(payload.impersonatorId).trim();
  if (imp) out.impersonatorId = imp;
  return out;
};

/** Solo superadmin (sesión real): devuelve JWT del destino con `impersonatorId` en el payload. */
export const startImpersonationSession = async (targetUserId) => {
  const id = String(targetUserId || '').trim();
  if (!id) throw new Error('Usuario destino requerido');
  const data = await handle(
    await fetch(`${API}/auth/impersonate/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: headers(),
    })
  );
  if (data.token) setToken(data.token);
  return data;
};

/** Vuelve al JWT del superadmin que abrió el modo soporte. */
export const stopImpersonationSession = async () => {
  const data = await handle(
    await fetch(`${API}/auth/impersonate/stop`, {
      method: 'POST',
      headers: headers(),
    })
  );
  if (data.token) setToken(data.token);
  return data;
};

// ── User management ────────────────────────────────────────
export const getUsers = async () => {
  return handle(await fetch(`${API}/users`, { headers: headers() }));
};

export const createUser = async (userData) => {
  return handle(await fetch(`${API}/users`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify(userData)
  }));
};

export const updateUser = async (id, updates) => {
  return handle(await fetch(`${API}/users/${id}`, {
    method: 'PUT', headers: headers(),
    body: JSON.stringify(updates)
  }));
};

export const deleteUser = async (id) => {
  return handle(await fetch(`${API}/users/${id}`, {
    method: 'DELETE', headers: headers()
  }));
};

/** Lista `user_devices` de un usuario (admin: solo su jerarquía; super admin: cualquiera). */
export const getUserDevices = async (userId) => {
  return handle(await fetch(`${API}/users/${encodeURIComponent(userId)}/devices`, { headers: headers() }));
};

// ── Telemetry ──────────────────────────────────────────────

// In-memory cache of last sent properties per device
const _lastSentProps = {};

export const saveTelemetry = async (deviceId, deviceName, properties) => {
  try {
    // Compare with last sent — skip if identical (client-side check before hitting server)
    const key = deviceId.toString();
    const newHash = JSON.stringify(properties);
    if (_lastSentProps[key] === newHash) return; // no change, skip
    _lastSentProps[key] = newHash;

    const result = await fetch(`${API}/telemetry`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ deviceId, deviceName, properties })
    });
    if (result.ok) {
      const data = await result.json();
      if (data.saved === false) {
        // Server also confirmed no change — keep our cache in sync
      }
    }
  } catch (e) {
    console.warn('[LocalAuth] Telemetry save failed:', e.message);
  }
};

/**
 * propKey opcional: si falta o está vacío, devuelve todas las propiedades en el rango.
 * @param {number} [limit] — máximo de filas (servidor: hasta ~4000); útil para históricos largos en widgets.
 */
export const queryTelemetry = async (deviceId, propKey, startMs, endMs, limit) => {
  const params = new URLSearchParams();
  params.set('startMs', String(startMs));
  params.set('endMs', String(endMs));
  if (propKey != null && propKey !== '') params.set('propKey', propKey);
  if (limit != null && Number.isFinite(Number(limit))) {
    params.set('limit', String(Math.min(4000, Math.max(1, Math.floor(Number(limit))))));
  }
  return handle(
    await fetchWithTimeout(
      `${API}/telemetry/${deviceId}?${params.toString()}`,
      { headers: headers() },
      12000
    )
  );
};

export const getLatestDeviceData = async () => {
  return handle(await fetchWithTimeout(`${API}/devices/latest`, { headers: headers() }, 12000));
};
