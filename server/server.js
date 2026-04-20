const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeLorawanUplink, expandLorawanPacketBodies } = require('./lns/lorawan-normalize');
const { tryApplyStoredDecoder, promoteUc300GpioFromChannelHistory } = require('./decoders/payload-decoder');
const { resolveAppFPortForDownlink } = require('./lib/resolve-app-fport');
const {
  normalizeBaseUrl: ugNormalizeBaseUrl,
  ugJsonRequest,
  streamUrpackets,
  loginToGateway,
  invalidateJwt,
} = require('./integrations/milesight/milesight-ug-gateway-client');
const {
  publishDownlink,
  publishNsRequestAndWait,
  getMqttApiStatus,
} = require('./integrations/milesight/milesight-mqtt-publisher');
const { store, isEnsuredSuperadminEmail } = require('./store');
const { validatePasswordStrength } = require('./middleware/password-policy');
const {
  isAllowedGatewayFrequencyBand,
  normalizeGatewayFrequencyBand,
} = require('./lns/lorawan-gateway-bands');
const metrics = require('./monitoring/syscom-metrics');
const { createRealtimeHub } = require('./realtime/realtime-hub');
const { sanitizeTelemetryForSse } = require('./telemetry-sse-sanitize');
const { createRateLimiter } = require('./middleware/rate-limit-memory');
const { fixUtf8Mojibake } = require('./lib/fixUtf8Mojibake');

const realtimeHub = createRealtimeHub();
const loginRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Math.min(200, Math.max(10, parseInt(process.env.SYSCOM_LOGIN_RATE_MAX || '40', 10) || 40)),
  onReject: () => metrics.inc('rate_limit_reject'),
});
const ingestRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: Math.min(5000, Math.max(60, parseInt(process.env.SYSCOM_INGEST_RATE_MAX || '600', 10) || 600)),
  onReject: () => metrics.inc('rate_limit_reject'),
});

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
if (IS_PRODUCTION && !process.env.JWT_SECRET) {
  console.error(
    '[syscom-iot] En NODE_ENV=production debe definir JWT_SECRET (cadena larga y aleatoria, p. ej. openssl rand -hex 32).'
  );
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'syscom-iot-dev-insecure-jwt-secret-change-me';

/** Cadena `expiresIn` de jsonwebtoken (p. ej. `90d`, `8h`). Por defecto sesión larga para monitoreo / kiosco. */
function syscomJwtExpiresIn() {
  const v = process.env.SYSCOM_JWT_EXPIRES;
  if (v != null && String(v).trim() !== '') return String(v).trim();
  return '90d';
}

/** Tras caducar el `exp` del JWT, se acepta refresh (y SSE con token en query) hasta este margen. */
function syscomJwtRefreshGraceMs() {
  const n = parseInt(process.env.SYSCOM_JWT_REFRESH_GRACE_MS, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return 30 * 24 * 60 * 60 * 1000;
}

function signSessionJwt(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: syscomJwtExpiresIn() });
}

/**
 * Verifica Bearer y asigna req.user. Caducado: solo en POST /auth/first-password aplica ventana de gracia
 * (usuario con cambio de contraseña obligatorio puede completar el flujo con JWT vencido reciente).
 */
function verifyBearerForAuthMiddleware(req, token) {
  const p = req.path || '';
  const firstPwPath =
    req.method === 'POST' && (p === '/api/auth/first-password' || p.endsWith('/auth/first-password'));
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return true;
  } catch (e) {
    if (e?.name === 'TokenExpiredError' && firstPwPath) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
        const expMs = decoded.exp != null ? Number(decoded.exp) * 1000 : 0;
        if (!expMs || Date.now() > expMs + syscomJwtRefreshGraceMs()) {
          return false;
        }
        req.user = decoded;
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * CORS: en desarrollo por defecto `*`. En producción use SYSCOM_CORS_ORIGINS (lista separada por comas) o `*` explícito.
 * Peticiones sin cabecera Origin (gateways, curl) se aceptan cuando hay lista explícita.
 */
function buildCorsOptions() {
  const raw = process.env.SYSCOM_CORS_ORIGINS;
  const trimmed = raw != null ? String(raw).trim() : '';
  if (trimmed === '*') return { origin: '*' };
  if (trimmed !== '') {
    const allowed = trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        callback(null, allowed.includes(origin));
      },
    };
  }
  if (IS_PRODUCTION) {
    console.warn(
      '[syscom-iot] SYSCOM_CORS_ORIGINS no definido: reflejando Origin (cualquier sitio puede usar la API desde navegador). Defina SYSCOM_CORS_ORIGINS=https://su-dominio.com'
    );
    return { origin: true };
  }
  return { origin: '*' };
}

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
/** Puerto opcional dedicado a ingesta (gateway → POST /ingest/:userId/:token). Si no se define, solo existe /api/ingest/... en PORT. */
const INGEST_PORT = process.env.INGEST_PORT ? parseInt(process.env.INGEST_PORT, 10) : null;
/**
 * Puerto UDP Semtech GWMP (packet forwarder). Por defecto **1700** (LNS activo sin checklist).
 * Desactivar solo en entornos sin UDP entrante: `LNS_UDP_PORT=0` o `off` / `false` / `disabled`.
 * Si el puerto UDP está ocupado, el proceso **no** termina: el listener UDP se reintenta cada `LNS_UDP_BIND_RETRY_MS` (def. 30000).
 */
function resolveLnsUdpPort() {
  const raw = process.env.LNS_UDP_PORT;
  if (raw === undefined || raw === null) return 1700;
  const t = String(raw).trim();
  if (t === '') return 1700;
  const tl = t.toLowerCase();
  if (tl === '0' || tl === 'off' || tl === 'false' || tl === 'disabled' || tl === 'none') return null;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    console.warn(`[LNS] LNS_UDP_PORT="${t}" inválido; usando 1700.`);
    return 1700;
  }
  return n;
}
const LNS_UDP_PORT = resolveLnsUdpPort();
const RETENTION_MS =
  parseInt(process.env.SYSCOM_TELEMETRY_RETENTION_MS, 10) || 365 * 24 * 60 * 60 * 1000;
/** Política fija: 40 min sin nueva telemetría → OFFLINE en listados (override: SYSCOM_DEVICE_STALE_OFFLINE_MS). */
const DEVICE_STALE_OFFLINE_MS =
  parseInt(process.env.SYSCOM_DEVICE_STALE_OFFLINE_MS, 10) || 40 * 60 * 1000;

const TSL_IGNORE = new Set([
  'rpsStatus', 'model', 'hardwareVersion', 'firmwareVersion', 'lastUpdateTime', 'application',
  'licenseStatus', 'deviceType', 'tag', 'devEUI', 'connectStatus', 'deviceId', 'sn', 'userId', 'id',
  'deviceName', 'timestamp', 'mac', 'imei', 'devEui', 'deviceSn', 'fpt',
  'nwkSKey', 'appSKey', 'appsKey', 'nwk_s_key', 'app_s_key', 'apps_key',
]);

function isBufferLikeValue(v) {
  if (v == null) return false;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  if (v.type === 'Buffer' && Array.isArray(v.data)) return true;
  return false;
}

/** Claves anidadas tipo `a.b` para selectores de widget / TSL */
function flattenTelemetryProps(obj) {
  const out = {};
  function walk(o, prefix) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) {
      if (TSL_IGNORE.has(k)) continue;
      if (isBufferLikeValue(v)) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v, key);
      } else {
        if (isBufferLikeValue(v)) continue;
        out[key] = v;
      }
    }
  }
  walk(obj, '');
  return out;
}

const DASHBOARD_WIDGET_TYPES = new Set([
  'value',
  'highlight',
  'gauge',
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'radar',
  'heatmap',
  'treemap',
  'funnel',
  'waterfall',
  'histogram',
]);
const DASHBOARD_MAX_WIDGETS = 48;

function sanitizeDashboardWidget(w) {
  const title = String(w.title || '').trim();
  const propertyKey = String(w.propertyKey || '').trim();
  const unit = w.unit != null ? String(w.unit).slice(0, 32) : '';
  const accentRaw = String(w.accent || '').toLowerCase();
  const accent = ['orange', 'green', 'blue'].includes(accentRaw) ? accentRaw : '';
  let gaugeMin = Number(w.gaugeMin);
  let gaugeMax = Number(w.gaugeMax);
  if (!Number.isFinite(gaugeMin)) gaugeMin = 0;
  if (!Number.isFinite(gaugeMax)) gaugeMax = 100;
  if (gaugeMax <= gaugeMin) gaugeMax = gaugeMin + 1;
  let historyHours = Number(w.historyHours);
  if (!Number.isFinite(historyHours) || historyHours < 1) historyHours = 24;
  if (historyHours > 168) historyHours = 168;
  return {
    id: String(w.id || '').trim(),
    type: w.type,
    title,
    propertyKey,
    unit,
    accent,
    gaugeMin,
    gaugeMax,
    historyHours,
  };
}

function validateDashboardWidgets(body) {
  const widgets = body && body.widgets;
  if (!Array.isArray(widgets)) return { error: 'widgets debe ser un array' };
  if (widgets.length > DASHBOARD_MAX_WIDGETS) {
    return { error: `Máximo ${DASHBOARD_MAX_WIDGETS} widgets` };
  }
  const seen = new Set();
  for (let i = 0; i < widgets.length; i++) {
    const w = widgets[i];
    if (!w || typeof w !== 'object') return { error: `Widget ${i + 1}: objeto inválido` };
    const id = String(w.id || '').trim();
    if (!id) return { error: `Widget ${i + 1}: id requerido` };
    if (seen.has(id)) return { error: 'ids de widget duplicados' };
    seen.add(id);
    if (!DASHBOARD_WIDGET_TYPES.has(w.type)) {
      return { error: `Widget ${i + 1}: type de widget no válido` };
    }
    const title = String(w.title || '').trim();
    if (!title) return { error: `Widget ${i + 1}: title requerido` };
    const propertyKey = String(w.propertyKey || '').trim();
    if (!propertyKey) return { error: `Widget ${i + 1}: propertyKey requerido` };
    if (propertyKey.length > 200) return { error: `Widget ${i + 1}: propertyKey demasiado largo` };
  }
  return { ok: true, widgets: widgets.map(sanitizeDashboardWidget) };
}

app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '2mb' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido en la petición' });
  }
  next(err);
});

// ── Logger HTTP ────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const SKIP_LOG = new Set(['/api/events/stream', '/health', '/api/health']);

function statusColor(s) {
  if (s >= 500) return C.red + C.bold;
  if (s >= 400) return C.yellow;
  if (s >= 300) return C.cyan;
  return C.green;
}

app.use((req, res, next) => {
  if (SKIP_LOG.has(req.path)) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    const sc = statusColor(res.statusCode);
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(
      `${C.gray}${ts}${C.reset} ${C.bold}${req.method.padEnd(6)}${C.reset} ${sc}${res.statusCode}${C.reset} ${req.path} ${C.dim}${ms}ms${C.reset}`
    );
    if (res.statusCode >= 400) {
      const body = req.body && Object.keys(req.body).length
        ? JSON.stringify({ ...req.body, password: req.body.password ? '***' : undefined })
        : '(sin body)';
      console.error(`${C.gray}       body: ${body}${C.reset}`);
    }
  });
  next();
});

// ── Persistencia: SQLite (server/store.js), escala a miles de sensores ──
const DEBUG_WEBHOOK_RING = [];
const DEBUG_WEBHOOK_MAX = 20;

function pushDebugWebhook(entry) {
  DEBUG_WEBHOOK_RING.push(entry);
  if (DEBUG_WEBHOOK_RING.length > DEBUG_WEBHOOK_MAX) DEBUG_WEBHOOK_RING.shift();
}

function appendDownlinkLog(userId, fields) {
  store.appendDownlinkLog(userId, fields);
}

/** Excluye pseudo-dispositivos de telemetría LoRaWAN (p. ej. `gateway-<EUI>`) del listado de Dispositivos. */
function isGatewayPseudoDeviceId(deviceId) {
  const id = String(deviceId || '').trim().toLowerCase();
  if (!id.startsWith('gateway-')) return false;
  const hex = id.slice(8);
  return /^[0-9a-f]{8,32}$/.test(hex);
}

/** Uplink Semtech sin OTAA: `devaddr-*` u otras claves que no son nodos dados de alta. */
function isEphemeralLorawanPseudoDeviceId(deviceId) {
  const s = String(deviceId || '').trim().toLowerCase();
  if (s.startsWith('devaddr-')) return true;
  if (/^gateway-[0-9a-f]{8,32}$/.test(s)) return true;
  return false;
}

/**
 * Filtro por etiqueta de producto (`user_devices.tag`).
 * Por defecto (sin env): solo `uc300` y `ws101`.
 * `SYSCOM_DEVICE_TAG_ALLOWLIST=*` o cadena vacía: sin filtro por tag.
 */
