/**
 * Cliente API Milesight EG71 (REST + CGI).
 * - REST: JWT vía POST /api/internal/login (contraseña AES-128-CBC + Base64).
 * - CGI: token `Bearer login=<user>;<td>` vía POST /cgi core=user function=login.
 * - CGI: espaciar peticiones ≥500 ms (rate limit del firmware).
 * Los downlinks LoRaWAN de la app siguen yendo al LNS integrado (Semtech UDP), no al EG71 REST.
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const AES_KEY = Buffer.from('4829173051647823', 'utf8');
const AES_IV = Buffer.from('7603912845091736', 'utf8');
const CGI_MIN_INTERVAL_MS = 500;

/** @typedef {{ baseUrl: string, apiUsername?: string, apiPassword?: string, rejectUnauthorized?: boolean }} Eg71Config */

const jwtCache = new Map();
const cgiTokenCache = new Map();
const lastCgiAt = new Map();
const cgiChains = new Map();

function normalizeBaseUrl(baseUrl) {
  let s = String(baseUrl || '').trim();
  if (!s) return '';
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function cacheKey(userId, baseUrl) {
  return `${userId}|${normalizeBaseUrl(baseUrl)}`;
}

function buildAgent(config) {
  if (config.rejectUnauthorized === false) {
    return new https.Agent({ rejectUnauthorized: false });
  }
  return undefined;
}

function encryptEg71Password(plainPassword) {
  const plain = String(plainPassword ?? '');
  const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return enc.toString('base64');
}

/**
 * @param {Eg71Config} config
 * @param {string} method
 * @param {string} pathname path + query
 * @param {string|null} body
 * @param {string|null} authHeader valor completo Authorization (JWT o login=user;td)
 */
function rawRequest(config, method, pathname, body, authHeader) {
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) return Promise.reject(new Error('baseUrl vacío'));

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, `${base}/`);
    } catch (e) {
      reject(e);
      return;
    }

    const lib = target.protocol === 'https:' ? https : http;
    const agent = target.protocol === 'https:' ? buildAgent(config) : undefined;
    const headers = { Accept: 'application/json' };
    if (authHeader) headers.Authorization = authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`;
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
    }

    const req = lib.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers,
        agent,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (body != null) req.write(body, 'utf8');
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loginJwt(config) {
  const username = config.apiUsername != null ? String(config.apiUsername) : 'admin';
  const password = config.apiPassword != null ? String(config.apiPassword) : '';
  const body = JSON.stringify({
    username,
    password: encryptEg71Password(password),
  });
  const r = await rawRequest(config, 'POST', '/api/internal/login', body, null);
  if (r.status !== 200 || !r.json || !r.json.jwt) {
    const err = new Error((r.json && (r.json.errMsg || r.json.error)) || r.text || `Login JWT HTTP ${r.status}`);
    err.status = r.status;
    err.body = r.json || r.text;
    throw err;
  }
  return r.json.jwt;
}

async function loginCgi(config) {
  const username = config.apiUsername != null ? String(config.apiUsername) : 'admin';
  const password = config.apiPassword != null ? String(config.apiPassword) : '';
  const body = JSON.stringify({
    execute: 1,
    core: 'user',
    function: 'login',
    values: [{ username, password: encryptEg71Password(password) }],
    id: 5,
  });
  const r = await rawRequest(config, 'POST', '/cgi', body, null);
  if (r.status !== 200 || !r.json || Number(r.json.status) !== 0) {
    const err = new Error(
      (r.json && r.json.result && r.json.result[0] && r.json.result[0].message) ||
        r.text ||
        `Login CGI HTTP ${r.status}`
    );
    err.status = r.status;
    err.body = r.json || r.text;
    throw err;
  }
  const row = Array.isArray(r.json.result) ? r.json.result[0] : null;
  const td = row && row.td != null ? String(row.td) : '';
  const user = row && row.username != null ? String(row.username) : username;
  if (!td) {
    const err = new Error('Login CGI: respuesta sin token td');
    err.body = r.json;
    throw err;
  }
  return { auth: `login=${user};${td}`, username: user, td };
}

async function ensureJwt(userId, config) {
  const key = cacheKey(userId, config.baseUrl);
  const now = Date.now();
  const hit = jwtCache.get(key);
  if (hit && hit.expiresAt > now + 60_000) return hit.jwt;
  const jwt = await loginJwt(config);
  jwtCache.set(key, { jwt, expiresAt: now + 23 * 60 * 60 * 1000 });
  return jwt;
}

async function ensureCgiAuth(userId, config) {
  const key = cacheKey(userId, config.baseUrl);
  const now = Date.now();
  const hit = cgiTokenCache.get(key);
  if (hit && hit.expiresAt > now + 60_000) return hit.auth;
  const login = await loginCgi(config);
  cgiTokenCache.set(key, { auth: login.auth, expiresAt: now + 55 * 60 * 1000 });
  return login.auth;
}

function invalidateTokens(userId, baseUrl) {
  const key = cacheKey(userId, baseUrl);
  jwtCache.delete(key);
  cgiTokenCache.delete(key);
  lastCgiAt.delete(key);
  cgiChains.delete(key);
}

async function runCgiQueued(userId, config, fn) {
  const key = cacheKey(userId, config.baseUrl);
  const prev = cgiChains.get(key) || Promise.resolve();
  const job = prev
    .catch(() => {})
    .then(async () => {
      const now = Date.now();
      const last = lastCgiAt.get(key) || 0;
      const wait = Math.max(0, CGI_MIN_INTERVAL_MS - (now - last));
      if (wait > 0) await sleep(wait);
      lastCgiAt.set(key, Date.now());
      return fn();
    });
  cgiChains.set(key, job.catch(() => {}));
  return job;
}

/**
 * @param {string} userId
 * @param {Eg71Config} config
 * @param {string} method
 * @param {string} pathname
 * @param {object|null} [bodyObj]
 */
async function eg71JsonRequest(userId, config, method, pathname, bodyObj) {
  const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
  let jwt = await ensureJwt(userId, config);
  let r = await rawRequest(config, method, pathname, body, jwt);
  if (r.status === 401) {
    invalidateTokens(userId, config.baseUrl);
    jwt = await ensureJwt(userId, config);
    r = await rawRequest(config, method, pathname, body, jwt);
  }
  return r;
}

/**
 * @param {string} userId
 * @param {Eg71Config} config
 * @param {object} cgiBody
 */
async function eg71CgiRequest(userId, config, cgiBody) {
  return runCgiQueued(userId, config, async () => {
    let auth = await ensureCgiAuth(userId, config);
    const body = JSON.stringify(cgiBody);
    let r = await rawRequest(config, 'POST', '/cgi', body, auth);
    if (r.status === 401 || (r.json && Number(r.json.status) === -2 && !cgiBody?.function?.includes?.('login'))) {
      invalidateTokens(userId, config.baseUrl);
      auth = await ensureCgiAuth(userId, config);
      r = await rawRequest(config, 'POST', '/cgi', body, auth);
    }
    return r;
  });
}

async function probeEg71Gateway(config) {
  const jwt = await loginJwt(config);
  let model = 'EG71';
  try {
    const r = await rawRequest(config, 'POST', '/islogin', null, jwt);
    if (r.json && r.json.model) model = String(r.json.model);
  } catch {
    /* opcional */
  }
  return { ok: true, model, message: 'Login EG71 correcto' };
}

/** Peticiones típicas al abrir la UI del EG71 (inicialización). */
async function eg71PageInitBundle(userId, config) {
  const jwt = await ensureJwt(userId, config);
  const islogin = await rawRequest(config, 'POST', '/islogin', null, jwt);
  const accessInfo = await rawRequest(config, 'GET', '/api/general-info/interface/with-access-info', null, jwt);

  const cgiSecurity = await eg71CgiRequest(userId, config, {
    execute: 1,
    core: 'yruo_usermanagement',
    function: 'get',
    values: [{ base: 'security' }],
    id: 1,
  });
  const cgiGeneral = await eg71CgiRequest(userId, config, {
    execute: 1,
    core: 'yruo_system',
    function: 'get',
    values: [{ base: 'general' }],
    id: 2,
  });
  const cgiDashboard = await eg71CgiRequest(userId, config, {
    execute: 1,
    core: 'yruo_status',
    function: 'get',
    values: [{ base: 'dashboard' }],
    id: 3,
  });

  return { islogin, accessInfo, cgiSecurity, cgiGeneral, cgiDashboard };
}

module.exports = {
  normalizeBaseUrl,
  encryptEg71Password,
  loginJwt,
  loginCgi,
  ensureJwt,
  ensureCgiAuth,
  invalidateTokens,
  eg71JsonRequest,
  eg71CgiRequest,
  probeEg71Gateway,
  eg71PageInitBundle,
  CGI_MIN_INTERVAL_MS,
};
