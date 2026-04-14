/**
 * Cliente para la API REST del gateway Milesight UG65/UG67 (puerto 8080).
 * Documentación: login /api/internal/login, JWT ~24 h.
 */

const http = require('http');
const https = require('https');

/** @typedef {{ baseUrl: string, apiUsername?: string, apiPassword?: string, rejectUnauthorized?: boolean }} MilesightUgConfig */

function normalizeBaseUrl(baseUrl) {
  let s = String(baseUrl || '').trim();
  if (!s) return '';
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

const jwtCache = new Map();

function cacheKey(userId, baseUrl) {
  return `${userId}|${normalizeBaseUrl(baseUrl)}`;
}

function buildAgent(config) {
  const insecure = config.rejectUnauthorized === false;
  if (insecure) {
    return new https.Agent({ rejectUnauthorized: false });
  }
  return undefined;
}

/**
 * @param {MilesightUgConfig} config
 * @param {string} method
 * @param {string} pathname path + query, p. ej. /api/devices?limit=10
 * @param {string|null} body
 * @param {string|null} jwt
 */
function rawRequest(config, method, pathname, body, jwt) {
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
    const headers = {
      Accept: 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    };
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
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_) {
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

async function loginToGateway(config) {
  const username = config.apiUsername != null ? config.apiUsername : 'apiuser';
  const password = config.apiPassword != null ? config.apiPassword : '';
  const body = JSON.stringify({ username, password });
  const r = await rawRequest(config, 'POST', '/api/internal/login', body, null);
  if (r.status !== 200 || !r.json || !r.json.jwt) {
    const err = new Error((r.json && r.json.error) || r.text || `Login gateway HTTP ${r.status}`);
    err.status = r.status;
    err.body = r.json || r.text;
    throw err;
  }
  return r.json.jwt;
}

/**
 * @param {string} userId
 * @param {MilesightUgConfig} config
 */
async function ensureJwt(userId, config) {
  const key = cacheKey(userId, config.baseUrl);
  const now = Date.now();
  const hit = jwtCache.get(key);
  if (hit && hit.expiresAt > now + 60_000) return hit.jwt;
  const jwt = await loginToGateway(config);
  jwtCache.set(key, { jwt, expiresAt: now + 23 * 60 * 60 * 1000 });
  return jwt;
}

function invalidateJwt(userId, baseUrl) {
  jwtCache.delete(cacheKey(userId, baseUrl));
}

/**
 * @param {string} userId
 * @param {MilesightUgConfig} config
 * @param {string} method
 * @param {string} pathname
 * @param {object|null} [bodyObj]
 */
async function ugJsonRequest(userId, config, method, pathname, bodyObj) {
  const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
  let jwt = await ensureJwt(userId, config);
  let r = await rawRequest(config, method, pathname, body, jwt);
  if (r.status === 401) {
    invalidateJwt(userId, config.baseUrl);
    jwt = await ensureJwt(userId, config);
    r = await rawRequest(config, method, pathname, body, jwt);
  }
  return r;
}

/**
 * Reenvía el stream GET /api/urpackets al response Express.
 * @param {string} userId
 * @param {MilesightUgConfig} config
 * @param {import('http').ServerResponse} res
 */
function streamUrpackets(userId, config, res) {
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) return Promise.reject(new Error('baseUrl vacío'));

  return ensureJwt(userId, config).then((jwt) => {
    const target = new URL('/api/urpackets', `${base}/`);
    const lib = target.protocol === 'https:' ? https : http;
    const agent = target.protocol === 'https:' ? buildAgent(config) : undefined;

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: target.pathname + target.search,
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${jwt}` },
          agent,
        },
        (gwRes) => {
          res.status(gwRes.statusCode || 502);
          const forward = ['content-type', 'content-length', 'transfer-encoding', 'cache-control'];
          forward.forEach((h) => {
            const v = gwRes.headers[h];
            if (v) res.setHeader(h, v);
          });
          gwRes.pipe(res);
          gwRes.on('end', () => resolve());
          gwRes.on('error', reject);
        }
      );
      req.on('error', reject);
      req.end();
    });
  });
}

module.exports = {
  normalizeBaseUrl,
  loginToGateway,
  ensureJwt,
  invalidateJwt,
  ugJsonRequest,
  streamUrpackets,
};