function getDeviceTagAllowlistSet() {
  const raw = process.env.SYSCOM_DEVICE_TAG_ALLOWLIST;
  if (raw === undefined) return new Set(['uc300', 'ws101']);
  const s = String(raw).trim();
  if (s === '' || s === '*') return null;
  return new Set(s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
}

function userDevicePassesProductTagFilter(ud) {
  const allow = getDeviceTagAllowlistSet();
  if (!allow) return true;
  const tag = String(ud.tag || '').trim().toLowerCase();
  return allow.has(tag);
}

/** Último ts de ingesta en BD para el usuario; si es antiguo, forzar OFFLINE en el listado. */
function applyStaleOfflineFromTelemetryRow(row, telemetryRow) {
  if (!telemetryRow || telemetryRow.timestamp == null) return;
  const ts = Number(telemetryRow.timestamp);
  if (!Number.isFinite(ts)) return;
  if (Date.now() - ts > DEVICE_STALE_OFFLINE_MS) {
    row.connectStatus = 'OFFLINE';
  }
}

function attachLicenseFieldsToDeviceRow(row) {
  const did = row && row.deviceId;
  if (!did) return;
  store.ensureDeviceLicenseIfMissing(did);
  const m = store.getDeviceLicenseMeta(did);
  if (!m) return;
  row.licenseStartedAt = m.startedAt;
  row.licenseExpiresAt = m.expiresAt;
  row.licensePurgeAt = m.purgeAt;
  row.licenseExpiredForUsers = m.expiredForUsers;
  row.licenseInSuperadminGrace = m.inSuperadminGrace;
}

/**
 * Admin y usuario: solo dispositivos explícitamente asignados (user_devices).
 * No se listan equipos que solo tengan telemetría huérfana bajo su user_id.
 */
function buildDevicesContentAssignedOnly(userId) {
  const latestMap = store.getLatestMap(userId);
  const labels = store.getDeviceLabels(userId);
  const labelById = Object.fromEntries(labels.map((l) => [l.deviceId, l.displayName]));
  const registered = store.listUserDevices(userId);

  const mapTelemetryRow = (t) => {
    const p = t.properties || {};
    const name = labelById[t.deviceId] || t.deviceName || p.deviceName || t.deviceId;
    return {
      deviceId: t.deviceId,
      name,
      sn: p.sn || p.deviceSn || t.deviceId,
      model: p.model || '',
      connectStatus: p.connectStatus || p.status,
      electricity: p.electricity,
      rssi: p.rssi,
      lastUpdateTime: p.lastUpdateTime || t.timestamp,
      ...p,
      name,
    };
  };

  const content = [];
  for (const reg of registered) {
    if (isGatewayPseudoDeviceId(reg.deviceId)) continue;
    if (isEphemeralLorawanPseudoDeviceId(reg.deviceId)) continue;
    if (!userDevicePassesProductTagFilter(reg)) continue;
    if (!store.isLicenseActiveForEndUser(reg.deviceId)) continue;
    const t = latestMap[reg.deviceId];
    if (t) {
      const row = mapTelemetryRow(t);
      applyStaleOfflineFromTelemetryRow(row, t);
      if (reg.displayName) row.name = reg.displayName;
      if (reg.devEUI && !row.devEUI && !row.devEui) row.devEUI = reg.devEUI;
      row.registered = true;
      attachLicenseFieldsToDeviceRow(row);
      content.push(row);
    } else {
      const row = {
        deviceId: reg.deviceId,
        name: reg.displayName || reg.deviceId,
        sn: reg.devEUI || reg.deviceId,
        model: '',
        connectStatus: 'Sin telemetría',
        registered: true,
        registeredOnly: true,
        lastUpdateTime: null,
        devEUI: reg.devEUI || undefined,
        notes: reg.notes || undefined,
      };
      attachLicenseFieldsToDeviceRow(row);
      content.push(row);
    }
  }
  return content;
}

/** Vista global para superadmin: todos los dispositivos + asignaciones (correo / rol). */
function buildDevicesContentSuperadmin() {
  const latestMap = store.getGlobalLatestMap();
  const udList = store.listUserDevicesWithAccounts();
  const labelsByDevice = store.getAllLabelsGroupedByDevice();

  const udFiltered = udList.filter(
    (u) =>
      !isGatewayPseudoDeviceId(u.deviceId) &&
      !isEphemeralLorawanPseudoDeviceId(u.deviceId) &&
      userDevicePassesProductTagFilter(u)
  );

  const assignByDevice = {};
  for (const u of udFiltered) {
    if (!assignByDevice[u.deviceId]) assignByDevice[u.deviceId] = [];
    assignByDevice[u.deviceId].push({
      email: u.email,
      role: u.role,
      userId: u.userId,
      displayName: u.displayName,
    });
  }

  const deviceIds = new Set(udFiltered.map((u) => u.deviceId));

  const mapTelemetryRow = (t) => {
    const p = t.properties || {};
    const name = t.deviceName || p.deviceName || t.deviceId;
    return {
      deviceId: t.deviceId,
      name,
      sn: p.sn || p.deviceSn || t.deviceId,
      model: p.model || '',
      connectStatus: p.connectStatus || p.status,
      electricity: p.electricity,
      rssi: p.rssi,
      lastUpdateTime: p.lastUpdateTime || t.timestamp,
      ...p,
      name,
    };
  };

  const content = [];
  for (const deviceId of deviceIds) {
    if (isGatewayPseudoDeviceId(deviceId)) continue;
    if (isEphemeralLorawanPseudoDeviceId(deviceId)) continue;
    const t = latestMap[deviceId];
    const assigns = assignByDevice[deviceId] || [];
    const labelOpts = labelsByDevice[deviceId] || [];
    const reg0 = assigns[0];

    let row;
    if (t) {
      row = mapTelemetryRow(t);
      applyStaleOfflineFromTelemetryRow(row, t);
      const lbl = labelOpts.find((l) => assigns.some((a) => a.userId === l.userId));
      if (lbl) row.name = lbl.displayName;
      else if (reg0 && reg0.displayName) row.name = reg0.displayName;
    } else {
      row = {
        deviceId,
        name: (reg0 && reg0.displayName) || deviceId,
        sn: deviceId,
        model: '',
        connectStatus: 'Sin telemetría',
        registeredOnly: true,
        lastUpdateTime: null,
      };
    }
    row.registered = assigns.length > 0;
    row.assignments = assigns.map((a) => ({ email: a.email, role: a.role, displayName: a.displayName }));
    row.superadminGlobalView = true;
    attachLicenseFieldsToDeviceRow(row);
    content.push(row);
  }
  content.sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)));
  return content;
}

function isStaffRole(role) {
  return role === 'superadmin' || role === 'admin';
}

/** Super admin puede operar con cualquier deviceId; resto solo si consta en user_devices. */
function assertDeviceAssignedToUser(req, res, deviceIdParam) {
  const role = req.user.role;
  if (role === 'superadmin') return true;
  const did = decodeURIComponent(String(deviceIdParam || '').trim());
  if (!did) {
    res.status(400).json({ error: 'deviceId requerido' });
    return false;
  }
  if (!store.getUserDevice(req.user.id, did)) {
    res.status(403).json({ error: 'Dispositivo no asignado a su cuenta' });
    return false;
  }
  if (!store.isLicenseActiveForEndUser(did)) {
    res.status(403).json({ error: 'La licencia de este dispositivo ha vencido' });
    return false;
  }
  return true;
}

function deviceAssignmentMiddleware(req, res, next) {
  if (!assertDeviceAssignedToUser(req, res, req.params.deviceId)) return;
  next();
}

/** Respuestas API: sin contraseña de app ni contraseña del gateway. */
function sanitizeUserRecord(user) {
  if (!user) return user;
  const { password: _pw, ...rest } = user;
  let milesightUgGateway = rest.milesightUgGateway;
  if (milesightUgGateway && typeof milesightUgGateway === 'object') {
    milesightUgGateway = {
      baseUrl: milesightUgGateway.baseUrl || '',
      apiUsername: milesightUgGateway.apiUsername || '',
      rejectUnauthorized: milesightUgGateway.rejectUnauthorized !== false,
      hasApiPassword: Boolean(milesightUgGateway.apiPassword),
    };
  }
  const profileName =
    rest.profileName != null && rest.profileName !== ''
      ? fixUtf8Mojibake(String(rest.profileName))
      : rest.profileName;
  return { ...rest, profileName, milesightUgGateway, mustChangePassword: Boolean(user.mustChangePassword) };
}

function getMilesightUgGatewayConfig(userId) {
  const u = store.getUserById(userId);
  const g = u?.milesightUgGateway;
  if (!g || !String(g.baseUrl || '').trim()) return null;
  return {
    baseUrl: ugNormalizeBaseUrl(g.baseUrl),
    apiUsername: g.apiUsername != null ? g.apiUsername : 'apiuser',
    apiPassword: g.apiPassword != null ? g.apiPassword : '',
    rejectUnauthorized: g.rejectUnauthorized !== false,
  };
}

const requireMilesightUgGateway = (req, res, next) => {
  const config = getMilesightUgGatewayConfig(req.user.id);
  if (!config) {
    return res.status(400).json({
      error: 'Configure el gateway UG65/UG67 en Ajustes: URL base (https://IP:8080), usuario y contraseña API.',
    });
  }
  req.milesightUgConfig = config;
  next();
};

function sendUgGatewayResponse(res, r) {
  if (r.json !== null && r.json !== undefined) {
    return res.status(r.status >= 200 && r.status < 600 ? r.status : 502).json(r.json);
  }
  const status = r.status >= 200 && r.status < 600 ? r.status : 502;
  res.status(status).type('application/json').send(r.text || '{}');
}

const normalizeId = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim().toLowerCase();
};

const collectIdentifiers = (entry = {}) => {
  const props = entry.properties || {};
  return [
    entry.deviceId,
    entry.deviceName,
    props.deviceId,
    props.deviceName,
    props.devEUI,
    props.devEui,
    props.deviceEui,
    props.deviceSn,
    props.sn,
    props.eui,
  ]
    .map(normalizeId)
    .filter(Boolean);
};

const resolveCanonicalDeviceId = (userId, incomingIdentifiers = []) => {
  const incomingSet = new Set(incomingIdentifiers.map(normalizeId).filter(Boolean));
  if (incomingSet.size === 0) return null;

  const ordered = store.getTelemetryRowsForResolve(
    userId,
    parseInt(process.env.SYSCOM_RESOLVE_TELEMETRY_LIMIT, 10) || 8000
  );

  for (const entry of ordered) {
    const ids = collectIdentifiers(entry);
    if (ids.some((id) => incomingSet.has(id))) {
      return entry.deviceId ? entry.deviceId.toString() : null;
    }
  }
  return null;
};

/** Extrae propiedades de un cuerpo JSON al estilo plataformas IoT (Datacake / webhooks genéricos). */
function extractIngestProperties(data) {
  if (!data || typeof data !== 'object') return { properties: {} };
  const rawDeviceId =
    data.device_id ||
    data.deviceId ||
    data.deviceSn ||
    data.deviceEui ||
    data.devEui ||
    data.devEUI ||
    data.sn ||
    data.eui ||
    data.hardware_id;
  const deviceName = data.device_name || data.deviceName || data.name || rawDeviceId;

  let properties = {};
  const dataContainers = [
    data.data,
    data.properties,
    data.metrics,
    data.measurements,
    data.fields,
    data.telemetry,
    data.events,
    data.payload,
  ];
  dataContainers.forEach((container) => {
    if (container && typeof container === 'object') {
      if (Array.isArray(container)) {
        container.forEach((item) => {
          const key = item.propertyKey || item.key || item.field || item.id || item.type || item.eventID;
          const val = item.value !== undefined ? item.value : item.data;
          if (key) properties[key] = val;
        });
      } else {
        properties = { ...properties, ...container };
      }
    }
  });

  const metaKeys = new Set([
    'device_id', 'deviceSn', 'deviceEui', 'deviceId', 'devEui', 'devEUI', 'sn', 'deviceName', 'device_name', 'name',
    'timestamp', 'ts', 'time', 'userId', 'event', 'type', 'data', 'properties', 'metrics', 'measurements', 'fields',
    'ack', 'fport', 'method', 'nonce', 'sign', 'hardware_id', 'payload',
  ]);

  Object.keys(data).forEach((key) => {
    if (!metaKeys.has(key) && (typeof data[key] !== 'object' || data[key] === null)) {
      properties[key] = data[key];
    }
  });

  return { rawDeviceId, deviceName, properties };
}

