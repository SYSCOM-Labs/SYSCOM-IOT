import axios from 'axios';
import { getApiBase } from '../config/apiBase';
import { refreshSession } from './localAuth';
import { normalizeTemplateLorawanClass } from './deviceTemplates';

const SERVER_API = getApiBase();

/** Tras 401, un intento de renovar JWT y repetir la petición (sesiones largas / kioscos). */
if (typeof window !== 'undefined' && !window.__SYSCOM_AXIOS_AUTH_RETRY__) {
  window.__SYSCOM_AXIOS_AUTH_RETRY__ = true;
  axios.interceptors.response.use(
    (r) => r,
    async (error) => {
      const cfg = error.config;
      if (!cfg || cfg.__retry401) return Promise.reject(error);
      if (error.response?.status !== 401) return Promise.reject(error);
      const url = String(cfg.url || '');
      if (
        url.includes('/auth/login') ||
        url.includes('/auth/refresh') ||
        url.includes('/auth/check-email') ||
        url.includes('/setup')
      ) {
        return Promise.reject(error);
      }
      try {
        await refreshSession();
      } catch {
        return Promise.reject(error);
      }
      cfg.__retry401 = true;
      cfg.headers = { ...(cfg.headers || {}), Authorization: `Bearer ${localStorage.getItem('local_token')}` };
      return axios(cfg);
    }
  );
}

const localToken = () => localStorage.getItem('local_token');

const authHeaders = () => ({
  Authorization: `Bearer ${localToken()}`,
  'Content-Type': 'application/json',
});

/** Lista de dispositivos a partir de telemetría almacenada (ingesta HTTP). */
export const fetchDevices = async (_credentials, _token) => {
  const response = await axios.get(`${SERVER_API}/devices`, { headers: authHeaders() });
  if (response.data.status !== 'Success') throw new Error(response.data.errMsg || 'Device list failed');
  return response;
};

export const fetchDeviceProperties = async (deviceId, _credentials, _token) => {
  const response = await axios.get(`${SERVER_API}/devices/${encodeURIComponent(deviceId)}/properties`, {
    headers: authHeaders(),
  });
  if (response.data.status !== 'Success') throw new Error(response.data.errMsg || 'Failed to fetch properties');
  const raw = response.data.data?.properties ?? {};
  return { ...response.data, data: { ...response.data.data, properties: raw } };
};

export const updateDevice = async (deviceData, _credentials, _token) => {
  const payload = {
    deviceId: deviceData.deviceId,
    name: deviceData.name,
    ...(Object.prototype.hasOwnProperty.call(deviceData, 'tag')
      ? { tag: deviceData.tag }
      : {}),
  };
  const response = await axios.put(`${SERVER_API}/devices`, payload, { headers: authHeaders() });
  if (response.data.status !== 'Success') throw new Error(response.data.errMsg || 'Update failed');
  return response.data;
};

export const callService = async (deviceId, serviceData, _credentials, _token) => {
  const response = await axios.post(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/services/call`,
    serviceData,
    { headers: authHeaders() }
  );
  return response.data;
};

export const fetchDeviceHistory = async (deviceId, params, _credentials, _token) => {
  const query = new URLSearchParams({ pageSize: 100, order: 'desc', ...params }).toString();
  const response = await axios.get(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/properties/history?${query}`,
    { headers: authHeaders() }
  );
  const d = response.data;
  if (Array.isArray(d)) return { list: d, downlinks: [] };
  if (d && d.status === 'Success' && Array.isArray(d.list)) {
    return { list: d.list, downlinks: Array.isArray(d.downlinks) ? d.downlinks : [] };
  }
  if (d && Array.isArray(d.list)) {
    return { list: d.list, downlinks: Array.isArray(d.downlinks) ? d.downlinks : [] };
  }
  throw new Error(d?.errMsg || d?.message || 'History fetch failed');
};

export const fetchDeviceTsl = async (deviceId, _credentials, _token) => {
  const response = await axios.get(`${SERVER_API}/devices/${encodeURIComponent(deviceId)}/thing-specification`, {
    headers: authHeaders(),
  });
  if (response.data.status !== 'Success') throw new Error(response.data.errMsg || 'TSL fetch failed');
  return response.data;
};

/** Reglas de automatización persistidas en el servidor (por usuario). */
export const fetchAutomationRules = async () => {
  const response = await axios.get(`${SERVER_API}/automations`, { headers: authHeaders() });
  return response.data.rules || [];
};

