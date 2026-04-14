import axios from 'axios';
import { getApiBase } from '../config/apiBase';

const SERVER_API = getApiBase();

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
  const response = await axios.put(
    `${SERVER_API}/devices`,
    { deviceId: deviceData.deviceId, name: deviceData.name },
    { headers: authHeaders() }
  );
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
  if (response.data.status !== 'Success') throw new Error(response.data.errMsg || 'History fetch failed');
  return response.data;
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

/** Alta de dispositivo en el sistema (solo super administrador). */
export const registerUserDevice = async (payload) => {
  const response = await axios.post(`${SERVER_API}/user-devices`, payload, { headers: authHeaders() });
  return response.data;
};

/** Avisos de licencia por vencer (≤7 días) para dispositivos asignados a la cuenta. */
export const fetchLicenseWarnings = async () => {
  const response = await axios.get(`${SERVER_API}/auth/license-warnings`, { headers: authHeaders() });
  return response.data?.warnings ?? [];
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

/** Quita el dispositivo solo de la cuenta del usuario autenticado. */
export const unassignMyDevice = async (deviceId) => {
  const response = await axios.delete(
    `${SERVER_API}/user-devices/${encodeURIComponent(deviceId)}`,
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

export const fetchDeviceDecodeConfig = async (deviceId) => {
  const response = await axios.get(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/decode-config`,
    { headers: authHeaders() }
  );
  return response.data;
};

export const saveDeviceDecodeConfig = async (deviceId, payload) => {
  const response = await axios.put(
    `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/decode-config`,
    payload,
    { headers: authHeaders() }
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
 * @param {{ confirmed?: boolean }} [opts]
 */
export const sendDownlink = async (deviceId, hex, _credentials, _token, opts = {}) => {
  const raw = (hex || '').toString().trim();
  if (!raw) throw new Error('Downlink vacío');

  const cleanHex = raw.replace(/\s/g, '').toLowerCase().replace(/^0x/, '');
  const asServiceId = raw.replace(/\s/g, '');
  const isHexPayload = /^[0-9a-f]+$/i.test(cleanHex);

  if (isHexPayload) {
    try {
      const response = await axios.post(
        `${SERVER_API}/devices/${encodeURIComponent(deviceId)}/downlink`,
        {
          payloadHex: cleanHex,
          confirmed: Boolean(opts?.confirmed),
        },
        { headers: authHeaders() }
      );
      try {
        window.dispatchEvent(
          new CustomEvent(SYSCOM_LNS_DOWNLINK_SENT_EVENT, {
            detail: { deviceId, fCnt: response.data?.fCnt },
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
