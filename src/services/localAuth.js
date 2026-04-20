import { getApiBase, getPublicServerOrigin } from '../config/apiBase';

// Local auth service — replaces Firebase Auth + Firestore

const API = getApiBase();

/** Origen del servidor (sin /api) para mostrar URLs de ingesta al gateway. */
export const getServerOrigin = () => getPublicServerOrigin();

const getToken = () => localStorage.getItem('local_token');
const setToken = (t) => localStorage.setItem('local_token', t);
const removeToken = () => localStorage.removeItem('local_token');

/** Una sola promesa en vuelo para coalescer refresh concurrentes (401 en cascada, etc.). */
let refreshSessionPromise = null;

/**
 * Renueva el JWT vía POST /api/auth/refresh. Actualiza localStorage y dispara `syscom-token-refreshed`.
 * @returns {Promise<string>} nuevo token
 */
export async function refreshSession() {
  if (refreshSessionPromise) return refreshSessionPromise;
  const tok = getToken();
  if (!tok) {
    return Promise.reject(new Error('No hay token almacenado'));
  }
  refreshSessionPromise = (async () => {
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || 'No se pudo renovar la sesión');
        if (data.code) err.code = data.code;
        err.status = res.status;
        throw err;
      }
      if (!data.token) {
        const err = new Error('Respuesta de refresh sin token');
        err.status = res.status;
        throw err;
      }
      setToken(data.token);
      try {
        window.dispatchEvent(
          new CustomEvent('syscom-token-refreshed', { detail: { token: data.token } })
        );
      } catch {
        /* ignore (SSR) */
      }
      return data.token;
    } finally {
      refreshSessionPromise = null;
    }
  })();
  return refreshSessionPromise;
}

const headers = () => ({
  'Content-Type': 'application/json',
  ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {})
});

const handle = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.errMsg || 'Error del servidor');
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

export const googleCallback = async (code) => {
  const data = await handle(await fetch(`${API}/auth/google/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }));
  setToken(data.token);
  return data;
};

export const localLogout = () => {
  removeToken();
};

export const getMe = async () => {
  return handle(await fetch(`${API}/auth/me`, { headers: headers() }));
};

export const checkSetup = async () => {
  return handle(await fetch(`${API}/setup/status`));
};

export const createAdmin = async (email, profileName) => {
  return handle(await fetch(`${API}/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, profileName }),
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

/** Solo API en loopback + sesión admin. Lista reducida para selector de suplantación. */
export const fetchDebugImpersonationUsers = async () => {
  return handle(await fetch(`${API}/debug/impersonation-users`, { headers: headers() }));
};

/** Solo API en loopback. Emite JWT con claim `impersonation` (sesión como otro usuario). */
export const debugImpersonate = async (userId) => {
  const data = await handle(
    await fetch(`${API}/debug/impersonate`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ userId }),
    })
  );
  setToken(data.token);
  return data;
};

export const isTokenValid = () => {
  const token = getToken();
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 > Date.now();
  } catch { return false; }
};

export const getLocalUser = () => {
  const token = getToken();
  if (!token) return null;
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch { return null; }
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

/** propKey opcional: si falta o está vacío, devuelve todas las propiedades en el rango. */
export const queryTelemetry = async (deviceId, propKey, startMs, endMs) => {
  const params = new URLSearchParams();
  params.set('startMs', String(startMs));
  params.set('endMs', String(endMs));
  if (propKey != null && propKey !== '') params.set('propKey', propKey);
  return handle(await fetch(`${API}/telemetry/${deviceId}?${params.toString()}`, { headers: headers() }));
};

export const getLatestDeviceData = async () => {
  return handle(await fetch(`${API}/devices/latest`, { headers: headers() }));
};