export const saveAutomationRules = async (rules) => {
  const response = await axios.put(`${SERVER_API}/automations`, { rules }, { headers: authHeaders() });
  return response.data;
};

/**
 * Descarga el respaldo SQLite (.db) con fetch (evita fallos con axios + responseType blob detrás del proxy de Vite).
 * Requiere rol admin o superadmin.
 */
export async function exportDatabaseBackupBlob() {
  const base = getApiBase().replace(/\/$/, '');
  const url = `${base}/admin/database/export`;
  const token = localToken();
  const r = await fetch(url, {
    method: 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/octet-stream,*/*',
    },
  });
  const blob = await r.blob();
  if (!r.ok) {
    let msg = r.status === 403 ? 'Permisos insuficientes (se requiere administrador).' : `Error HTTP ${r.status}`;
    try {
      const t = await blob.text();
      const j = JSON.parse(t);
      if (j.error) msg = String(j.error);
    } catch {
      /* mantener msg */
    }
    throw new Error(msg);
  }
  if (blob.size < 64) {
    const t = await blob.text();
    try {
      const j = JSON.parse(t);
      throw new Error(j.error ? String(j.error) : 'Respuesta demasiado pequeña');
    } catch (e) {
      if (e instanceof Error && e.message && !e.message.startsWith('JSON')) throw e;
    }
    throw new Error('Respuesta vacía o inválida');
  }
  const head = await blob.slice(0, 15).arrayBuffer();
  const magic = new TextDecoder().decode(head);
  if (magic !== 'SQLite format 3') {
    const t = await blob.text();
    try {
      const j = JSON.parse(t);
      throw new Error(j.error ? String(j.error) : 'No es un archivo SQLite');
    } catch (e) {
      if (e instanceof Error && e.message && e.message !== 'No es un archivo SQLite') throw e;
    }
    throw new Error('La respuesta no es un respaldo .db válido');
  }
  return blob;
}

/** Restaurar desde volcado .db (admin o superadmin). */
export async function importDatabaseBackupFile(file) {
  const buf = await file.arrayBuffer();
  const base = getApiBase().replace(/\/$/, '');
  const url = `${base}/admin/database/import`;
  const token = localToken();
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/octet-stream',
    },
    body: buf,
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = `Error HTTP ${r.status}`;
    try {
      const j = JSON.parse(text);
      if (j.error) msg = String(j.error);
    } catch {
      if (text) msg = text.slice(0, 400);
    }
    throw new Error(msg);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, message: text || 'OK' };
  }
}

export const fetchBackupConfig = async () => {
  const response = await axios.get(`${SERVER_API}/admin/backup-config`, { headers: authHeaders() });
  return response.data;
};

export const saveBackupConfig = async (payload) => {
  const response = await axios.put(`${SERVER_API}/admin/backup-config`, payload, { headers: authHeaders() });
  return response.data;
};

/** Estado SMTP (sin contraseña). */
export const fetchSmtpSettings = async () => {
  const response = await axios.get(`${SERVER_API}/settings/smtp`, { headers: authHeaders() });
  return response.data;
};

/** Guardar cuenta saliente SMTP (superadmin). Contraseña opcional si ya está en .env. */
export const saveSmtpSettings = async (payload) => {
  const response = await axios.put(`${SERVER_API}/settings/smtp`, payload, { headers: authHeaders() });
  return response.data;
};

/** Correo de prueba SMTP (superadmin). Acepta `to` o payload con credenciales del formulario. */
export const testSmtpSettings = async (payload) => {
  const body =
    typeof payload === 'string'
      ? { to: payload }
      : payload && typeof payload === 'object'
        ? payload
        : {};
  const response = await axios.post(`${SERVER_API}/settings/smtp/test`, body, {
    headers: authHeaders(),
  });
  return response.data;
};

/** Alta de dispositivo en el sistema (solo super administrador). */
export const registerUserDevice = async (payload) => {
  const response = await axios.post(`${SERVER_API}/user-devices`, payload, { headers: authHeaders() });
  return response.data;
};