function saveIngestEntry(userId, data) {
  const { rawDeviceId, deviceName, properties: baseProps } = extractIngestProperties(data);

  if (!rawDeviceId) {
    return { ok: true, test: true, message: 'Sin device id (aceptado como prueba)' };
  }

  if (isEphemeralLorawanPseudoDeviceId(rawDeviceId)) {
    if (String(process.env.SYSCOM_LOG_EPHEMERAL_INGEST || '').trim() === '1') {
      console.warn(`[Ingest] Omitido (pseudo device_id no registrable): ${rawDeviceId}`);
    }
    return { ok: true, skipped: true, message: 'ephemeral_device_id' };
  }

  const incomingIdentifiers = [
    rawDeviceId,
    deviceName,
    data.deviceId,
    data.device_id,
    data.deviceSn,
    data.deviceEui,
    data.devEui,
    data.devEUI,
    data.sn,
    data.eui,
    baseProps.deviceId,
    baseProps.deviceName,
    baseProps.devEUI,
    baseProps.devEui,
    baseProps.deviceEui,
    baseProps.deviceSn,
    baseProps.sn,
    baseProps.eui,
  ];
  const canonicalDeviceId = resolveCanonicalDeviceId(userId, incomingIdentifiers) || rawDeviceId.toString();
  const normalizedDeviceName = deviceName || canonicalDeviceId;

  if (isEphemeralLorawanPseudoDeviceId(canonicalDeviceId)) {
    console.warn(`[Ingest] Omitido (device_id canónico inválido): ${canonicalDeviceId}`);
    return { ok: true, skipped: true, message: 'ephemeral_canonical_id' };
  }

  if (!store.deviceRegisteredForUser(userId, canonicalDeviceId)) {
    console.warn(
      `[Ingest] Telemetría omitida (dispositivo no dado de alta para este usuario): user=${userId} device=${canonicalDeviceId}`
    );
    return { ok: true, skipped: true, message: 'device_not_registered' };
  }

  const properties = { ...baseProps };
  properties.deviceId = canonicalDeviceId;
  properties.deviceName = normalizedDeviceName;
  if (!properties.devEUI && properties.devEui) properties.devEUI = properties.devEui;
  if (!properties.devEui && properties.devEUI) properties.devEui = properties.devEUI;

  tryApplyStoredDecoder(store, canonicalDeviceId, rawDeviceId, properties);
  promoteUc300GpioFromChannelHistory(properties);

  pushDebugWebhook({
    timestamp: Date.now(),
    deviceId: canonicalDeviceId,
    rawDeviceId: rawDeviceId.toString(),
    rawBody: data,
    extractedProps: properties,
  });

  const ts = Date.now();
  const telemetryUserIds = store.appendTelemetry(userId, canonicalDeviceId, normalizedDeviceName, properties, ts);
  metrics.inc('telemetry_saved');
  const telemEv = {
    deviceId: canonicalDeviceId,
    deviceName: normalizedDeviceName,
    timestamp: ts,
    properties: sanitizeTelemetryForSse(properties),
  };
  for (const uid of telemetryUserIds) {
    realtimeHub.broadcast(String(uid), 'telemetry', telemEv);
  }
  console.log(`[Ingest] user=${userId} device=${canonicalDeviceId} (raw=${rawDeviceId})`);
  return { ok: true, saved: true, deviceId: canonicalDeviceId };
}

/** Misma tubería que POST /api/lorawan/uplink y Semtech UDP PUSH_DATA. */
function runUplinkPipeline(userId, body) {
  const chunks = expandLorawanPacketBodies(body);
  const results = [];
  for (const chunk of chunks) {
    const normalized = normalizeLorawanUplink(chunk);
    results.push(saveIngestEntry(userId, normalized));
  }
  return results;
}

/** LNS UI event en BD + broadcast SSE (mismo contrato que store.lnsInsertUiEvent). */
function insertUiEventWithStream(userId, devEui, eventType, metaJson) {
  const id = store.lnsInsertUiEvent(userId, devEui, eventType, metaJson);
  metrics.inc('lns_ui_events');
  let meta = null;
  if (metaJson) {
    try {
      meta = JSON.parse(metaJson);
    } catch {
      meta = null;
    }
  }
  realtimeHub.broadcast(String(userId), 'lns', {
    id,
    eventType,
    devEui: String(devEui || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase(),
    meta,
    createdAt: Date.now(),
  });
  return id;
}

let lnsEngineSingleton = null;
function getLnsEngine() {
  if (process.env.SYSCOM_LNS_MAC === '0') return null;
  if (!lnsEngineSingleton) {
    const { createLorawanLnsEngine } = require('./lns/lorawan-lns-engine');
    lnsEngineSingleton = createLorawanLnsEngine({
      store,
      saveIngestEntry,
      runLegacyUplink: (uid, b) => runUplinkPipeline(uid, b),
      insertUiEvent: insertUiEventWithStream,
    });
    /** Referencia global para el handler UDP Semtech (GW_TX_ACK → handleTxAck). */
    globalThis.lnsEngine = lnsEngineSingleton;
  }
  return lnsEngineSingleton;
}

/** LoRaWAN con MAC propio (OTAA/datos cifrados) si hay rxpk + gateway EUI; si no, legado. */
function deliverLorawanUplink(userId, body) {
  const eng = getLnsEngine();
  if (eng && body && typeof body === 'object' && Array.isArray(body.rxpk) && body.rxpk.length) {
    const gid = String(body.gateway_id || body.gwid || body.EUI || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (gid.length === 16) {
      eng.processPushJson(userId, Buffer.from(gid, 'hex'), body);
      return;
    }
  }
  runUplinkPipeline(userId, body);
}

function handleIngestRequest(req, res) {
  const { userId, ingestToken } = req.params;
  const user = store.getUserById(userId);
  if (!user || user.ingestToken !== ingestToken) {
    return res.status(401).json({ error: 'Token de ingesta inválido o usuario inexistente' });
  }
  try {
    const results = runUplinkPipeline(userId, req.body);
    if (results.length === 1) {
      const result = results[0];
      if (result.test) {
        return res.status(200).json({ ok: true, message: result.message });
      }
      return res.status(200).json(result);
    }
    return res.status(200).json({
      ok: true,
      batches: results.length,
      savedCount: results.filter((r) => r.saved).length,
      results,
    });
  } catch (e) {
    console.error('[Ingest]', e);
    return res.status(500).json({ error: e.message });
  }
}

/** Uplink LoRaWAN: normaliza rxpk / ChirpStack / TTS y guarda telemetría. */
function handleLorawanUplinkRequest(req, res) {
  const { userId, ingestToken } = req.params;
  const user = store.getUserById(userId);
  if (!user || user.ingestToken !== ingestToken) {
    return res.status(401).json({ error: 'Token de ingesta inválido o usuario inexistente' });
  }
  try {
    deliverLorawanUplink(userId, req.body);
    return res.status(200).json({ ok: true, lorawan: true, lns: Boolean(getLnsEngine()) });
  } catch (e) {
    console.error('[LoRaWAN]', e);
    return res.status(500).json({ error: e.message });
  }
}

// ── Auth middleware ────────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  if (!verifyBearerForAuthMiddleware(req, token)) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  const p = req.path || '';
  const firstPwOk =
    req.method === 'POST' && (p === '/api/auth/first-password' || p.endsWith('/auth/first-password'));
  const meOk = req.method === 'GET' && (p === '/api/auth/me' || p.endsWith('/auth/me'));
  if (firstPwOk || meOk) return next();

  const fullUser = store.getUserById(req.user.id);
  if (fullUser?.mustChangePassword && !req.user.impersonation) {
    return res.status(403).json({
      code: 'MUST_CHANGE_PASSWORD',
      error: 'Debe definir una contraseña segura antes de continuar.',
    });
  }
  next();
};

const adminMiddleware = (req, res, next) => {
  if (!isStaffRole(req.user.role)) return res.status(403).json({ error: 'Solo administradores' });
  next();
};

/** Super admin o admin (no rol usuario/viewer). */
const staffOnlyMiddleware = (req, res, next) => {
  if (!isStaffRole(req.user.role)) {
    return res.status(403).json({ error: 'Permisos insuficientes para esta acción' });
  }
  next();
};

const superAdminOnlyMiddleware = (req, res, next) => {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Solo el super administrador puede realizar esta acción' });
  }
  next();
};

/** Solo direcciones loopback (no usar X-Forwarded-For: falsificable). */
function isLoopbackIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const s = ip.trim();
  if (s === '127.0.0.1' || s === '::1') return true;
  if (s.startsWith('::ffff:127.0.0.1')) return true;
  return false;
}

const loopbackOnlyDebugMiddleware = (req, res, next) => {
  const ip = req.socket?.remoteAddress || '';
  if (!isLoopbackIp(ip)) {
    return res.status(403).json({ error: 'Solo disponible desde el servidor local (127.0.0.1)' });
  }
  next();
};

// ── Ingesta HTTP (tipo Datacake: URL única por espacio de trabajo) ──
app.post('/api/ingest/:userId/:ingestToken', ingestRateLimit, handleIngestRequest);
app.post('/api/lorawan/uplink/:userId/:ingestToken', ingestRateLimit, handleLorawanUplinkRequest);
/** Alias explícito para gateways Milesight (mismo cuerpo y token que LoRaWAN). */
app.post('/api/milesight/uplink/:userId/:ingestToken', ingestRateLimit, handleLorawanUplinkRequest);
app.get('/api/ingest/:userId/:ingestToken', (req, res) => {
  res.status(200).json({
    ok: true,
    hint: 'Use POST con Content-Type: application/json y el cuerpo de telemetría del dispositivo.',
  });
});
app.get('/api/lorawan/uplink/:userId/:ingestToken', (req, res) => {
  res.status(200).json({
    ok: true,
    hint: 'POST JSON: uplink ChirpStack (devEUI + object), TTS, Semtech rxpk[] o Milesight NS (payloadBase64 / payloadJson).',
    endpoints: {
      generic: `/api/ingest/${req.params.userId}/…`,
      lorawan: `/api/lorawan/uplink/${req.params.userId}/…`,
      milesight: `/api/milesight/uplink/${req.params.userId}/…`,
    },
  });
});
app.get('/api/milesight/uplink/:userId/:ingestToken', (req, res) => {
  res.status(200).json({
    ok: true,
    hint: 'POST JSON: mismo formato que /api/lorawan/uplink (incluye uplink Milesight embebido).',
    milesight: `/api/milesight/uplink/${req.params.userId}/…`,
  });
});

/** Webhook antiguo sin token: migrar a /api/ingest/:userId/:ingestToken */
app.all('/api/webhook/milesight/:userId', (req, res) => {
  res.status(410).json({
    error: 'Obsoleto',
    message: 'Configure el gateway con POST /api/ingest/<userId>/<ingestToken> (token en administración de usuarios).',
  });
});

// ── Auth routes ────────────────────────────────────────────
app.post('/api/auth/login', loginRateLimit, (req, res) => {
  metrics.inc('login_attempt');
  const { email, password } = req.body;
  const user = store.getUserByEmail(email);
  if (!user) {
    metrics.inc('login_fail');
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  }
  if (!bcrypt.compareSync(password, user.password)) {
    metrics.inc('login_fail');
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  }
  metrics.inc('login_success');
  const safe = sanitizeUserRecord(user);
  const token = signSessionJwt({
    id: safe.id,
    email: safe.email,
    role: safe.role,
    profileName: safe.profileName,
    mustChangePassword: Boolean(user.mustChangePassword),
  });
  res.json({ token, user: safe });
});

/**
 * POST con `Authorization: Bearer <JWT>` (aunque el JWT esté caducado en calendario).
 * Emite un JWT nuevo con los mismos claims que el login si sigue dentro de SYSCOM_JWT_REFRESH_GRACE_MS tras exp.
 */
app.post('/api/auth/refresh', loginRateLimit, (req, res) => {
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!raw) return res.status(401).json({ error: 'Token requerido' });
  let decoded;
  try {
    decoded = jwt.verify(raw, JWT_SECRET, { ignoreExpiration: true });
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  const expMs = decoded.exp != null ? Number(decoded.exp) * 1000 : 0;
  if (!expMs) return res.status(401).json({ error: 'Token sin expiración' });
  if (Date.now() > expMs + syscomJwtRefreshGraceMs()) {
    return res.status(401).json({
      error: 'Sesión demasiado antigua. Inicie sesión de nuevo.',
      code: 'REFRESH_GRACE_EXCEEDED',
    });
  }
  const user = store.getUserById(decoded.id);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  if (user.mustChangePassword && !decoded.impersonation) {
    return res.status(403).json({
      code: 'MUST_CHANGE_PASSWORD',
      error: 'Debe definir una contraseña segura antes de continuar.',
    });
  }
  const safe = sanitizeUserRecord(user);
  const payload = {
    id: safe.id,
    email: safe.email,
    role: safe.role,
    profileName: safe.profileName,
    mustChangePassword: Boolean(user.mustChangePassword),
  };
  if (decoded.impersonation) payload.impersonation = true;
  const token = signSessionJwt(payload);
  res.json({ token, user: safe });
});

