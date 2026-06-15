import axios from 'axios';
import { getApiBase } from '../config/apiBase';
import { getAuthToken } from './localAuth';

const SERVER_API = getApiBase();

const authHeaders = () => ({
  Authorization: `Bearer ${getAuthToken()}`,
  'Content-Type': 'application/json',
});

/** Prueba conexión EG71 (credenciales en el body). */
export async function probeEg71Gateway(payload) {
  const response = await axios.post(`${SERVER_API}/milesight-eg71-gateway/probe`, payload, {
    headers: authHeaders(),
  });
  return response.data;
}

/** Prueba con credenciales guardadas en el perfil del usuario. */
export async function probeEg71GatewaySaved() {
  const response = await axios.post(`${SERVER_API}/milesight-eg71-gateway/probe-saved`, {}, {
    headers: authHeaders(),
  });
  return response.data;
}

/** POST /islogin en el EG71. */
export async function eg71IsLogin() {
  const response = await axios.post(`${SERVER_API}/milesight-eg71-gateway/islogin`, {}, {
    headers: authHeaders(),
  });
  return response.data;
}

/** Bundle de inicialización (islogin, access-info, CGI dashboard, etc.). */
export async function eg71PageInit() {
  const response = await axios.get(`${SERVER_API}/milesight-eg71-gateway/page-init`, {
    headers: authHeaders(),
  });
  return response.data;
}

/** Proxy CGI genérico (respeta rate limit ≥500 ms en servidor). */
export async function eg71CgiRequest(cgiBody) {
  const response = await axios.post(`${SERVER_API}/milesight-eg71-gateway/cgi`, cgiBody, {
    headers: authHeaders(),
  });
  return response.data;
}

/**
 * Proxy REST genérico hacia el EG71.
 * @param {{ method?: string, path: string, body?: object }} payload
 */
export async function eg71RestRequest(payload) {
  const response = await axios.post(`${SERVER_API}/milesight-eg71-gateway/rest`, payload, {
    headers: authHeaders(),
  });
  return response.data;
}

export async function eg71ListDevices(body = {}) {
  const response = await axios.post(`${SERVER_API}/milesight-eg71-gateway/devices/list`, body, {
    headers: authHeaders(),
  });
  return response.data;
}

export async function eg71AccessNetwork() {
  const response = await axios.get(`${SERVER_API}/milesight-eg71-gateway/access-network`, {
    headers: authHeaders(),
  });
  return response.data;
}

export async function eg71PayloadCodecsShort(params = '') {
  const q = params ? (params.startsWith('?') ? params : `?${params}`) : '';
  const response = await axios.get(`${SERVER_API}/milesight-eg71-gateway/payloadcodecs-short${q}`, {
    headers: authHeaders(),
  });
  return response.data;
}

export async function eg71UrProfiles(params = '') {
  const q = params ? (params.startsWith('?') ? params : `?${params}`) : '';
  const response = await axios.get(`${SERVER_API}/milesight-eg71-gateway/urprofiles${q}`, {
    headers: authHeaders(),
  });
  return response.data;
}

export async function eg71DataForwardingRules() {
  const response = await axios.get(`${SERVER_API}/milesight-eg71-gateway/dsforward`, {
    headers: authHeaders(),
  });
  return response.data;
}