/** Actualiza la clase LoRaWAN (A/B/C) del dispositivo y sincroniza la sesión LNS si existe. Solo super administrador. */
export const patchUserDeviceLorawanClass = async (deviceId, lorawanClass) => {
  const response = await axios.patch(
    `${SERVER_API}/user-devices/${encodeURIComponent(deviceId)}`,
    { lorawanClass },
    { headers: authHeaders() }
  );
  return response.data;
};

/** Avisos de licencia por vencer (≤7 días) para dispositivos asignados a la cuenta. */
export const fetchLicenseWarnings = async () => {
  const response = await axios.get(`${SERVER_API}/auth/license-warnings`, { headers: authHeaders() });
  return response.data?.warnings ?? [];
};

/** Último estado por dispositivo para analítica/resumen en UI. */
export const getLatestDeviceData = async () => {
  const response = await axios.get(`${SERVER_API}/devices/latest`, { headers: authHeaders() });
  return response.data;
};

/** Extiende la vigencia un año (solo super administrador). */
export const renewDeviceLicense = async (deviceId) => {
  const response = await axios.post(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/license/renew`,
    {},
    { headers: authHeaders() }
  );
  return response.data;
};

/** Quita el dispositivo solo de la cuenta del usuario autenticado (no borra el equipo ni a otros asignados). */
export const unassignMyDevice = async (deviceId) => {
  const response = await axios.delete(
    `${SERVER_API}/user-devices/${encodeURIComponent(deviceId)}`,
    { headers: authHeaders() }
  );
  return response.data;
};

/**
 * Quita el dispositivo solo del usuario `targetUserId` (superadmin o jerarquía Usuarios+Dispositivos).
 * No ejecuta borrado global; el superadmin u otros asignados conservan el vínculo.
 */
export const unassignDeviceFromUser = async (targetUserId, deviceId) => {
  const response = await axios.delete(
    `${SERVER_API}/users/${encodeURIComponent(String(targetUserId || '').trim())}/devices/${encodeURIComponent(String(deviceId || '').trim())}`,
    { headers: authHeaders() }
  );
  return response.data;
};

/** Borrado definitivo en base de datos (solo super administrador). */
export const purgeDeviceFromSystem = async (deviceId) => {
  const response = await axios.delete(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/permanent`,
    { headers: authHeaders() }
  );
  return response.data;
};

export const assignDeviceToUser = async (deviceId, assigneeEmail) => {
  const response = await axios.post(
    `${SERVER_API}/devices/assign`,
    { deviceId, assigneeEmail },
    { headers: authHeaders() }
  );
  return response.data;
};

export const fetchDeviceBsdPreferences = async (deviceId) => {
  const response = await axios.get(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/bsd-preferences`,
    { headers: authHeaders() }
  );
  return response.data;
};

export const putDeviceBsdPreferences = async (deviceId, prefs) => {
  const response = await axios.put(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/bsd-preferences`,
    prefs,
    { headers: authHeaders() }
  );
  return response.data;
};

export const fetchPanelBsdPreferences = async (segment, panelId) => {
  const params = new URLSearchParams();
  params.set('panelId', panelId != null && String(panelId).trim() ? String(panelId).trim() : 'main');
  params.set('segment', segment != null ? String(segment) : '');
  const response = await axios.get(`${SERVER_API}/me/panel-bsd-preferences?${params.toString()}`, {
    headers: authHeaders(),
  });
  return response.data;
};

export const putPanelBsdPreferences = async (segment, panelId, prefs) => {
  const response = await axios.put(
    `${SERVER_API}/me/panel-bsd-preferences`,
    {
      ...(prefs && typeof prefs === 'object' ? prefs : {}),
      segment: segment != null ? String(segment) : '',
      panelId: panelId != null && String(panelId).trim() ? String(panelId).trim() : 'main',
    },
    { headers: authHeaders() }
  );
  return response.data;
};

export const fetchDeviceDecodeConfig = async (deviceId) => {
  const response = await axios.get(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/decode-config`,
    { headers: authHeaders() }
  );
  return response.data;
};

/** Canal (FPort) y clase LoRaWAN persistidos para el dispositivo (usuario con dispositivo asignado). */
export const fetchDeviceLoraProfile = async (deviceId) => {
  const response = await axios.get(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/lora-profile`,
    { headers: authHeaders() }
  );
  return response.data;
};

/** Decoders Milesight (VS133, etc.) pueden ser ~20–50 KB; evitar cuelgue sin feedback en la UI. */
const DECODE_CONFIG_PUT_TIMEOUT_MS = 120000;