// Flujo redirect: el frontend envía el authorization code que Google devolvió en la URL.
// El backend lo intercambia por tokens usando client_secret (nunca expuesto al navegador).
app.post('/api/auth/google/callback', loginRateLimit, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Código de autorización requerido' });

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Google OAuth no configurado (faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET)' });
  }

  try {
    // 1. Intercambiar código por tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(),
    });
    const tokens = await tokenRes.json();

    if (!tokenRes.ok || tokens.error) {
      console.error('[auth/google/callback] token exchange:', tokens.error, tokens.error_description);
      return res.status(401).json({ error: `Error de Google: ${tokens.error_description || tokens.error}` });
    }

    // 2. Verificar el id_token recibido
    const gRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`);
    const payload = await gRes.json();

    if (!gRes.ok || payload.error || payload.aud !== clientId) {
      return res.status(401).json({ error: 'Token de Google inválido' });
    }

    const email = (payload.email || '').toLowerCase().trim();
    if (!email) return res.status(401).json({ error: 'No se pudo obtener el correo desde Google' });

    // 3. Buscar o crear usuario
    let user = store.getUserByEmail(email);
    if (!user) {
      const rawName = payload.name || email;
      const newUser = {
        id: crypto.randomUUID(),
        email,
        password: null,
        role: 'user',
        profileName: fixUtf8Mojibake(rawName) || rawName,
        ingestToken: crypto.randomUUID(),
        mustChangePassword: false,
        createdBy: 'google-oauth',
        createdByEmail: email,
        pictureUrl: payload.picture || null,
      };
      store.insertUser(newUser);
      user = store.getUserById(newUser.id);
    } else {
      if (payload.picture && user.pictureUrl !== payload.picture) {
        user.pictureUrl = payload.picture;
        store.updateUserRecord(user);
      }
      const fixedName = fixUtf8Mojibake(user.profileName || '');
      if (fixedName !== user.profileName && String(user.profileName || '').includes('Ã')) {
        user.profileName = fixedName;
        store.updateUserRecord(user);
      }
    }

    metrics.inc('login_success');
    const safe = sanitizeUserRecord(user);
    const token = signSessionJwt({
      id: safe.id,
      email: safe.email,
      role: safe.role,
      profileName: safe.profileName,
      mustChangePassword: false,
    });
    res.json({ token, user: safe });
  } catch (e) {
    console.error('[auth/google/callback]', e.message);
    res.status(500).json({ error: 'Error al procesar el inicio de sesión con Google' });
  }
});

app.post('/api/auth/first-password', authMiddleware, (req, res) => {
  const row = store.getUserById(req.user.id);
  if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (!row.mustChangePassword) {
    return res.status(400).json({ error: 'No es necesario cambiar la contraseña.' });
  }
  const { newPassword } = req.body || {};
  const v = validatePasswordStrength(newPassword);
  if (!v.ok) return res.status(400).json({ error: v.error });
  row.password = bcrypt.hashSync(newPassword, 10);
  row.mustChangePassword = false;
  store.updateUserRecord(row);
  const safe = sanitizeUserRecord(row);
  const token = signSessionJwt({
    id: safe.id,
    email: safe.email,
    role: safe.role,
    profileName: safe.profileName,
    mustChangePassword: false,
  });
  res.json({ token, user: safe });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = store.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const safe = sanitizeUserRecord(user);
  if (req.user.impersonation) {
    return res.json({ ...safe, mustChangePassword: false });
  }
  res.json(safe);
});

/**
 * Lista usuarios para suplantación (solo UI debug en localhost). Misma visibilidad que GET /api/users.
 */
app.get('/api/debug/impersonation-users', authMiddleware, loopbackOnlyDebugMiddleware, (req, res) => {
  if (!isStaffRole(req.user.role)) {
    return res.status(403).json({ error: 'Solo administradores pueden usar el modo depuración' });
  }
  let raw;
  if (req.user.role === 'superadmin') {
    raw = store.allUsersSanitized();
  } else {
    raw = store.listUsersByCreator(req.user.id);
  }
  res.json(
    raw.map((u) => ({
      id: u.id,
      email: u.email,
      profileName: u.profileName || '',
      role: u.role,
    }))
  );
});

/**
 * Emite JWT como otro usuario (solo petición desde loopback al proceso Node). Útil para probar permisos en desarrollo.
 */
app.post('/api/debug/impersonate', loginRateLimit, authMiddleware, loopbackOnlyDebugMiddleware, (req, res) => {
  if (!isStaffRole(req.user.role)) {
    return res.status(403).json({ error: 'Solo administradores pueden usar el modo depuración' });
  }
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  if (!userId) return res.status(400).json({ error: 'userId requerido' });
  const user = store.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (req.user.role !== 'superadmin') {
    const allowed = new Set(store.listUsersByCreator(req.user.id).map((u) => String(u.id)));
    allowed.add(String(req.user.id));
    if (!allowed.has(String(userId))) {
      return res.status(403).json({ error: 'No puede suplantar a ese usuario' });
    }
  }
  const safe = sanitizeUserRecord(user);
  const token = signSessionJwt({
    id: safe.id,
    email: safe.email,
    role: safe.role,
    profileName: safe.profileName,
    mustChangePassword: Boolean(user.mustChangePassword),
    impersonation: true,
  });
  res.json({ token, user: { ...safe, mustChangePassword: false } });
});

app.get('/api/auth/license-warnings', authMiddleware, (req, res) => {
  res.json({ warnings: store.listLicenseExpiringSoonForUser(req.user.id) });
});

/** Alias histórico; preferir /api/auth/license-warnings */
app.get('/api/me/license-warnings', authMiddleware, (req, res) => {
  res.json({ warnings: store.listLicenseExpiringSoonForUser(req.user.id) });
});

/** JWT en `Authorization: Bearer` o query `?token=` (EventSource no envía cabeceras custom). */
const authFromBearerOrQuery = (req, res, next) => {
  const q = req.query?.token;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const token = typeof q === 'string' && q.trim() !== '' ? q.trim() : header;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    if (e?.name === 'TokenExpiredError') {
      try {
        const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
        const expMs = decoded.exp != null ? Number(decoded.exp) * 1000 : 0;
        if (!expMs || Date.now() > expMs + syscomJwtRefreshGraceMs()) {
          return res.status(401).json({ error: 'Token inválido o expirado' });
        }
        req.user = decoded;
      } catch {
        return res.status(401).json({ error: 'Token inválido o expirado' });
      }
    } else {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
  }
  const fullUser = store.getUserById(req.user.id);
  if (fullUser?.mustChangePassword && !req.user.impersonation) {
    return res.status(403).json({
      code: 'MUST_CHANGE_PASSWORD',
      error: 'Debe definir una contraseña segura antes de continuar.',
    });
  }
  next();
};

/**
 * Server-Sent Events: eventos `telemetry` y `lns` para la cuenta del token.
 * Ejemplo: GET `/api/events/stream?token=<JWT>` (mismo host que la API).
 */
app.get('/api/events/stream', authFromBearerOrQuery, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  realtimeHub.subscribe(req.user.id, res);
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
});

/** Métricas y uptime en memoria (sin servicios externos). Solo administradores. */
app.get('/api/admin/syscom-metrics', authMiddleware, staffOnlyMiddleware, (req, res) => {
  const snap = metrics.snapshot();
  res.json({
    status: 'Success',
    ...snap,
    realtime: { sseSubscribers: realtimeHub.subscriberCount() },
  });
});

// ── Milesight UG65/UG67 API (proxy autenticado hacia https://gateway:8080) ──
app.post('/api/milesight-ug-gateway/probe', authMiddleware, staffOnlyMiddleware, async (req, res) => {
  try {
    const { baseUrl, apiUsername, apiPassword, rejectUnauthorized } = req.body || {};
    if (!baseUrl) return res.status(400).json({ error: 'baseUrl requerido (ej. https://192.168.1.10:8080)' });
    const config = {
      baseUrl: ugNormalizeBaseUrl(baseUrl),
      apiUsername: apiUsername || 'apiuser',
      apiPassword: apiPassword || '',
      rejectUnauthorized: rejectUnauthorized !== false,
    };
    await loginToGateway(config);
    res.json({ ok: true, message: 'Login en el gateway correcto' });
  } catch (e) {
    const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    res.status(code).json({ error: e.message, details: e.body });
  }
});

app.post('/api/milesight-ug-gateway/probe-saved', authMiddleware, staffOnlyMiddleware, requireMilesightUgGateway, async (req, res) => {
  try {
    await loginToGateway(req.milesightUgConfig);
    res.json({ ok: true, message: 'Login en el gateway correcto (credenciales guardadas)' });
  } catch (e) {
    const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    res.status(code).json({ error: e.message, details: e.body });
  }
});

app.get('/api/milesight-ug-gateway/applications', authMiddleware, staffOnlyMiddleware, requireMilesightUgGateway, async (req, res) => {
  try {
    const limit = String(req.query.limit ?? '50');
    const offset = String(req.query.offset ?? '0');
    const path = `/api/applications?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`;
    const r = await ugJsonRequest(req.user.id, req.milesightUgConfig, 'GET', path, null);
    sendUgGatewayResponse(res, r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/milesight-ug-gateway/applications/:name', authMiddleware, staffOnlyMiddleware, requireMilesightUgGateway, async (req, res) => {
  try {
    const name = encodeURIComponent(req.params.name);
    const r = await ugJsonRequest(req.user.id, req.milesightUgConfig, 'GET', `/api/applications/${name}`, null);
    sendUgGatewayResponse(res, r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/milesight-ug-gateway/devices', authMiddleware, staffOnlyMiddleware, requireMilesightUgGateway, async (req, res) => {
  try {
    const limit = String(req.query.limit ?? '100');
    const offset = String(req.query.offset ?? '0');
    const path = `/api/devices?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`;
    const r = await ugJsonRequest(req.user.id, req.milesightUgConfig, 'GET', path, null);
    sendUgGatewayResponse(res, r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/milesight-ug-gateway/devices/by-name/:name', authMiddleware, staffOnlyMiddleware, requireMilesightUgGateway, async (req, res) => {
  try {
    const name = encodeURIComponent(req.params.name);
    const r = await ugJsonRequest(req.user.id, req.milesightUgConfig, 'GET', `/api/devices/${name}`, null);
    sendUgGatewayResponse(res, r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get(
  '/api/milesight-ug-gateway/devices/:devEUI/data',
  authMiddleware,
  staffOnlyMiddleware,
  requireMilesightUgGateway,
  async (req, res) => {
    try {
      const deui = encodeURIComponent(req.params.devEUI);
      const r = await ugJsonRequest(req.user.id, req.milesightUgConfig, 'GET', `/api/devices/${deui}/data`, null);
      sendUgGatewayResponse(res, r);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }
);

app.post(
  '/api/milesight-ug-gateway/devices/:devEUI/ingest',
  authMiddleware,
  staffOnlyMiddleware,
  requireMilesightUgGateway,
  async (req, res) => {
    try {
      const deui = encodeURIComponent(req.params.devEUI);
      const r = await ugJsonRequest(req.user.id, req.milesightUgConfig, 'GET', `/api/devices/${deui}/data`, null);
      if (r.status !== 200 || !r.json) {
        return res.status(r.status || 502).json({ error: 'Respuesta inválida del gateway', raw: r.text });
      }
      const normalized = normalizeLorawanUplink(r.json);
      const result = saveIngestEntry(req.user.id, normalized);
      return res.json({ gatewayStatus: r.status, ingest: result, normalizedPreview: normalized });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }
);

app.get(
  '/api/milesight-ug-gateway/devices/:devEUI/queue',
  authMiddleware,
  staffOnlyMiddleware,
  requireMilesightUgGateway,
  async (req, res) => {
    try {
      const deui = encodeURIComponent(req.params.devEUI);
      const r = await ugJsonRequest(req.user.id, req.milesightUgConfig, 'GET', `/api/devices/${deui}/queue`, null);
      sendUgGatewayResponse(res, r);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }
);

app.post(
  '/api/milesight-ug-gateway/devices/:devEUI/queue',
  authMiddleware,
  staffOnlyMiddleware,
  requireMilesightUgGateway,
  async (req, res) => {
    try {
      const deui = encodeURIComponent(req.params.devEUI);
      const r = await ugJsonRequest(req.user.id, req.milesightUgConfig, 'POST', `/api/devices/${deui}/queue`, req.body);
      sendUgGatewayResponse(res, r);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }
);

app.delete(
  '/api/milesight-ug-gateway/devices/:devEUI/queue',
  authMiddleware,
  staffOnlyMiddleware,
  requireMilesightUgGateway,
  async (req, res) => {
    try {
      const deui = encodeURIComponent(req.params.devEUI);
      const r = await ugJsonRequest(req.user.id, req.milesightUgConfig, 'DELETE', `/api/devices/${deui}/queue`, null);
      sendUgGatewayResponse(res, r);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }
);

app.get('/api/milesight-ug-gateway/urpackets', authMiddleware, staffOnlyMiddleware, requireMilesightUgGateway, (req, res) => {
  streamUrpackets(req.user.id, req.milesightUgConfig, res).catch((e) => {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  });
});

app.put(
  '/api/milesight-ug-gateway/users/:username/password',
  authMiddleware,
  staffOnlyMiddleware,
  requireMilesightUgGateway,
  async (req, res) => {
    try {
      const un = encodeURIComponent(req.params.username);
      const r = await ugJsonRequest(
        req.user.id,
        req.milesightUgConfig,
        'PUT',
        `/api/users/${un}/password`,
        req.body
      );
      sendUgGatewayResponse(res, r);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }
);

// ── UG63 / SG50 MQTT (publicación desde la app; ingesta vía env + mqtt-ingest) ──
app.get('/api/milesight-mqtt/status', authMiddleware, (req, res) => {
  res.json(getMqttApiStatus());
});

app.post('/api/milesight-mqtt/downlink', authMiddleware, staffOnlyMiddleware, async (req, res) => {
  const body = req.body || {};
  const deuiNorm = body.devEUI != null ? String(body.devEUI).replace(/\s/g, '').toLowerCase() : '';
  try {
    const { devEUI, topic, confirmed, fPort, data } = body;
    if (!devEUI) return res.status(400).json({ error: 'devEUI requerido' });
    const result = await publishDownlink(devEUI, { topic, confirmed, fPort, data });
    const prev =
      typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data != null ? data : '').slice(0, 200);
    appendDownlinkLog(req.user.id, {
      channel: 'milesight-mqtt',
      devEUI: deuiNorm,
      deviceId: deuiNorm,
      fPort: fPort != null ? fPort : null,
      payloadPreview: prev,
      status: 'sent',
      detail: typeof result === 'object' && result != null ? result : { ok: true },
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    const msg = e.message || String(e);
    const code =
      msg.includes('Defina') || msg.includes('no disponible') || msg.includes('MQTT no disponible')
        ? 503
        : 400;
    if (deuiNorm) {
      appendDownlinkLog(req.user.id, {
        channel: 'milesight-mqtt',
        devEUI: deuiNorm,
        deviceId: deuiNorm,
        status: 'failed',
        error: msg,
      });
    }
    res.status(code).json({ error: msg });
  }
});

app.post('/api/milesight-mqtt/ns-request', authMiddleware, staffOnlyMiddleware, async (req, res) => {
  try {
    const { id, method, url, body: nsBody, timeoutMs } = req.body || {};
    if (!method || !url) return res.status(400).json({ error: 'method y url requeridos (§7 Milesight MQTT API)' });
    const out = await publishNsRequestAndWait({ id, method, url, body: nsBody }, timeoutMs);
    res.json(out);
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes('Timeout')) return res.status(504).json({ error: msg });
    if (msg.includes('Defina')) return res.status(503).json({ error: msg });
    res.status(502).json({ error: msg });
  }
});

// ── User management ────────────────────────────────────────
app.get('/api/users', authMiddleware, adminMiddleware, (req, res) => {
  let raw;
  if (req.user.role === 'superadmin') {
    raw = store.allUsersSanitized();
  } else {
    raw = store.listUsersByCreator(req.user.id);
  }
  res.json(raw.map((u) => sanitizeUserRecord(u)));
});

app.post('/api/users', authMiddleware, adminMiddleware, (req, res) => {
  const { email, password, role, profileName } = req.body;
  if (!password || String(password).length < 6) {
    return res.status(400).json({
      error:
        'Contraseña inicial requerida (mínimo 6 caracteres). La cuenta deberá elegir una contraseña segura en el primer acceso.',
    });
  }
  if (store.getUserByEmail(email)) {
    return res.status(409).json({
      error: 'Ese correo ya está registrado.',
      code: 'USER_EXISTS',
    });
  }
  let newRole = 'user';
  if (role === 'superadmin') {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Solo el super administrador puede crear cuentas super admin' });
    }
    newRole = 'superadmin';
  } else if (role === 'admin') {
    newRole = 'admin';
  } else {
    newRole = 'user';
  }
  if (req.user.role === 'admin' && (newRole === 'superadmin' || (newRole !== 'admin' && newRole !== 'user'))) {
    return res.status(400).json({ error: 'Solo puede crear administradores o usuarios de su jerarquía' });
  }
  const newUser = {
    id: Date.now().toString(),
    email,
    password: bcrypt.hashSync(password, 10),
    role: newRole,
    profileName: profileName || '',
    createdBy: req.user.id,
    createdByEmail: req.user.email,
    ingestToken: crypto.randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
    mustChangePassword: true,
  };
  store.insertUser(newUser);
  res.status(201).json(sanitizeUserRecord(newUser));
});

app.put('/api/users/:id', authMiddleware, (req, res) => {
  const row = store.getUserById(req.params.id);
  if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
  const isSelf = row.id === req.user.id;
  const isOwner = row.createdBy === req.user.id;
  const isSuper = req.user.role === 'superadmin';
  if (!isSelf && !isOwner && !isSuper) return res.status(403).json({ error: 'Sin permiso' });
  const { password, regenerateIngestToken, ...updates } = req.body;
  if (updates.role !== undefined) {
    const nr = updates.role;
    if (isEnsuredSuperadminEmail(row.email) && nr !== 'superadmin') {
      return res.status(403).json({ error: 'Esta cuenta debe permanecer como super administrador' });
    }
    if (!['superadmin', 'admin', 'user'].includes(nr)) {
      /* ignore */
    } else if (!isSuper) {
      return res.status(403).json({ error: 'Solo el super administrador puede cambiar roles' });
    } else {
      if (isSelf && nr !== 'superadmin') {
        const supers = store.allUsersSanitized().filter((u) => u.role === 'superadmin');
        if (supers.length <= 1) {
          return res.status(400).json({ error: 'Debe existir al menos un super administrador' });
        }
      }
      row.role = nr;
    }
  }
  if (updates.profileName !== undefined) row.profileName = updates.profileName;
  if (updates.email) {
    if (isEnsuredSuperadminEmail(row.email) && !isEnsuredSuperadminEmail(updates.email)) {
      return res.status(403).json({ error: 'No se puede cambiar el correo de la cuenta de super administrador principal' });
    }
    row.email = updates.email;
  }
  if (password) {
    const pv = validatePasswordStrength(password);
    if (!pv.ok) return res.status(400).json({ error: pv.error });
    row.password = bcrypt.hashSync(password, 10);
    if (isSelf) {
      row.mustChangePassword = false;
    } else {
      row.mustChangePassword = true;
    }
  }
  if (regenerateIngestToken === true && (isSelf || isOwner || isSuper)) {
    row.ingestToken = crypto.randomBytes(24).toString('hex');
  }
  if (updates.milesightUgGateway !== undefined && (isSelf || isOwner || isSuper)) {
    const cur = row.milesightUgGateway || {};
    const inc = updates.milesightUgGateway || {};
    const prevUrl = cur.baseUrl;
    const next = {
      baseUrl: inc.baseUrl != null ? String(inc.baseUrl).trim() : cur.baseUrl || '',
      apiUsername: inc.apiUsername != null ? String(inc.apiUsername) : cur.apiUsername || 'apiuser',
      rejectUnauthorized: inc.rejectUnauthorized !== undefined ? Boolean(inc.rejectUnauthorized) : cur.rejectUnauthorized !== false,
    };
    if (inc.apiPassword != null && String(inc.apiPassword) !== '') {
      next.apiPassword = String(inc.apiPassword);
    } else if (cur.apiPassword) {
      next.apiPassword = cur.apiPassword;
    } else {
      next.apiPassword = '';
    }
    row.milesightUgGateway = next;
    invalidateJwt(row.id, ugNormalizeBaseUrl(prevUrl || ''));
    invalidateJwt(row.id, ugNormalizeBaseUrl(next.baseUrl || ''));
  }
  store.updateUserRecord(row);
  res.json(sanitizeUserRecord(row));
});

app.delete('/api/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const row = store.getUserById(req.params.id);
  if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (isEnsuredSuperadminEmail(row.email)) {
    return res.status(403).json({ error: 'No se puede eliminar la cuenta de super administrador principal' });
  }
  if (row.id === req.user.id) return res.status(400).json({ error: 'No puede eliminarse a sí mismo' });
  if (req.user.role === 'superadmin') {
    if (row.role === 'superadmin') {
      const supers = store.allUsersSanitized().filter((u) => u.role === 'superadmin');
      if (supers.length <= 1) {
        return res.status(400).json({ error: 'No puede eliminar el único super administrador' });
      }
    }
  } else if (row.createdBy !== req.user.id) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  store.deleteUserById(req.params.id);
  res.json({ ok: true });
});

// ── Dispositivos (solo datos locales / ingesta) ────────────

const GW_ONLINE_ACTIVITY_MS = 15 * 60 * 1000;
const GW_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function hexNormGw(s) {
  if (s == null || s === undefined) return '';
  return String(s).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

function mac12FromEui16(eui16) {
  const h = hexNormGw(eui16);
  if (h.length !== 16) return '';
  if (h.slice(6, 10) === 'fffe') return h.slice(0, 6) + h.slice(10);
  return '';
}

function eui16FromMac12(mac12) {
  const h = hexNormGw(mac12);
  if (h.length !== 12) return '';
  return `${h.slice(0, 6)}fffe${h.slice(6)}`;
}

function gatewayIdMatchesTelemetry(candidateHex, gwEui16) {
  const g = hexNormGw(gwEui16);
  if (!g || g.length !== 16) return false;
  const c = hexNormGw(candidateHex);
  if (!c) return false;
  if (c === g) return true;
  const macFromG = mac12FromEui16(g);
  if (macFromG && c === macFromG) return true;
  const euiFromC = eui16FromMac12(c);
  if (euiFromC && euiFromC === g) return true;
  return false;
}

function telemetryRowReferencesGateway(entry, gwEui16) {
  const p = entry.properties || {};
  const candidates = [
    p.gatewayMac,
    p.gateway_mac,
    p.gatewayEUI,
    p.gatewayEui,
    p.gwEUI,
    p.mac,
    entry.deviceId,
  ];
  const dt = String(p.deviceType || '').toUpperCase();
  if (dt === 'GATEWAY' || dt === 'GATEWAYS') {
    candidates.push(p.devEUI, p.devEui);
  }
  if (p.gateway_id != null && hexNormGw(p.gateway_id).length >= 8) {
    candidates.push(p.gateway_id);
  }
  for (const raw of candidates) {
    if (gatewayIdMatchesTelemetry(raw, gwEui16)) return true;
  }
  return false;
}

function gatewayTelemetryAggregate(userId, gwEui16) {
  let lastTs = 0;
  let latest = null;
  const rows = store.getTelemetryForGatewayScan(userId);
  for (const t of rows) {
    if (!telemetryRowReferencesGateway(t, gwEui16)) continue;
    if (t.timestamp > lastTs) lastTs = t.timestamp;
    if (!latest || t.timestamp > latest.timestamp) latest = t;
  }
  return { lastTs, latest };
}

function computeGatewayOnline(latest, lastTs, now) {
  if (!lastTs) return { online: false, lastSeenAt: null };
  const p = (latest && latest.properties) || {};
  const dt = String(p.deviceType || '').toUpperCase();
  const st = p.connectStatus != null ? p.connectStatus : p.status;
  if (dt === 'GATEWAY' && st != null && String(st).length) {
    const sl = String(st).toLowerCase();
    if (['offline', 'disconnected', 'false', '0', 'off'].includes(sl)) {
      return { online: false, lastSeenAt: lastTs };
    }
    if (
      ['online', 'joined', 'connected', 'true', '1', 'on'].includes(sl) &&
      now - latest.timestamp < GW_STATUS_MAX_AGE_MS
    ) {
      return { online: true, lastSeenAt: lastTs };
    }
  }
  const active = now - lastTs < GW_ONLINE_ACTIVITY_MS;
  return { online: active, lastSeenAt: lastTs };
}

// ── Gateways LoRaWAN registrados (catálogo local por usuario) ───────────
app.get('/api/lorawan-gateways', authMiddleware, (req, res) => {
  const list = store.listLorawanGateways(req.user.id);
  const now = Date.now();
  const enriched = list.map((g) => {
    const { lastTs, latest } = gatewayTelemetryAggregate(req.user.id, g.gatewayEui);
    const { online, lastSeenAt } = computeGatewayOnline(latest, lastTs, now);
    return {
      ...g,
      online,
      lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
    };
  });
  res.json(enriched);
});

app.post('/api/lorawan-gateways', authMiddleware, staffOnlyMiddleware, (req, res) => {
  const { name, gatewayEui, frequencyBand } = req.body || {};
  const nameTrim = name != null ? String(name).trim() : '';
  if (!nameTrim || !gatewayEui || frequencyBand == null || String(frequencyBand).trim() === '') {
    return res.status(400).json({
      error: 'Nombre, Gateway EUI y frecuencia son obligatorios.',
      code: 'GATEWAY_VALIDATION',
    });
  }
  const eui = String(gatewayEui).replace(/[^0-9a-fA-F]/g, '');
  if (eui.length !== 16) {
    return res.status(400).json({
      error: 'Gateway EUI debe tener 16 caracteres hexadecimales (8 bytes).',
      code: 'GATEWAY_VALIDATION',
    });
  }
  if (!isAllowedGatewayFrequencyBand(frequencyBand)) {
    return res.status(400).json({
      error:
        'Solo se admite US915 subbanda FSB2 (canales 125 kHz 8–15 y 500 kHz 65–70). Use US902-928-FSB2.',
      code: 'GATEWAY_VALIDATION',
    });
  }
  const bandNorm = normalizeGatewayFrequencyBand(frequencyBand);
  if (!bandNorm) {
    return res.status(400).json({
      error: 'Banda de gateway no válida.',
      code: 'GATEWAY_VALIDATION',
    });
  }
  const el = eui.toLowerCase();
  if (store.lorawanGatewayExists(req.user.id, el)) {
    return res.status(409).json({
      error: 'Ya existe un gateway registrado con este EUI.',
      code: 'GATEWAY_EXISTS',
    });
  }
  const row = {
    id: Date.now().toString(),
    userId: req.user.id,
    name: nameTrim.slice(0, 128),
    gatewayEui: el,
    frequencyBand: bandNorm.slice(0, 64),
    createdAt: new Date().toISOString(),
  };
  store.insertLorawanGateway(row);
  res.status(201).json(row);
});

app.delete('/api/lorawan-gateways/:id', authMiddleware, staffOnlyMiddleware, (req, res) => {
  const ok = store.deleteLorawanGateway(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ok: true });
});

app.get('/api/devices', authMiddleware, (req, res) => {
  const role = req.user.role;
  const content =
    role === 'superadmin'
      ? buildDevicesContentSuperadmin()
      : buildDevicesContentAssignedOnly(req.user.id);
  res.json({ status: 'Success', data: { content } });
});

app.post('/api/devices/assign', authMiddleware, (req, res) => {
  const actor = store.getUserById(req.user.id);
  if (!actor) return res.status(401).json({ error: 'Usuario no encontrado' });
  const { role } = actor;
  if (role === 'user' || role === 'viewer') {
    return res.status(403).json({ error: 'Los usuarios no pueden asignar dispositivos' });
  }

  const { deviceId, assigneeEmail } = req.body || {};
  const did = deviceId != null ? String(deviceId).trim() : '';
  const emailRaw = assigneeEmail != null ? String(assigneeEmail).trim().toLowerCase() : '';
  if (!did || !emailRaw) return res.status(400).json({ error: 'deviceId y assigneeEmail requeridos' });
  if (isEphemeralLorawanPseudoDeviceId(did)) {
    return res.status(400).json({
      error:
        'No se pueden asignar pseudo-dispositivos (devaddr-* / gateway-*). Registre el equipo por DevEUI y etiqueta de producto.',
    });
  }

  const assignee = store.getUserByEmail(emailRaw);
  if (!assignee) return res.status(404).json({ error: 'No existe un usuario con ese correo' });
  if (assignee.id === actor.id) return res.status(400).json({ error: 'No puede asignarse a sí mismo' });

  if (role === 'admin') {
    if (assignee.createdBy !== actor.id) {
      return res.status(403).json({ error: 'Solo puede asignar a cuentas que usted creó' });
    }
    if (assignee.role !== 'admin' && assignee.role !== 'user') {
      return res.status(403).json({ error: 'Solo puede asignar a administradores o usuarios de su jerarquía' });
    }
    if (!store.getUserDevice(actor.id, did)) {
      return res.status(403).json({ error: 'No tiene este dispositivo en su cuenta' });
    }
  }

  if (role === 'superadmin') {
    if (!['admin', 'user', 'superadmin'].includes(assignee.role)) {
      return res.status(400).json({ error: 'Rol de destino no válido' });
    }
    const hasLocal = store.getUserDevice(actor.id, did);
    const exists = store.deviceExistsInSystem(did);
    if (!hasLocal && !exists) {
      return res.status(400).json({
        error: 'Dispositivo desconocido. Regístrelo primero o espere telemetría.',
      });
    }
  }

  if (assignee.role !== 'superadmin' && !store.isLicenseActiveForEndUser(did)) {
    return res.status(400).json({
      error:
        'La licencia de este dispositivo está vencida. Renueve como super administrador antes de asignarla a otros usuarios.',
    });
  }

  const base =
    store.getUserDevice(actor.id, did) || store.getAnyUserDeviceForDeviceId(did) || {
      displayName: did,
      devEUI: '',
      notes: '',
      appEui: '',
      appKey: '',
      tag: '',
      lorawanClass: '',
    };
  const nowIso = new Date().toISOString();
  const prevA = store.getUserDevice(assignee.id, did);
  const row = {
    id: prevA ? prevA.id : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    userId: assignee.id,
    deviceId: did,
    displayName: base.displayName || did,
    devEUI: base.devEUI || '',
    notes: base.notes || '',
    appEui: base.appEui || '',
    appKey: base.appKey || '',
    tag: base.tag || '',
    lorawanClass: base.lorawanClass || '',
    updatedAt: nowIso,
    createdAt: prevA ? prevA.createdAt : nowIso,
  };
  store.upsertUserDevice(row);
  const deuiA = String(row.devEUI || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (deuiA.length === 16 && row.lorawanClass != null && String(row.lorawanClass).trim() !== '') {
    store.lnsSyncSessionDeviceClass(assignee.id, deuiA, row.lorawanClass);
  }
  store.ensureDeviceLicenseIfMissing(did);
  store.upsertDeviceLabel(assignee.id, did, row.displayName);
  res.status(prevA ? 200 : 201).json({ ok: true, userDevice: row });
});

app.delete('/api/devices/:deviceId/permanent', authMiddleware, superAdminOnlyMiddleware, (req, res) => {
  const did = decodeURIComponent(req.params.deviceId || '').trim();
  if (!did) return res.status(400).json({ error: 'deviceId requerido' });
  store.purgeDeviceGlobally(did);
  res.json({ ok: true });
});

app.get('/api/user-devices', authMiddleware, (req, res) => {
  const list = store.listUserDevices(req.user.id).filter((ud) => {
    if (isGatewayPseudoDeviceId(ud.deviceId)) return false;
    if (isEphemeralLorawanPseudoDeviceId(ud.deviceId)) return false;
    return userDevicePassesProductTagFilter(ud);
  });
  if (req.user.role === 'superadmin') {
    res.json(list);
    return;
  }
  res.json(list.filter((ud) => store.isLicenseActiveForEndUser(ud.deviceId)));
});

app.post('/api/user-devices', authMiddleware, superAdminOnlyMiddleware, (req, res) => {
  const { deviceId, displayName, devEUI, appEUI, appKey, tag, notes, lorawanClass } = req.body || {};
  const eui = devEUI != null ? String(devEUI).replace(/[^0-9a-fA-F]/gi, '').toLowerCase() : '';
  const idRaw = deviceId != null ? String(deviceId).trim() : '';
  const id = idRaw || eui;
  if (!id) {
    return res.status(400).json({ error: 'DevEUI o deviceId requerido', code: 'DEVICE_VALIDATION' });
  }
  if (isEphemeralLorawanPseudoDeviceId(id)) {
    return res.status(400).json({
      error:
        'deviceId no válido: use el DevEUI del nodo (16 hex). No se admiten identificadores automáticos tipo devaddr-*.',
      code: 'DEVICE_EPHEMERAL_ID',
    });
  }
  const name = (displayName != null ? String(displayName).trim() : '') || id;
  const appEuiNorm = appEUI != null ? String(appEUI).replace(/[^0-9a-fA-F]/gi, '').toLowerCase() : '';
  const appKeyNorm = appKey != null ? String(appKey).replace(/[^0-9a-fA-F]/gi, '').toLowerCase() : '';
  const tagStr = tag != null ? String(tag).trim().slice(0, 128) : '';
  const noteStr = notes != null ? String(notes).slice(0, 500) : '';
  const nowIso = new Date().toISOString();

  if (eui.length !== 16) {
    return res.status(400).json({
      error: 'DevEUI debe tener exactamente 16 caracteres hexadecimales (8 bytes).',
      code: 'DEVICE_VALIDATION',
    });
  }
  if (appEuiNorm.length !== 16) {
    return res.status(400).json({
      error: 'AppEUI / JoinEUI debe tener exactamente 16 caracteres hexadecimales (8 bytes).',
      code: 'DEVICE_VALIDATION',
    });
  }
  if (appKeyNorm.length !== 32) {
    return res.status(400).json({
      error: 'AppKey debe tener exactamente 32 caracteres hexadecimales (16 bytes).',
      code: 'DEVICE_VALIDATION',
    });
  }
  if (!name || name.length < 1) {
    return res.status(400).json({
      error: 'Indique un nombre de dispositivo.',
      code: 'DEVICE_VALIDATION',
    });
  }

  const allowTags = getDeviceTagAllowlistSet();
  if (allowTags) {
    const tagNorm = tagStr.trim().toLowerCase();
    if (!tagNorm || !allowTags.has(tagNorm)) {
      return res.status(400).json({
        error: `La etiqueta (tag) del producto es obligatoria y debe ser una de: ${[...allowTags].join(', ')}.`,
        code: 'DEVICE_TAG',
      });
    }
  }

  const prev = store.getUserDevice(req.user.id, id);
  const existingById = store.getAnyUserDeviceForDeviceId(id);
  if (existingById && (!prev || existingById.id !== prev.id)) {
    return res.status(409).json({
      error: 'Ya existe un dispositivo registrado con este identificador.',
      code: 'DEVICE_EXISTS',
    });
  }
  const duEui = store.getAnyUserDeviceByDevEuiNorm(eui);
  if (duEui && (!prev || duEui.id !== prev.id)) {
    return res.status(409).json({
      error: 'Ya existe un dispositivo registrado con este DevEUI.',
      code: 'DEVICE_EXISTS',
    });
  }
  const row = {
    id: prev ? prev.id : Date.now().toString(),
    userId: req.user.id,
    deviceId: id,
    displayName: name,
    devEUI: eui || id.toLowerCase().replace(/[^0-9a-f]/g, '') || id,
    notes: noteStr,
    appEui: appEuiNorm,
    appKey: appKeyNorm,
    tag: tagStr,
    lorawanClass: lorawanClass != null ? String(lorawanClass) : prev?.lorawanClass,
    updatedAt: nowIso,
    createdAt: prev ? prev.createdAt : nowIso,
  };
  store.upsertUserDevice(row);
  const deuiSync = String(row.devEUI || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (deuiSync.length === 16 && row.lorawanClass != null && String(row.lorawanClass).trim() !== '') {
    store.lnsSyncSessionDeviceClass(req.user.id, deuiSync, row.lorawanClass);
  }
  store.ensureDeviceLicenseIfMissing(id);
  store.upsertDeviceLabel(req.user.id, id, name);
  res.status(prev ? 200 : 201).json(row);
});

app.post(
  '/api/devices/:deviceId/license/renew',
  authMiddleware,
  superAdminOnlyMiddleware,
  (req, res) => {
    const did = decodeURIComponent(req.params.deviceId || '').trim();
    if (!did) return res.status(400).json({ error: 'deviceId requerido' });
    store.ensureDeviceLicenseIfMissing(did);
    const r = store.renewDeviceLicense(did);
    if (!r.ok) return res.status(404).json({ error: r.error || 'No se pudo renovar' });
    res.json({ ok: true, license: r.license });
  }
);

app.get(
  '/api/devices/:deviceId/decode-config',
  authMiddleware,
  staffOnlyMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
    const did = decodeURIComponent(req.params.deviceId || '').trim();
    const cfg = store.getDeviceDecodeConfig(did);
    const ud = store.getUserDevice(req.user.id, did);
    let lorawanClass = '';
    if (cfg.lorawanClass) {
      lorawanClass = cfg.lorawanClass;
    } else if (ud && ud.lorawanClass != null && String(ud.lorawanClass).trim() !== '') {
      const u = String(ud.lorawanClass).trim().toUpperCase();
      lorawanClass = u === 'B' || u === 'C' ? u : 'A';
    }
    if (!lorawanClass) lorawanClass = 'A';
    res.json({ ...cfg, lorawanClass });
  }
);

app.put(
  '/api/devices/:deviceId/decode-config',
  authMiddleware,
  staffOnlyMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
    const body = req.body || {};
    const did = decodeURIComponent(req.params.deviceId || '').trim();
    if (!did) return res.status(400).json({ error: 'deviceId requerido' });
    const prev = store.getDeviceDecodeConfig(did);
    const script =
      body.decoderScript !== undefined ? String(body.decoderScript) : prev.decoderScript;
    if (script.length > 512 * 1024) {
      return res.status(400).json({ error: 'Decoder demasiado largo (máx. 512 KB)' });
    }
    const next = {
      decoderScript: script,
      channel: body.channel !== undefined ? String(body.channel).trim().slice(0, 64) : prev.channel,
      downlinks: body.downlinks !== undefined ? body.downlinks : prev.downlinks,
    };
    const lcRaw = body.lorawanClass ?? body.lorawan_class;
    if (lcRaw !== undefined) {
      if (lcRaw === null || String(lcRaw).trim() === '') next.lorawanClass = null;
      else {
        const u = String(lcRaw).trim().toUpperCase();
        next.lorawanClass = u === 'B' || u === 'C' ? u : 'A';
      }
    }
    store.setDeviceDecodeConfig(did, next);

    if (lcRaw !== undefined && lcRaw !== null && String(lcRaw).trim() !== '') {
      const u = String(lcRaw).trim().toUpperCase();
      const lorawanClass = u === 'B' || u === 'C' ? u : 'A';
      const ud = store.getUserDevice(req.user.id, did);
      if (ud) {
        const nowIso = new Date().toISOString();
        store.upsertUserDevice({
          ...ud,
          lorawanClass,
          updatedAt: nowIso,
        });
        const deui = String(ud.devEUI || '')
          .replace(/[^0-9a-fA-F]/g, '')
          .toLowerCase();
        if (deui.length === 16) {
          store.lnsSyncSessionDeviceClass(req.user.id, deui, lorawanClass);
        }
      }
    }

    const cfgAfter = store.getDeviceDecodeConfig(did);
    const udAfter = store.getUserDevice(req.user.id, did);
    let lorawanClassOut = '';
    if (cfgAfter.lorawanClass) lorawanClassOut = cfgAfter.lorawanClass;
    else if (udAfter && udAfter.lorawanClass != null && String(udAfter.lorawanClass).trim() !== '') {
      const u = String(udAfter.lorawanClass).trim().toUpperCase();
      lorawanClassOut = u === 'B' || u === 'C' ? u : 'A';
    }
    if (!lorawanClassOut) lorawanClassOut = 'A';
    res.json({ ...cfgAfter, lorawanClass: lorawanClassOut });
  }
);

app.delete('/api/user-devices/:deviceId', authMiddleware, staffOnlyMiddleware, (req, res) => {
  const id = decodeURIComponent(req.params.deviceId);
  store.deleteUserDevice(req.user.id, id);
  res.json({ ok: true });
});

app.get('/api/automations', authMiddleware, (req, res) => {
  res.json({ rules: store.listAutomationRules(req.user.id) });
});

app.put('/api/automations', authMiddleware, staffOnlyMiddleware, (req, res) => {
  const { rules } = req.body || {};
  if (!Array.isArray(rules)) return res.status(400).json({ error: 'rules debe ser un array' });
  store.replaceAutomationRules(req.user.id, rules);
  res.json({ ok: true, count: rules.length });
});

app.get('/api/downlinks', authMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json({ list: store.listDownlinks(req.user.id, limit) });
});

app.get('/api/devices/:deviceId/properties', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const latest = store.getLatestForDevice(req.user.id, req.params.deviceId);
  res.json({
    status: 'Success',
    data: {
      properties: latest?.properties || {},
      lastTimestamp: latest?.timestamp != null ? latest.timestamp : null,
    },
  });
});

app.get(
  '/api/devices/:deviceId/thing-specification',
  authMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
  const latest = store.getLatestForDevice(req.user.id, req.params.deviceId);
  const props = latest?.properties || {};
  const flat = flattenTelemetryProps(props);
  const list = Object.keys(flat)
    .sort()
    .map((k) => ({ id: k, propertyKey: k, name: k, unit: '' }));
  res.json({ status: 'Success', data: { properties: list } });
  }
);

app.get('/api/devices/:deviceId/dashboard-widgets', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const widgets = store.getDeviceDashboardWidgets(req.user.id, req.params.deviceId);
  res.json({ status: 'Success', widgets });
});

function handleDashboardWidgetsSave(req, res) {
  try {
    if (!assertDeviceAssignedToUser(req, res, req.params.deviceId)) return;
    const result = validateDashboardWidgets(req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    store.setDeviceDashboardWidgets(req.user.id, req.params.deviceId, result.widgets);
    res.json({ status: 'Success', widgets: result.widgets });
  } catch (e) {
    console.error('[dashboard-widgets]', e);
    res.status(500).json({ error: e.message || 'Error al guardar el tablero' });
  }
}

app.put('/api/devices/:deviceId/dashboard-widgets', authMiddleware, staffOnlyMiddleware, handleDashboardWidgetsSave);
/** Mismo cuerpo que PUT; por si el proxy o el cliente no envían PUT correctamente. */
app.post('/api/devices/:deviceId/dashboard-widgets', authMiddleware, staffOnlyMiddleware, handleDashboardWidgetsSave);

app.get('/api/devices/:deviceId/properties/history', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const { startTime, endTime, pageSize } = req.query;
  const entries = store.getTelemetryHistory(
    req.user.id,
    req.params.deviceId,
    startTime,
    endTime,
    pageSize
  );
  const list = entries.map((t) => ({
    ts: t.timestamp,
    timestamp: t.timestamp,
    properties: t.properties,
  }));
  res.json({ status: 'Success', list });
});

app.put('/api/devices', authMiddleware, staffOnlyMiddleware, (req, res) => {
  const { deviceId, name } = req.body;
  if (!deviceId || !name) return res.status(400).json({ status: 'Error', errMsg: 'deviceId y name requeridos' });
  const idStr = deviceId.toString();
  if (!assertDeviceAssignedToUser(req, res, idStr)) return;
  store.upsertDeviceLabel(req.user.id, idStr, name);
  const ud = store.getUserDevice(req.user.id, idStr);
  if (ud) {
    store.upsertUserDevice({
      ...ud,
      displayName: name,
      updatedAt: new Date().toISOString(),
    });
  }
  res.json({ status: 'Success' });
});

/**
 * Borra la sesión LNS del dispositivo (OTAA). Útil si `rx_delay_sec` o claves quedaron incoherentes:
 * luego reinicie el nodo para volver a unirse.
 */
app.delete('/api/devices/:deviceId/lns/session', authMiddleware, staffOnlyMiddleware, deviceAssignmentMiddleware, (req, res) => {
  if (!getLnsEngine() || process.env.SYSCOM_LNS_MAC === '0') {
    return res.status(501).json({
      status: 'Error',
      errMsg: 'LNS MAC desactivado o motor no cargado.',
      code: 'LNS_DISABLED',
    });
  }
  const idStr = req.params.deviceId.toString();
  const ud = store.getUserDevice(req.user.id, idStr);
  if (!ud) return res.status(404).json({ error: 'Dispositivo no encontrado' });
  const deui = String(ud.devEUI || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (deui.length !== 16) {
    return res.status(400).json({ error: 'El dispositivo debe tener DevEUI (16 hex) para sesión LNS' });
  }
  const deleted = store.lnsDeleteSessionByDevEui(req.user.id, deui);
  res.json({ status: 'Success', deleted: deleted > 0, devEui: deui });
});

app.post('/api/devices/:deviceId/downlink', authMiddleware, staffOnlyMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const eng = getLnsEngine();
  if (!eng || process.env.SYSCOM_LNS_MAC === '0') {
    return res.status(501).json({
      status: 'Error',
      errMsg:
        'LNS MAC desactivado (SYSCOM_LNS_MAC=0) o motor no cargado. Para downlinks LoRaWAN use el LNS integrado (UDP Semtech + OTAA).',
      code: 'LNS_DISABLED',
    });
  }
  const idStr = req.params.deviceId.toString();
  const ud = store.getUserDevice(req.user.id, idStr);
  if (!ud) return res.status(404).json({ error: 'Dispositivo no encontrado' });
  const deui = String(ud.devEUI || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (deui.length !== 16) {
    return res.status(400).json({ error: 'El dispositivo debe tener DevEUI (16 hex) para downlink LoRaWAN' });
  }
  const fpRes = resolveAppFPortForDownlink(store, idStr, req.body || {});
  if (!fpRes.ok) {
    return res.status(400).json({
      status: 'Error',
      errMsg: fpRes.error,
      code: fpRes.code || 'FPORT_REQUIRED',
    });
  }
  const fPort = fpRes.fPort;
  const rawPayload =
    req.body?.payloadHex ??
    req.body?.payload_hex ??
    req.body?.data ??
    req.body?.payload ??
    '';
  const hex = String(rawPayload).replace(/\s/g, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    return res.status(400).json({ error: 'payloadHex inválido (hex par de bytes)' });
  }
  const payloadBuf = Buffer.from(hex, 'hex');
  const confirmedDl = Boolean(req.body?.confirmed);
  try {
    const out = eng.enqueueAppDownlink(req.user.id, deui, fPort, payloadBuf, {
      confirmed: confirmedDl,
      delayMs: req.body?.delayMs != null ? Number(req.body.delayMs) : undefined,
      priority: req.body?.priority != null ? Number(req.body.priority) : undefined,
    });
    appendDownlinkLog(req.user.id, {
      deviceId: idStr,
      devEUI: deui,
      fPort,
      payloadHex: hex,
      lns: true,
      ...out,
    });
    console.log(
      `[LNS] App downlink encolado devEUI=${deui} fPort=${fPort} fCnt=${out.fCnt} class=${out.deviceClass} imme=${out.imme} txAckPending=${out.txAckPending} notBeforeMs=${out.notBeforeMs ?? 0}`
    );
    insertUiEventWithStream(
      req.user.id,
      deui,
      'downlink_sent',
      JSON.stringify({
        deviceId: idStr,
        fPort,
        fCnt: out.fCnt,
        confirmed: confirmedDl,
        deviceClass: out.deviceClass,
        imme: out.imme,
        classARxWindow: out.classARxWindow,
        rxDelaySec: out.rxDelaySec,
        txpkTmst: out.txpkTmst,
        rx1DelayUs: out.rx1DelayUs,
      })
    );
    res.json({ status: 'Success', ...out });
  } catch (e) {
    const code = e.code || 'LNS_DOWNLINK';
    const status =
      code === 'NO_SESSION' ? 400 : code === 'DOWNLINK_IN_FLIGHT' ? 429 : 503;
    console.warn(`[LNS] App downlink rechazado devEUI=${deui} fPort=${fPort}:`, e.message, code);
    res.status(status).json({ status: 'Error', errMsg: e.message, code });
  }
});

app.get('/api/lns/ui-events', authMiddleware, (req, res) => {
  const afterIdQ = req.query?.afterId ?? req.query?.after_id;
  if (afterIdQ != null && afterIdQ !== '') {
    const afterId = Number(afterIdQ);
    const events = store.lnsListUiEventsAfterId(
      req.user.id,
      Number.isFinite(afterId) ? afterId : 0
    );
    return res.json({ status: 'Success', events });
  }
  const since = req.query?.since != null ? Number(req.query.since) : 0;
  const events = store.lnsListUiEventsSince(req.user.id, Number.isFinite(since) ? since : 0);
  res.json({ status: 'Success', events });
});

/**
 * Solo desarrollo/pruebas (SYSCOM_LNS_SIM=1): crea/actualiza sesión LNS mínima para probar cola de downlink
 * sin OTAA por radio. Las claves usan el AppKey del dispositivo como NwkSKey/AppSKey (solo laboratorio).
 */
app.post('/api/lns/sim/seed-session', authMiddleware, staffOnlyMiddleware, (req, res) => {
  if (process.env.SYSCOM_LNS_SIM !== '1') {
    return res.status(404).json({ status: 'Error', errMsg: 'Not found' });
  }
  const deui = String(req.body?.devEui || req.body?.dev_eui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (deui.length !== 16) {
    return res.status(400).json({ status: 'Error', errMsg: 'devEui inválido (16 hex)' });
  }
  let ud = store.getUserDevice(req.user.id, deui);
  if (!ud) {
    ud = store.listUserDevices(req.user.id).find((d) => {
      const x = String(d.devEUI || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toLowerCase();
      return x === deui;
    });
  }
  if (!ud) {
    return res.status(400).json({ status: 'Error', errMsg: 'Dispositivo no asignado a la cuenta' });
  }
  const appKeyHex = String(ud.appKey || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (appKeyHex.length !== 32) {
    return res.status(400).json({ status: 'Error', errMsg: 'AppKey inválido (32 hex) en el dispositivo' });
  }
  const gwIn = String(req.body?.gatewayEui || req.body?.gateway_eui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  const gatewayEui = gwIn.length === 16 ? gwIn : 'aa00000000000001';
  const clsRaw = req.body?.deviceClass ?? req.body?.lorawanClass ?? 'A';
  const cls = String(clsRaw || 'A')
    .trim()
    .toUpperCase();
  const deviceClass = cls === 'B' || cls === 'C' ? cls : 'A';
  const devAddrBuf = store.lnsAllocateDevAddrBuf(req.user.id);
  const devAddr = devAddrBuf.toString('hex').toUpperCase();
  store.lnsUpsertSessionJoin({
    userId: req.user.id,
    devEui: deui,
    devAddr,
    nwkSKeyHex: appKeyHex,
    appSKeyHex: appKeyHex,
    lastGatewayEui: gatewayEui,
    /** tmst > 0 para que downlinks clase A usen ventana RX programada (no `imme`) en simulación. */
    lastRxTmst: 10_000_000,
    lastRxFreq: 904.1,
    lastRxDatr: 'SF12BW125',
    lastRxCodr: '4/5',
    lastRxRfch: 0,
    deviceClass,
    lastUplinkWallMs: Date.now(),
  });
  store.lnsSyncSessionDeviceClass(req.user.id, deui, deviceClass);
  res.json({ status: 'Success', devAddr, gatewayEui, deviceClass, devEui: deui });
});

/** Solo desarrollo/pruebas: confirma recepción de downlink confirmado sin radio (SYSCOM_LNS_SIM=1). */
app.post('/api/lns/sim/ack-confirmed-downlink', authMiddleware, staffOnlyMiddleware, (req, res) => {
  if (process.env.SYSCOM_LNS_SIM !== '1') {
    return res.status(404).json({ status: 'Error', errMsg: 'Not found' });
  }
  const deui = String(req.body?.devEui || req.body?.dev_eui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (deui.length !== 16) {
    return res.status(400).json({ status: 'Error', errMsg: 'devEui inválido (16 hex)' });
  }
  const sess = store.lnsGetSessionByDevEui(req.user.id, deui);
  if (!sess) {
    return res.status(400).json({ status: 'Error', errMsg: 'Sin sesión LNS para este DevEUI' });
  }
  if (!sess.awaitingConfirmedDlAck) {
    return res.status(400).json({
      status: 'Error',
      errMsg: 'No hay downlink confirmado pendiente de ACK del dispositivo',
      code: 'NO_AWAITING_DL_ACK',
    });
  }
  store.lnsClearAwaitingConfirmedDeviceAck(req.user.id, deui);
  insertUiEventWithStream(req.user.id, deui, 'downlink_device_acked', JSON.stringify({ simulated: true }));
  res.json({ status: 'Success', ok: true });
});

app.post(
  '/api/devices/:deviceId/services/call',
  authMiddleware,
  staffOnlyMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
  res.status(501).json({
    status: 'Error',
    errMsg: 'Llamadas a servicios de dispositivo no están activas sin plataforma cloud externa.',
    code: 'INGEST_MODE',
  });
  }
);

// ── Telemetry (cliente autenticado) ───────────────────────
app.get('/api/devices/latest', authMiddleware, (req, res) => {
  const m = store.getLatestMap(req.user.id);
  if (req.user.role === 'superadmin') {
    res.json(Object.values(m));
    return;
  }
  const assigned = new Set(store.listUserDevices(req.user.id).map((r) => String(r.deviceId)));
  const out = Object.values(m).filter(
    (t) => assigned.has(String(t.deviceId)) && store.isLicenseActiveForEndUser(t.deviceId)
  );
  res.json(out);
});

app.post('/api/telemetry', authMiddleware, staffOnlyMiddleware, (req, res) => {
  const { deviceId, deviceName, properties } = req.body;
  const did = deviceId.toString();
  if (store.lastPropertiesJsonEqual(req.user.id, did, properties)) {
    metrics.inc('telemetry_duplicate_skipped');
    return res.status(200).json({ ok: true, saved: false, reason: 'no_change' });
  }
  const ts = Date.now();
  const tUserIds = store.appendTelemetry(req.user.id, did, deviceName, properties, ts);
  metrics.inc('telemetry_saved');
  const ev = {
    deviceId: did,
    deviceName: deviceName || did,
    timestamp: ts,
    properties: sanitizeTelemetryForSse(properties),
  };
  for (const uid of tUserIds) realtimeHub.broadcast(String(uid), 'telemetry', ev);
  res.status(201).json({ ok: true, saved: true });
});

app.get('/api/telemetry/:deviceId', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const { startMs, endMs, propKey } = req.query;
  const entries = store.getTelemetrySeries(
    req.user.id,
    req.params.deviceId,
    startMs,
    endMs,
    propKey,
    500
  );
  res.json(
    entries.map((t) => ({
      id: t.id,
      userId: t.userId,
      deviceId: t.deviceId,
      deviceName: t.deviceName,
      properties: t.properties,
      timestamp: t.timestamp,
    }))
  );
});

// ── Password reset (admin tool) ───────────────────────────
app.post('/api/reset-password', (req, res) => {
  const { email, newPassword, adminSecret } = req.body;
  if (adminSecret !== 'syscom-admin-2024') {
    return res.status(403).json({ error: 'Clave de administrador incorrecta' });
  }
  if (!email || !newPassword) {
    return res.status(400).json({ error: 'Email y nueva contraseña requeridos' });
  }
  const pv = validatePasswordStrength(newPassword);
  if (!pv.ok) return res.status(400).json({ error: pv.error });
  const u = store.getUserByEmail(email);
  if (!u) return res.status(404).json({ error: `No existe usuario con el correo: ${email}` });
  u.password = bcrypt.hashSync(newPassword, 10);
  u.mustChangePassword = true;
  store.updateUserRecord(u);
  res.json({ ok: true, message: `Contraseña actualizada para ${email}` });
});

app.get('/api/admin/users', (req, res) => {
  const { adminSecret } = req.query;
  if (adminSecret !== 'syscom-admin-2024') return res.status(403).json({ error: 'Clave incorrecta' });
  const users = store.allUsersSanitized().map(({ password: _, ...rest }) => rest);
  res.json(users);
});

// ── Setup ──────────────────────────────────────────────────
app.post('/api/setup', (req, res) => {
  const { email, profileName } = req.body;
  if (!email) return res.status(400).json({ error: 'El correo es obligatorio.' });
  if (store.getUserByEmail(email)) {
    return res.status(409).json({
      error: 'Ese correo ya está registrado.',
      code: 'USER_EXISTS',
    });
  }
  const admin = {
    id: Date.now().toString(),
    email,
    password: null,
    role: 'superadmin',
    profileName: profileName || 'Super administrador',
    createdBy: null,
    createdByEmail: null,
    ingestToken: crypto.randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
    mustChangePassword: false,
  };
  store.insertUser(admin);
  res.status(201).json({ ok: true });
});

app.get('/api/setup/status', (req, res) => {
  const users = store.allUsersSanitized();
  const needsSetup = !users.some(
    (u) => (u.role === 'superadmin' || u.role === 'admin') && !u.createdBy
  );
  res.json({ needsSetup });
});

// ── Frontend: prioridad al build Vite (dist); public solo como respaldo ──
const distPath = path.join(__dirname, '../dist');
const publicPath = path.join(__dirname, '../public');

if (fs.existsSync(distPath)) {
  console.log(`📡 UI React (Vite build): ${distPath}`);
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else if (fs.existsSync(publicPath)) {
  console.log(`📡 Sin dist/: sirviendo public/ (ejecute "npm run build" para producción): ${publicPath}`);
  app.use(express.static(publicPath));
} else {
  console.log('⚠️ Sin dist/ ni public/. Ejecute "npm run build" en la raíz del proyecto.');
}

// ── Error handler global ───────────────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`${C.red}${C.bold}[ERROR]${C.reset} ${C.gray}${ts}${C.reset} ${req.method} ${req.path}`);
  console.error(`${C.red}  ${err.stack || err.message || err}${C.reset}`);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: err.message || 'Error interno del servidor' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ SYSCOM IoT API en http://0.0.0.0:${PORT}`);
  console.log(
    `📥 Ingesta: …/api/ingest/<userId>/<token>  |  LoRaWAN/Milesight: …/api/lorawan/uplink/… o …/api/milesight/uplink/…`
  );
  console.log(`📊 Widgets dispositivo: GET | PUT | POST /api/devices/:deviceId/dashboard-widgets`);
  console.log(`📁 Base de datos (SQLite): ${store.dbPath()}`);
  try {
    store.runLicenseMaintenance();
  } catch (e) {
    console.warn('[Syscom] Licencias (arranque):', e.message);
  }
  setInterval(() => {
    try {
      store.runLicenseMaintenance();
    } catch (e) {
      console.warn('[Syscom] Licencias (periódico):', e.message);
    }
  }, 60 * 60 * 1000);
  const { startMqttIngest } = require('./integrations/mqtt/mqtt-ingest');
  startMqttIngest();

  const { getLorawanRegionalPlan, rx2DefaultsFromEnvAndPlan } = require('./lns/lorawan-regional-plan');
  const planInfo = getLorawanRegionalPlan();
  const rx2Ref = rx2DefaultsFromEnvAndPlan();
  if (process.env.SYSCOM_LNS_MAC === '0') {
    console.warn('[LNS] Motor MAC / OTAA / downlink integrado: DESACTIVADO (SYSCOM_LNS_MAC=0).');
  } else {
    getLnsEngine();
    console.log(
      `[LNS] Motor MAC / join / downlink: ACTIVO — plan regional ${planInfo.id} (RX2 ref ${rx2Ref.freq} MHz, ${rx2Ref.datr})`
    );
  }

  if (LNS_UDP_PORT) {
    console.log(
      `[LNS] Listener UDP Semtech GWMP: 0.0.0.0:${LNS_UDP_PORT} (plan ${planInfo.id}) — si el bind falla, reintentos periódicos (LNS_UDP_BIND_RETRY_MS, def. 30s; el API HTTP no se detiene)`
    );
    const { startSemtechUdpLns } = require('./lns/semtech-udp-lns');
    startSemtechUdpLns({
      port: LNS_UDP_PORT,
      store,
      processPushDataJson: (userId, mac, json) => {
        const eng = getLnsEngine();
        if (eng) eng.processPushJson(userId, mac, json);
        else runUplinkPipeline(userId, json);
      },
    });
  } else {
    console.warn(
      '[LNS] Listener UDP Semtech GWMP: DESACTIVADO (LNS_UDP_PORT=0 u off). Sin UDP público no hay packet forwarder GWMP hacia este proceso; use HTTPS ingesta, MQTT o VM/bare metal con reenvío UDP. Ver docs/LNS-SEMTECH-UDP.md'
    );
  }
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ El puerto ${PORT} ya está en uso (otra ventana con npm start, u otra app).`);
    if (process.platform === 'win32') {
      console.error('   1) Ver PID:  netstat -ano | findstr :' + PORT);
      console.error('   2) Cerrar:   taskkill /PID <PID> /F');
      console.error('   3) Otro puerto:  set PORT=3003 && npm start   (y el proxy de Vite al mismo puerto)\n');
    } else {
      console.error(`   1) Ver PID:   lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
      console.error('   2) Cerrar:    kill -9 <PID>');
      console.error(
        '   3) Otro puerto:  PORT=3003 npm start   y en .env: VITE_API_PORT=3003 (proxy de Vite)\n'
      );
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});