export const saveDeviceDecodeConfig = async (deviceId, payload) => {
  const response = await axios.put(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/decode-config`,
    payload,
    { headers: authHeaders(), timeout: DECODE_CONFIG_PUT_TIMEOUT_MS }
  );
  return response.data;
};

/** Gateways LoRaWAN registrados por cuenta (alta: admin/superadmin). */
export const fetchLorawanGateways = async () => {
  const response = await axios.get(`${SERVER_API}/lorawan-gateways`, { headers: authHeaders() });
  return Array.isArray(response.data) ? response.data : [];
};

export const createLorawanGateway = async ({ name, gatewayEui, frequencyBand }) => {
  const response = await axios.post(
    `${SERVER_API}/lorawan-gateways`,
    { name, gatewayEui, frequencyBand },
    { headers: authHeaders() }
  );
  return response.data;
};

export const deleteLorawanGateway = async (id) => {
  const response = await axios.delete(
    `${SERVER_API}/lorawan-gateways/${encodeURIComponent(id)}`,
    { headers: authHeaders() }
  );
  return response.data;
};

/** Evento local para toasts globales (p. ej. "Downlink enviado"). */
export const SYSCOM_LNS_DOWNLINK_SENT_EVENT = 'syscom-lns-downlink-sent';

export const fetchLnsUiEventsAfterId = async (afterId = 0) => {
  const q = new URLSearchParams({ afterId: String(afterId ?? 0) }).toString();
  const response = await axios.get(`${SERVER_API}/lns/ui-events?${q}`, { headers: authHeaders() });
  if (response.data?.status !== 'Success') {
    throw new Error(response.data?.errMsg || 'ui-events failed');
  }
  return Array.isArray(response.data?.events) ? response.data.events : [];
};

/**
 * @param {string} deviceId
 * @param {string} hex
 * @param {{ confirmed?: boolean, lorawanClass?: 'A'|'B'|'C', gatewayEui?: string, deferUntilUplink?: boolean }} [opts]
 *   `lorawanClass`: solo si debe forzarse en el cuerpo del POST; si se omite, el **servidor** resuelve A/B/C
 *   (alta `user_devices`, decode-config, sesión LNS). No se envía clase desde plantilla local para no tapar el alta en BD.
 *   `gatewayEui` (16 hex): cola PULL_RESP hacia ese gateway (debe estar dado de alta); corrige si `last_gateway` de sesión no coincide con el GW que hace PULL.
 *   `deferUntilUplink`: por defecto **true** — si el envío inmediato falla (p. ej. clase A sin ventana RX), el servidor encola para el próximo uplink.
 *   Use `false` solo si debe fallar con 400 sin cola (p. ej. pruebas con `SYSCOM_LNS_DEFER_APP_DOWNLINK=0` y sin encolar).
 */
export const sendDownlink = async (deviceId, hex, _credentials, _token, opts = {}) => {
  const raw = (hex || '').toString().trim();
  if (!raw) throw new Error('Downlink vacío');

  const cleanHex = raw.replace(/\s/g, '').toLowerCase().replace(/^0x/, '');
  const asServiceId = raw.replace(/\s/g, '');
  const isHexPayload = /^[0-9a-f]+$/i.test(cleanHex);

  if (isHexPayload) {
    try {
      const body = {
        payloadHex: cleanHex,
        /**
         * Por defecto **no confirmado**: Milesight UC/WS y documentación del fabricante recomiendan
         * `confirmed: false` para comandos DO / codec en FPort 85; el confirmado puede impedir que el nodo aplique el payload.
         * Forzar confirmado: `sendDownlink(..., { confirmed: true })`.
         */
        confirmed: opts?.confirmed === true,
        /** Medidores clase A: permite respuesta 202 y cola SQLite si la ventana RX ya cerró (anula SYSCOM_LNS_DEFER_APP_DOWNLINK=0). */
        deferUntilUplink: opts?.deferUntilUplink !== false,
      };
      if (opts?.priority != null && Number.isFinite(Number(opts.priority))) {
        body.priority = Math.max(0, Math.min(255, Math.floor(Number(opts.priority))));
      }
      if (opts?.lorawanClass != null && String(opts.lorawanClass).trim() !== '') {
        body.lorawanClass = normalizeTemplateLorawanClass(opts.lorawanClass);
      }
      if (opts?.gatewayEui) {
        const g = String(opts.gatewayEui).replace(/[^0-9a-fA-F]/gi, '').toLowerCase();
        if (g.length === 16) body.gatewayEui = g;
      }
      const response = await axios.post(
        `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/downlink`,
        body,
        { headers: authHeaders() }
      );
      try {
        const d = response.data || {};
        window.dispatchEvent(
          new CustomEvent(SYSCOM_LNS_DOWNLINK_SENT_EVENT, {
            detail: {
              deviceId,
              /** Hex normalizado (sin 0x); el dashboard alinea el Switch con downlinks de reglas u otros orígenes. */
              payloadHex: cleanHex,
              devEUI: d.devEUI ?? d.devEui,
              fCnt: d.fCnt,
              fPort: d.fPort,
              deviceClass: d.deviceClass,
              gatewayEui: d.gatewayEui,
              confirmed: d.confirmedDown,
              imme: d.imme,
              txScheduledTmst: d.txScheduledTmst,
              classARxWindow: d.classARxWindow,
              txAckPending: Boolean(d.txAckPending),
              txAckMaxWaitMs:
                d.txAckMaxWaitMs != null && Number.isFinite(Number(d.txAckMaxWaitMs))
                  ? Number(d.txAckMaxWaitMs)
                  : null,
              deferred: Boolean(d.deferred),
              deferredReason: d.deferredReason,
              pendingId: d.pendingId,
              pendingQueueLength: d.pendingQueueLength,
            },
          })
        );
      } catch {
        /* ignore (SSR) */
      }
      return response.data;
    } catch (err) {
      if (err.response?.status === 501) throw err;
      throw err;
    }
  }

  const serviceResp = await axios.post(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/services/call`,
    { serviceId: asServiceId, inputs: {} },
    { headers: authHeaders() }
  );
  if (serviceResp.data?.status !== 'Success') {
    throw new Error(serviceResp.data?.errMsg || 'Service call failed');
  }
  return serviceResp.data;
};

/** Catálogo global de plantillas (lectura: cualquier usuario autenticado; escritura: solo superadmin vía PUT). */
export const fetchDeviceTemplatesCatalog = async () => {
  const response = await axios.get(`${SERVER_API}/device-templates`, { headers: authHeaders() });
  return response.data;
};

export const putDeviceTemplatesCatalog = async (body) => {
  const response = await axios.put(`${SERVER_API}/device-templates`, body, {
    headers: authHeaders(),
    timeout: 180000,
  });
  return response.data;
};

/** Dispositivos con presets que referencian la plantilla: todos si tiene módulo Dispositivos; si no, solo los asignados a su cuenta. */
export const fetchAssignedDeviceIdsForTemplate = async (templateId) => {
  const q = encodeURIComponent(String(templateId || '').trim());
  const response = await axios.get(`${SERVER_API}/device-templates/assigned-device-ids?templateId=${q}`, {
    headers: authHeaders(),
    timeout: 45000,
  });
  return response.data;
};

export const fetchDeviceDownlinkPresets = async (deviceId) => {
  const response = await axios.get(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/downlink-presets`,
    { headers: authHeaders() }
  );
  return response.data;
};

export const putDeviceDownlinkPresets = async (deviceId, presets) => {
  const response = await axios.put(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/downlink-presets`,
    presets,
    { headers: authHeaders() }
  );
  return response.data;
};

/** Borra sesión OTAA del LNS integrado para este deviceId (requiere JWT). Útil si el servidor rechaza uplinks (MIC inválido). */
export const deleteLnsSession = async (deviceId) => {
  const response = await axios.delete(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/lns/session`,
    { headers: authHeaders() }
  );
  if (response.data?.status !== 'Success') {
    throw new Error(response.data?.errMsg || 'No se pudo borrar la sesión LNS');
  }
  return response.data;
};

/** AppKey / Join EUI (App EUI) en `user_devices` para OTAA con el LNS integrado (staff + dispositivo asignado). */
export const patchDeviceLoraCredentials = async (deviceId, body) => {
  const response = await axios.patch(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/lora-credentials`,
    body,
    { headers: authHeaders() }
  );
  if (response.data?.status !== 'Success') {
    throw new Error(response.data?.errMsg || response.data?.error || 'No se pudo actualizar credenciales LoRaWAN');
  }
  return response.data;
};