if (INGEST_PORT) {
  const ingestApp = express();
  ingestApp.use(cors(buildCorsOptions()));
  ingestApp.use(express.json({ limit: '2mb' }));
  ingestApp.post('/ingest/:userId/:ingestToken', ingestRateLimit, handleIngestRequest);
  ingestApp.post('/lorawan/uplink/:userId/:ingestToken', ingestRateLimit, handleLorawanUplinkRequest);
  ingestApp.post('/milesight/uplink/:userId/:ingestToken', ingestRateLimit, handleLorawanUplinkRequest);
  ingestApp.get('/ingest/:userId/:ingestToken', (req, res) => {
    res.status(200).json({ ok: true, hint: 'POST JSON aquí para enviar telemetría.' });
  });
  ingestApp.get('/health', (_, res) => res.json({ ok: true, service: 'syscom-ingest' }));
  const ingestSrv = ingestApp.listen(INGEST_PORT, '0.0.0.0', () => {
    console.log(`📥 Puerto ingesta dedicado ${INGEST_PORT}: POST http://0.0.0.0:${INGEST_PORT}/ingest/<userId>/<ingestToken>`);
  });
  ingestSrv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ INGEST_PORT=${INGEST_PORT} ocupado. Cierra el proceso o quita INGEST_PORT.\n`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
