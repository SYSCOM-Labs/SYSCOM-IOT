const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeLorawanUplink, expandLorawanPacketBodies } = require('./lorawan-normalize');
const { tryApplyStoredDecoder, enrichStoredTelemetryProperties, prepareDecoderScriptForRuntime } = require('./payload-decoder');
const { shouldSkipTelemetryInsert, isJoinOnlyProperties } = require('./lib/telemetry-persist');
const { resolveWt201DownlinkHex } = require('./lib/wt201-downlink-encode.cjs');
const { remapWs501LegacyDownlinkHex } = require('./lib/ws501-downlink-legacy.cjs');
const { sanitizeTemplatesCatalog } = require('./lib/template-catalog-normalize.cjs');
const { resolveDownlinkDeviceClassForLns } = require('./lib/resolve-downlink-class.cjs');
const {
  normalizeDownlinks,
  syncDeviceTemplateFromCatalog,
  ensureBuiltinCatalogSeeded,
  reconcileFleetTemplatesOnStartup,
} = require('./lib/auto-fleet-sync.cjs');
const { resolveAutomationDownlinkHex } = require('./automation-downlink-resolve');
const { DECODER_SCRIPT: VS133_BUILTIN_DECODER } = require('./milesight-vs133-decoder.cjs');
const {
  normalizeBaseUrl: ugNormalizeBaseUrl,
  ugJsonRequest,
  streamUrpackets,
  loginToGateway,
  invalidateJwt,
} = require('./milesight-ug-gateway-client');
const {
  publishDownlink,
  publishNsRequestAndWait,
  getMqttApiStatus,
} = require('./milesight-mqtt-publisher');
const { store, readLnsTxAckPruneSilenceMs } = require('./store');
const navPerm = require('./navPermissions');
const { flattenTelemetryProps } = require('./lib/telemetryPayloadUtils');
const {
  hasDecodedPeopleCountTelemetry,
  needsMergedTelemetryForList,
  applyVs133TelemetryAliases,
} = require('./lib/vs133-telemetry-aliases');
const { tryBootstrapMilesightAbpSession, retryMilesightAbpBootstrapAll } = require('./milesight-lns-bootstrap');
const { validatePasswordStrength } = require('./password-policy');
const { isAllowedGatewayFrequencyBand } = require('./lorawan-gateway-bands');
const { isUs915ForUserGateway } = require('./lorawan-us915-region');
const metrics = require('./syscom-metrics');
const { createRealtimeHub } = require('./realtime-hub');
const { createRateLimiter } = require('./rate-limit-memory');
const { validateWebhookRelayUrl, relayWebhookPost } = require('./automation-webhook-relay');
const { mountGoogleAuthRoutes } = require('./google-auth-routes');
const { mountMicrosoftAuthRoutes } = require('./microsoft-auth-routes');
const { mountYahooAuthRoutes } = require('./yahoo-auth-routes');
const { mountOAuthProvidersConfig } = require('./oauth-providers-config');
const {
  resolveCommsStaleOfflineMs,
  resolveAppUplinkStaleMs,
  isLastDbIngestStale,
} = require('./comms-stale-policy');

const realtimeSseContract = require(path.join(__dirname, '..', 'shared', 'realtime-sse-contract.json'));

const realtimeHub = createRealtimeHub();

/** Evita reconstruir el listado completo en cada poll del panel (GET /api/devices). */
const DEVICES_LIST_CACHE_MS = Math.min(
  30000,
  Math.max(2000, parseInt(process.env.SYSCOM_DEVICES_LIST_CACHE_MS || '8000', 10) || 8000)
);
const DEVICES_LATEST_CACHE_MS = Math.min(
  15000,
  Math.max(1000, parseInt(process.env.SYSCOM_DEVICES_LATEST_CACHE_MS || '2500', 10) || 2500)
);
let devicesListCache = { key: '', at: 0, content: null };
let devicesLatestCache = { key: '', at: 0, data: null };

function invalidateDevicesLatestCache() {
  devicesLatestCache = { key: '', at: 0, data: null };
}

function invalidateDevicesListCache() {
  devicesListCache = { key: '', at: 0, content: null };
  invalidateDevicesLatestCache();
}

function buildDevicesContentForUser(role, userId) {
  return role === 'superadmin'
    ? buildDevicesContentSuperadmin()
    : buildDevicesContentAssignedOnly(userId);
}

function getDevicesContentCached(role, userId) {
  const key = `${role}:${userId}`;
  const now = Date.now();
  if (
    devicesListCache.key === key &&
    devicesListCache.content &&
    now - devicesListCache.at < DEVICES_LIST_CACHE_MS
  ) {
    return devicesListCache.content;
  }
  const content = buildDevicesContentForUser(role, userId);
  devicesListCache = { key, at: now, content };
  return content;
}

/** No invalidar el listado en cada uplink (apagador cada pocos s); SSE actualiza la UI. Invalidación explícita en altas/bajas. */
store.setTelemetryBroadcastHook(({ userIds, deviceId, deviceName, ts, deviceType, properties }) => {
  const ev = { deviceId, deviceName: deviceName || deviceId, timestamp: ts };
  if (deviceType) ev.deviceType = deviceType;
  if (properties && typeof properties === 'object') ev.properties = properties;
  for (const uid of userIds) {
    realtimeHub.broadcast(String(uid), realtimeSseContract.sseTelemetry, ev);
  }
});
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
/**
 * SEC-02: nunca usar un secreto público constante. En producción el gate de
 * arriba ya aborta si falta JWT_SECRET. Fuera de producción, si no se define,
 * se genera uno ALEATORIO por arranque (las sesiones no sobreviven a reinicios,
 * pero no existe un secreto conocido que permita forjar tokens).
 */
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (() => {
    const ephemeral = crypto.randomBytes(32).toString('hex');
    console.warn(
      '[syscom-iot] JWT_SECRET no definido (modo desarrollo): se usa un secreto aleatorio por arranque; ' +
        'las sesiones no persisten entre reinicios. Defina JWT_SECRET (p. ej. openssl rand -hex 32) para persistirlas.'
    );
    return ephemeral;
  })();

/**
 * Firma de JWT dedicados a integraciones (p. ej. plataforma estilo Datacake → downlink sin sesión web).
 * En producción defina `LNS_INTEGRATION_JWT_SECRET` distinto de `JWT_SECRET`.
 */
const LNS_INTEGRATION_JWT_SECRET =
  process.env.LNS_INTEGRATION_JWT_SECRET || `${JWT_SECRET}:syscom-lns-integration-v1`;

/** Vigencia del JWT de sesión web (pantallas 24/7). Acortar con SYSCOM_JWT_EXPIRES (p. ej. 8h) en entornos exigentes. */
function resolveJwtExpiresIn() {
  const raw = String(process.env.SYSCOM_JWT_EXPIRES || '').trim();
  if (raw !== '') return raw;
  return '365d';
}
const JWT_EXPIRES_IN = resolveJwtExpiresIn();

/** Tras expirar el JWT, POST /api/auth/refresh aún renueva si no pasó este margen (ms). Defecto 7 días (SEC-10). */
const JWT_REFRESH_GRACE_MS = Math.max(
  0,
  Number.parseInt(String(process.env.SYSCOM_JWT_REFRESH_GRACE_MS || '').trim(), 10) || 7 * 24 * 60 * 60 * 1000
);
/**
 * Compatibilidad opcional para endpoints de mantenimiento heredados.
 * Si está vacío, solo se permite acceso autenticado superadmin.
 */
const LEGACY_ADMIN_SECRET = String(process.env.SYSCOM_LEGACY_ADMIN_SECRET || '').trim();

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
    // SEC-03: no reflejar cualquier Origin en producción. Abortar como con JWT_SECRET.
    console.error(
      '[syscom-iot] En NODE_ENV=production debe definir SYSCOM_CORS_ORIGINS (lista separada por comas, p. ej. https://su-dominio.com) o "*" explícito si realmente desea API pública. Abortando para no reflejar cualquier Origin.'
    );
    process.exit(1);
  }
  return { origin: '*' };
}

const app = express();

/**
 * SEC-04: cabeceras de seguridad HTTP (helmet). HSTS, X-Content-Type-Options,
 * X-Frame-Options, Referrer-Policy y CSP. La CSP se afina para un SPA servido
 * desde el mismo origen; si rompe algún recurso del frontend, ajústela o
 * desactívela con SYSCOM_CSP_DISABLE=1 mientras se depura (las demás cabeceras
 * siguen activas).
 */
const cspDisabled = String(process.env.SYSCOM_CSP_DISABLE || '').trim() === '1';
app.use(
  helmet({
    contentSecurityPolicy: cspDisabled
      ? false
      : {
          directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            scriptSrc: ["'self'"],
            // React/Vite inyectan estilos en línea; 'unsafe-inline' solo para estilos.
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            fontSrc: ["'self'", 'data:'],
            // API + SSE en el mismo origen; ws/wss por si se usan herramientas dev.
            connectSrc: ["'self'", 'ws:', 'wss:'],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
            formAction: ["'self'"],
          },
        },
    // El SPA puede embeberse en visores/kioscos del mismo origen; no forzar COEP.
    crossOriginEmbedderPolicy: false,
  })
);

/** Detrás de nginx/Traefik: `SYSCOM_TRUST_PROXY=1` para que `req.ip` y rate-limit usen X-Forwarded-For. */
if (IS_PRODUCTION) {
  const tp = String(process.env.SYSCOM_TRUST_PROXY || '').trim();
  if (tp === '1' || /^true$/i.test(tp)) {
    app.set('trust proxy', 1);
  }
}
const PORT = parseInt(process.env.PORT || '3001', 10);
/** Puerto opcional dedicado a ingesta (gateway → POST /ingest/:userId/:token). Si no se define, solo existe /api/ingest/... en PORT. */
const INGEST_PORT = process.env.INGEST_PORT ? parseInt(process.env.INGEST_PORT, 10) : null;

/**
 * UDP Semtech GWMP (packet forwarder → LNS integrado).
 * Por defecto **1700** para que el LNS por radio esté siempre activo al levantar `npm start`.
 * Desactivar: `LNS_UDP_PORT=0` o `SYSCOM_LNS_UDP=0` (p. ej. Render solo HTTP, o si 1700 está ocupado).
 */
function resolveLnsUdpListenPort() {
  if (String(process.env.SYSCOM_LNS_UDP || '').trim() === '0') return null;
  const raw = process.env.LNS_UDP_PORT;
  if (raw != null && String(raw).trim() !== '') {
    const p = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(p) || p <= 0) return null;
    return p;
  }
  return 1700;
}
const LNS_UDP_PORT = resolveLnsUdpListenPort();
const RETENTION_MS =
  parseInt(process.env.SYSCOM_TELEMETRY_RETENTION_MS, 10) || 365 * 24 * 60 * 60 * 1000;
/** Misma ventana que gateways: sin nueva ingesta en BD → OFFLINE (ver `comms-stale-policy.js`). */
const COMMS_STALE_OFFLINE_MS = resolveCommsStaleOfflineMs();
/** Sin payload de aplicación reciente → no «En línea» aunque haya joins OTAA (p. ej. WT201 cada 1 min). */
const APP_UPLINK_STALE_MS = resolveAppUplinkStaleMs();

/**
 * FPort LoRaWAN para downlinks de aplicación.
 * Origen: 1) cuerpo `fPort` / `fport`; 2) **channel** en `device_decode_config` (heredado de la plantilla);
 * 3) `SYSCOM_LNS_DOWNLINK_DEFAULT_FPORT` en entorno; 4) si no hay nada, **85** (puerto de aplicación habitual Milesight/ChirpStack para codecs UC/WS).
 */
function resolveLnsDownlinkFPort(reqBody, deviceId) {
  const raw = reqBody?.fPort ?? reqBody?.fport;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 223) return n;
  }
  const cfg = store.getDeviceDecodeConfig(String(deviceId));
  const chStr = String(cfg.channel || '').trim();
  if (chStr) {
    const fromConfig = parseInt(chStr, 10);
    if (Number.isInteger(fromConfig) && fromConfig >= 1 && fromConfig <= 223) return fromConfig;
  }
  const envStr = process.env.SYSCOM_LNS_DOWNLINK_DEFAULT_FPORT;
  const envParsed = parseInt(String(envStr != null && String(envStr).trim() !== '' ? envStr : '85'), 10);
  if (Number.isInteger(envParsed) && envParsed >= 1 && envParsed <= 223) return envParsed;
  return 85;
}

function normalizeLnsDeviceClassLetter(raw) {
  const u = String(raw || 'A')
    .trim()
    .toUpperCase();
  return u === 'B' || u === 'C' ? u : 'A';
}

/**
 * Clase reportada por decoders Milesight en telemetría (`lorawan_class`: "Class A"|"Class B"|"Class C"|"Class CtoB").
 * @returns {'A'|'B'|'C'|null} null si no hay dato útil
 */
function normalizeLorawanClassFromTelemetryValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.floor(raw);
    if (n === 1) return 'B';
    if (n === 2 || n === 3) return 'C';
    if (n === 0) return 'A';
    return null;
  }
  const s = String(raw).trim();
  if (!s || /^unknown$/i.test(s)) return null;
  const u = s.toUpperCase();
  if (u === 'B' || u === 'C') return u;
  if (u === 'A') return 'A';
  if (u.includes('CLASS C') || u.includes('CTOB')) return 'C';
  if (u.includes('CLASS B')) return 'B';
  if (u.includes('CLASS A')) return 'A';
  return null;
}

/**
 * `device_decode_config` por `deviceId` de alta y por DevEUI (16 hex) si distinto.
 * Primera fila con `lorawan_class` definido: orden `deviceId` y luego DevEUI (comportamiento previo al merge por `updated_at`).
 */
function decodeConfigLorawanClassRawForUserDevice(deviceId, ud) {
  const keys = [];
  const d = String(deviceId || '').trim();
  if (d) keys.push(d);
  if (ud?.devEUI) {
    const eui = String(ud.devEUI)
      .replace(/[^0-9a-fA-F]/gi, '')
      .toLowerCase();
    if (eui.length === 16 && !keys.some((k) => k.replace(/[^0-9a-fA-F]/gi, '').toLowerCase() === eui)) keys.push(eui);
  }
  for (const key of keys) {
    const cfg = store.getDeviceDecodeConfig(key);
    const raw = cfg.lorawanClass ?? cfg.lorawan_class;
    if (raw != null && String(raw).trim() !== '') return String(raw).trim();
  }
  return null;
}

function lorawanClassFromLatestTelemetry(userId, deviceId) {
  if (userId == null || !deviceId) return null;
  try {
    const row = store.getLatestForDevice(userId, String(deviceId));
    const p = row?.properties;
    if (!p || typeof p !== 'object') return null;
    const v = p.lorawan_class ?? p.lorawanClass;
    return normalizeLorawanClassFromTelemetryValue(v);
  } catch {
    return null;
  }
}

/**
 * Clase usada para temporizar downlinks (RX1/RX2 vs inmediato).
 * Orden: cuerpo `lorawanClass`/`deviceClass` → **plantilla en catálogo** (`catalogTemplateId` / modelo) →
 * **`device_decode_config.lorawan_class`** → **`user_devices.lorawan_class`** → sesión LNS → telemetría (si no está
 * `SYSCOM_LNS_DOWNLINK_IGNORE_TELEMETRY_CLASS=1`).
 * El tipo **0x09** Shengda puede exponer «Class B» en telemetría sin que el downlink deba temporizarse como B; use
 * `SYSCOM_LNS_DOWNLINK_IGNORE_TELEMETRY_CLASS=1` o fije clase en decode-config / cuerpo del POST.
 * La plantilla en solo-localStorage no aplica hasta `PUT …/decode-config` o «Propagar a vinculados».
 */
function resolveDownlinkDeviceClass(reqBody, deviceId, ud, sessionFallbackClass, userId) {
  const ex = reqBody?.deviceClass ?? reqBody?.lorawanClass;
  if (ex != null && String(ex).trim() !== '') {
    return normalizeLnsDeviceClassLetter(ex);
  }
  const deui = String(ud?.devEUI || ud?.devEui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (deui.length === 16) {
    return normalizeLnsDeviceClassLetter(
      resolveDownlinkDeviceClassForLns(store, userId, deui, {
        sessionClass: sessionFallbackClass,
        deviceId: String(deviceId),
        productModel: ud?.productModel || ud?.model,
      })
    );
  }
  const fromDecRaw = decodeConfigLorawanClassRawForUserDevice(deviceId, ud);
  if (fromDecRaw != null && String(fromDecRaw).trim() !== '') {
    return normalizeLnsDeviceClassLetter(fromDecRaw);
  }
  if (ud?.lorawanClass != null && String(ud.lorawanClass).trim() !== '') {
    return normalizeLnsDeviceClassLetter(ud.lorawanClass);
  }
  const skipTelRaw = process.env.SYSCOM_LNS_DOWNLINK_IGNORE_TELEMETRY_CLASS;
  const skipTel =
    skipTelRaw == null || String(skipTelRaw).trim() === ''
      ? true
      : String(skipTelRaw).trim() === '1';
  const fromTel = skipTel ? null : lorawanClassFromLatestTelemetry(userId, deviceId);
  if (fromTel != null) {
    return normalizeLnsDeviceClassLetter(fromTel);
  }
  return normalizeLnsDeviceClassLetter('A');
}

function normalizeDeviceSharedPresetsBody(body, deviceId) {
  const cfg = deviceId ? store.getDeviceDecodeConfig(String(deviceId)) : null;
  const pm = cfg?.productModel || '';
  const rawDown = Array.isArray(body?.downlinks)
    ? body.downlinks
        .map((d) => ({
          name: String(d?.name || '').trim(),
          hex: String(d?.hex || '')
            .trim()
            .replace(/\s/g, '')
            .toLowerCase()
            .replace(/^0x/, ''),
        }))
        .filter((d) => d.name && d.hex)
    : [];
  const downlinks = normalizeDownlinks(rawDown, pm);
  const catalogTemplateId =
    body?.catalogTemplateId != null && String(body.catalogTemplateId).trim()
      ? String(body.catalogTemplateId).trim()
      : null;
  const telemetryLabels =
    body?.telemetryLabels && typeof body.telemetryLabels === 'object' && !Array.isArray(body.telemetryLabels)
      ? body.telemetryLabels
      : {};
  return { downlinks, catalogTemplateId, telemetryLabels };
}

function attachDeviceSharedPresetsToContent(content) {
  if (!Array.isArray(content) || content.length === 0) return;
  const ids = [];
  for (const row of content) {
    if (row && row.deviceId) ids.push(row.deviceId);
  }
  const map = store.getDeviceSharedPresetsMap(ids);
  for (const row of content) {
    const p = map[row.deviceId];
    if (!p || typeof p !== 'object') continue;
    row.deviceSharedPresets = {
      downlinks: Array.isArray(p.downlinks) ? p.downlinks : [],
      catalogTemplateId:
        p.catalogTemplateId != null && String(p.catalogTemplateId).trim()
          ? String(p.catalogTemplateId).trim()
          : null,
      telemetryLabels:
        p.telemetryLabels && typeof p.telemetryLabels === 'object' && !Array.isArray(p.telemetryLabels)
          ? p.telemetryLabels
          : {},
    };
  }
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

/** Campos de atribución para `downlink_log` (usuario vs regla de automatización). */
function downlinkLogAttributionFields(userId, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const src = String(m.logSource || m.source || 'user')
    .trim()
    .toLowerCase();
  if (src === 'automation') {
    const ruleName =
      m.ruleName != null && String(m.ruleName).trim()
        ? String(m.ruleName).trim()
        : m.ruleId != null
          ? String(m.ruleId)
          : 'Regla';
    return {
      source: 'automation',
      ruleId: m.ruleId != null ? String(m.ruleId) : null,
      ruleName,
    };
  }
  let actorUserName = m.actorUserName != null ? String(m.actorUserName).trim() : '';
  if (!actorUserName) {
    const u = store.getUserById(userId);
    actorUserName = String(u?.profileName || u?.email || 'Usuario').trim() || 'Usuario';
  }
  return { source: 'user', actorUserName };
}

/** Modelo en listado: muchos uplinks envían `deviceType` (o HW) cuando `model` viene vacío. */
function deviceModelFromTelemetryProps(p) {
  const o = p && typeof p === 'object' ? p : {};
  const m = String(o.model || '').trim();
  if (m) return m;
  return String(o.deviceType || o.hardwareVersion || '').trim();
}

/** Texto guardado en `user_devices.product_model` (p. ej. plantilla al alta). */
function productModelFromUserDeviceReg(reg) {
  if (!reg || reg.productModel == null) return '';
  return String(reg.productModel).trim();
}

/** Modelo de producto: alta (`user_devices`) o plantilla aplicada (`device_decode_config`). */
function resolvedDeviceProductModel(store, deviceId, reg) {
  const fromUd = productModelFromUserDeviceReg(reg);
  if (fromUd) return fromUd;
  const cfg = store.getDeviceDecodeConfig(deviceId);
  const fromDec = cfg && cfg.productModel != null ? String(cfg.productModel).trim() : '';
  return fromDec;
}

/** Excluye pseudo-dispositivos de telemetría LoRaWAN (p. ej. `gateway-<EUI>`) del listado de Dispositivos. */
function isGatewayPseudoDeviceId(deviceId) {
  const id = String(deviceId || '').trim().toLowerCase();
  if (!id.startsWith('gateway-')) return false;
  const hex = id.slice(8);
  return /^[0-9a-f]{8,32}$/.test(hex);
}

function normalizeDevIdKey(s) {
  return String(s || '').replace(/[^0-9a-fA-F]/gi, '').toLowerCase();
}

/** Telemetría generada por el LNS al encolar Join-Accept (sin payload de aplicación / conteo). */
function joinOnlyTelemetryHint(properties) {
  if (!properties || typeof properties !== 'object') return null;
  if (hasDecodedPeopleCountTelemetry(properties)) return null;
  const ev = properties.lorawan_event != null ? String(properties.lorawan_event).trim() : '';
  if (!ev || !/join/i.test(ev)) return null;
  const hex = properties.payload_hex != null ? String(properties.payload_hex).trim() : '';
  if (hex.length > 0) return null;
  return 'Solo join LoRaWAN (sin uplink de aplicación reciente). Espere el próximo reporte del sensor o revise intervalo de envío en el equipo.';
}

/** Fila del listado de dispositivos con telemetría fusionada y `ingestStatus` coherente. */
function mapDeviceListTelemetryRow(t, resolveName) {
  const p = t.properties || {};
  const name = resolveName(t, p);
  const ingestHint = joinOnlyTelemetryHint(p);
  const row = {
    deviceId: t.deviceId,
    name,
    sn: p.sn || p.deviceSn || t.deviceId,
    connectStatus: p.connectStatus || p.status,
    electricity: p.electricity,
    rssi: p.rssi,
    ...p,
    name,
    model: deviceModelFromTelemetryProps(p),
    lastUpdateTime: t.timestamp,
  };
  if (ingestHint) row.ingestStatus = ingestHint;
  else delete row.ingestStatus;
  return row;
}

/** Última telemetría: por device_id, DevEUI en columna o clave guardada bajo DevEUI (LNS). */
/** Superadmin: telemetría bajo la cuenta que realmente ingirió el dato. */
function telemetryUserIdForRequest(req, deviceId) {
  return store.resolveTelemetryUserId(req.user.id, String(deviceId || ''), { role: req.user.role });
}

function getUserDeviceForActorReq(req, deviceId) {
  return store.getUserDeviceForActor(req.user.id, req.user.role, deviceId);
}

function findLatestTelemetryForRegistration(latestMap, reg) {
  if (!latestMap || !reg) return null;
  const did = String(reg.deviceId || '').trim();
  if (did && latestMap[did]) return latestMap[did];

  const didNorm = normalizeDevIdKey(did);
  if (didNorm.length >= 8) {
    for (const [k, v] of Object.entries(latestMap)) {
      if (normalizeDevIdKey(k) === didNorm) return v;
    }
  }

  const eui = normalizeDevIdKey(reg.devEUI || (didNorm.length === 16 ? did : ''));
  if (eui.length === 16) {
    if (latestMap[eui]) return latestMap[eui];
    for (const [k, v] of Object.entries(latestMap)) {
      if (normalizeDevIdKey(k) === eui) return v;
      const props = v && v.properties && typeof v.properties === 'object' ? v.properties : {};
      const pe = normalizeDevIdKey(props.devEUI || props.devEui);
      if (pe === eui) return v;
    }
  }
  return null;
}

/** Último ts de ingesta en BD para el usuario; si es antiguo, forzar OFFLINE en el listado. */
function applyStaleOfflineFromTelemetryRow(row, telemetryRow) {
  if (!telemetryRow || telemetryRow.timestamp == null) return;
  const ts = Number(telemetryRow.timestamp);
  if (!Number.isFinite(ts)) return;
  if (isLastDbIngestStale(ts, Date.now(), COMMS_STALE_OFFLINE_MS)) {
    row.connectStatus = 'OFFLINE';
  }
}

/**
 * Estado de conexión para el listado: usa el último paquete en aire (raw) y la edad del último uplink de app.
 * Evita marcar ONLINE al fusionar telemetría vieja cuando el nodo solo envía joins OTAA.
 * @param {object} row Fila del listado
 * @param {object} telemetryRow Telemetría mostrada (puede ser fusionada)
 * @param {object|null} [rawLatestRow] Última fila en BD sin fusionar
 */
function inferFreshOnlineConnectStatus(row, telemetryRow, rawLatestRow = null) {
  if (!telemetryRow || telemetryRow.timestamp == null) return;
  const now = Date.now();
  const activityTs = Number(telemetryRow.timestamp);
  if (!Number.isFinite(activityTs)) return;
  if (isLastDbIngestStale(activityTs, now, COMMS_STALE_OFFLINE_MS)) return;

  const displayProps = telemetryRow.properties || {};
  const rawProps =
    rawLatestRow && rawLatestRow.properties && typeof rawLatestRow.properties === 'object'
      ? rawLatestRow.properties
      : displayProps;

  const lastAppTs = Number(displayProps.lastAppUplinkMs);
  const hasAppTs = Number.isFinite(lastAppTs) && lastAppTs > 0;
  const appStale = hasAppTs && isLastDbIngestStale(lastAppTs, now, APP_UPLINK_STALE_MS);

  if (joinOnlyTelemetryHint(rawProps)) {
    row.connectStatus = appStale ? 'OFFLINE' : 'JOIN_PENDING';
    if (appStale) {
      row.ingestStatus =
        'Sin reporte de aplicación reciente (solo join OTAA). Revise ToolBox: Activate, App Key, LoRaWAN 1.0.3, Rejoin OFF.';
    }
    if (hasAppTs) row.lastUpdateTime = lastAppTs;
    return;
  }

  if (appStale) {
    row.connectStatus = 'OFFLINE';
    row.ingestStatus =
      row.ingestStatus ||
      'Último reporte de sensor antiguo. El equipo no cumple el intervalo configurado (p. ej. 1 min).';
    if (hasAppTs) row.lastUpdateTime = lastAppTs;
    return;
  }

  const p = displayProps;
  if (joinOnlyTelemetryHint(p)) {
    row.connectStatus = 'JOIN_PENDING';
    return;
  }
  const cs = row.connectStatus != null ? String(row.connectStatus).trim() : '';
  const csU = cs.toUpperCase();
  if (csU === 'JOINED' || csU === 'CONNECTED') {
    row.connectStatus = 'ONLINE';
    return;
  }
  if (csU === 'JOIN' || csU === 'JOIN_PENDING') return;
  if (cs) return;
  row.connectStatus = 'ONLINE';
}

function attachLicenseFieldsToDeviceRow(row, licenseMeta) {
  const did = row && row.deviceId;
  if (!did) return;
  const m = licenseMeta !== undefined ? licenseMeta : store.getDeviceLicenseMeta(did);
  if (!m) return;
  row.licenseStartedAt = m.startedAt;
  row.licenseExpiresAt = m.expiresAt;
  row.licensePurgeAt = m.purgeAt;
  row.licenseExpiredForUsers = m.expiredForUsers;
  row.licenseInSuperadminGrace = m.inSuperadminGrace;
}

function normalizeListLorawanClassLetter(raw) {
  const u = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (u === 'B' || u === 'C') return u;
  return 'A';
}

/** Clase efectiva para la UI (user_devices → plantilla decode). */
function resolveLorawanClassForDeviceRow(deviceId, reg, assigns, decodeCfg) {
  const did = String(deviceId || '').trim();
  if (reg && reg.lorawanClass != null && String(reg.lorawanClass).trim() !== '') {
    return normalizeListLorawanClassLetter(reg.lorawanClass);
  }
  if (Array.isArray(assigns)) {
    for (const a of assigns) {
      if (a && a.lorawanClass != null && String(a.lorawanClass).trim() !== '') {
        return normalizeListLorawanClassLetter(a.lorawanClass);
      }
    }
  }
  try {
    const dec = decodeCfg || store.getDeviceDecodeConfig(did);
    if (dec && dec.lorawanClass != null && String(dec.lorawanClass).trim() !== '') {
      return normalizeListLorawanClassLetter(dec.lorawanClass);
    }
  } catch {
    /* ignore */
  }
  return 'A';
}

function productModelFromDecodeCfg(decodeCfg) {
  return decodeCfg && decodeCfg.productModel != null ? String(decodeCfg.productModel).trim() : '';
}

function resolvedDeviceProductModelFast(deviceId, reg, decodeMap) {
  const fromUd = productModelFromUserDeviceReg(reg);
  if (fromUd) return fromUd;
  const did = String(deviceId || '').trim();
  const fromDec = decodeMap && decodeMap[did] ? productModelFromDecodeCfg(decodeMap[did]) : '';
  return fromDec;
}

/**
 * Admin y usuario: solo dispositivos explícitamente asignados (user_devices).
 * No se listan equipos que solo tengan telemetría huérfana bajo su user_id.
 */
function buildDevicesContentAssignedOnly(userId) {
  const labels = store.getDeviceLabels(userId);
  const labelById = Object.fromEntries(labels.map((l) => [l.deviceId, l.displayName]));
  const registered = store.listUserDevices(userId);
  const regIds = registered.map((r) => r.deviceId).filter(Boolean);
  const decodeMap = store.getDeviceDecodeConfigMap(regIds);
  const licenseMap = store.getDeviceLicenseMetaMap(regIds);
  const latestRawMap = store.getLatestMap(userId);
  const mergedMap = store.getDeviceListTelemetryMap(userId, regIds, decodeMap, { historyRowLimit: 16 });

  const content = [];
  for (const reg of registered) {
    if (isGatewayPseudoDeviceId(reg.deviceId)) continue;
    const t = mergedMap[reg.deviceId];
    if (t) {
      const row = mapDeviceListTelemetryRow(t, (tel, p) =>
        labelById[tel.deviceId] || tel.deviceName || p.deviceName || tel.deviceId
      );
      applyStaleOfflineFromTelemetryRow(row, t);
      inferFreshOnlineConnectStatus(row, t, latestRawMap[reg.deviceId] || null);
      if (reg.displayName) row.name = reg.displayName;
      if (reg.devEUI && !row.devEUI && !row.devEui) row.devEUI = reg.devEUI;
      const tplModel = resolvedDeviceProductModelFast(reg.deviceId, reg, decodeMap);
      row.productModel = tplModel;
      row.model =
        tplModel ||
        String(row.model || '').trim() ||
        deviceModelFromTelemetryProps(t.properties || {});
      row.tag = reg.tag != null ? String(reg.tag) : '';
      row.registered = true;
      attachLicenseFieldsToDeviceRow(row, licenseMap[reg.deviceId]);
      row.lorawanClass = resolveLorawanClassForDeviceRow(reg.deviceId, reg, null, decodeMap[reg.deviceId]);
      content.push(row);
    } else {
      const tplModel = resolvedDeviceProductModelFast(reg.deviceId, reg, decodeMap);
      const row = {
        deviceId: reg.deviceId,
        name: reg.displayName || reg.deviceId,
        sn: reg.devEUI || reg.deviceId,
        model: tplModel,
        productModel: tplModel,
        connectStatus: 'Sin telemetría',
        registered: true,
        registeredOnly: true,
        lastUpdateTime: null,
        devEUI: reg.devEUI || undefined,
        notes: reg.notes || undefined,
        tag: reg.tag != null ? String(reg.tag) : '',
      };
      attachLicenseFieldsToDeviceRow(row, licenseMap[reg.deviceId]);
      row.lorawanClass = resolveLorawanClassForDeviceRow(reg.deviceId, reg, null, decodeMap[reg.deviceId]);
      content.push(row);
    }
  }
  attachDeviceSharedPresetsToContent(content);
  return content;
}

/** Vista global para superadmin: todos los dispositivos + asignaciones (correo / rol). */
function buildDevicesContentSuperadmin() {
  const udList = store.listUserDevicesWithAccounts();
  const labelsByDevice = store.getAllLabelsGroupedByDevice();

  const assignByDevice = {};
  const anyUdByDevice = {};
  for (const u of udList) {
    if (!assignByDevice[u.deviceId]) assignByDevice[u.deviceId] = [];
    assignByDevice[u.deviceId].push({
      email: u.email,
      role: u.role,
      userId: u.userId,
      displayName: u.displayName,
      tag: u.tag != null ? String(u.tag) : '',
      productModel: u.productModel != null ? String(u.productModel) : '',
      lorawanClass: u.lorawanClass != null ? String(u.lorawanClass) : '',
    });
    if (!anyUdByDevice[u.deviceId]) {
      anyUdByDevice[u.deviceId] = u;
    }
  }

  const deviceIds = new Set();
  for (const u of udList) {
    deviceIds.add(u.deviceId);
  }
  for (const licDid of store.listLicensedDeviceIds()) {
    deviceIds.add(licDid);
  }

  const deviceIdList = [...deviceIds];
  const decodeMap = store.getDeviceDecodeConfigMap(deviceIdList);
  const licenseMap = store.getDeviceLicenseMetaMap(deviceIdList);

  const superadminIds = store.listSuperadminUserIds();
  const resolveSeedUserId = superadminIds[0] || '';
  const telemetryUserCache = new Map();
  const byTelemetryUser = new Map();
  for (const deviceId of deviceIdList) {
    if (isGatewayPseudoDeviceId(deviceId)) continue;
    const anyUd = anyUdByDevice[deviceId];
    const reg0 = (assignByDevice[deviceId] || [])[0];
    const seedUser =
      (anyUd && anyUd.userId) || (reg0 && reg0.userId) || resolveSeedUserId;
    let tuid = telemetryUserCache.get(deviceId);
    if (!tuid) {
      tuid = store.resolveTelemetryUserId(seedUser, deviceId, { role: 'superadmin' });
      telemetryUserCache.set(deviceId, tuid);
    }
    if (!byTelemetryUser.has(tuid)) byTelemetryUser.set(tuid, []);
    byTelemetryUser.get(tuid).push(deviceId);
  }
  const latestRawByDevice = {};
  const mergedByDevice = {};
  for (const [tuid, dids] of byTelemetryUser) {
    Object.assign(latestRawByDevice, store.getLatestMap(tuid));
    Object.assign(
      mergedByDevice,
      store.getDeviceListTelemetryMap(tuid, dids, decodeMap, { historyRowLimit: 16 })
    );
  }

  const content = [];
  for (const deviceId of deviceIdList) {
    if (isGatewayPseudoDeviceId(deviceId)) continue;
    const assigns = assignByDevice[deviceId] || [];
    const anyUd = anyUdByDevice[deviceId] || store.getAnyUserDeviceForDeviceId(deviceId);
    const labelOpts = labelsByDevice[deviceId] || [];
    const reg0 = assigns[0];
    const decCfg = decodeMap[deviceId];
    const t = mergedByDevice[deviceId];

    let row;
    if (t) {
      row = mapDeviceListTelemetryRow(t, (tel, p) => tel.deviceName || p.deviceName || tel.deviceId);
      applyStaleOfflineFromTelemetryRow(row, t);
      inferFreshOnlineConnectStatus(row, t, latestRawByDevice[deviceId] || null);
      const lbl = labelOpts.find((l) => assigns.some((a) => a.userId === l.userId));
      if (lbl) row.name = lbl.displayName;
      else if (reg0 && reg0.displayName) row.name = reg0.displayName;
      else if (anyUd && anyUd.displayName) row.name = anyUd.displayName;
    } else {
      row = {
        deviceId,
        name: (reg0 && reg0.displayName) || (anyUd && anyUd.displayName) || deviceId,
        sn: (anyUd && anyUd.devEUI) || deviceId,
        model: '',
        connectStatus: 'Sin telemetría',
        registeredOnly: true,
        lastUpdateTime: null,
      };
    }
    const tagPick = assigns.map((a) => String(a.tag || '').trim()).find(Boolean);
    row.tag = tagPick || '';
    const tplFromDecode = productModelFromDecodeCfg(decCfg);
    const tplModel =
      assigns.map((a) => String(a.productModel || '').trim()).find(Boolean) || tplFromDecode;
    row.productModel = tplModel;
    row.model =
      tplModel ||
      String(row.model || '').trim() ||
      (t ? deviceModelFromTelemetryProps(t.properties || {}) : '');
    row.registered = assigns.length > 0;
    row.assignments = assigns.map((a) => ({ email: a.email, role: a.role, displayName: a.displayName }));
    row.superadminGlobalView = true;
    attachLicenseFieldsToDeviceRow(row, licenseMap[deviceId]);
    row.lorawanClass = resolveLorawanClassForDeviceRow(deviceId, anyUd, assigns, decCfg);
    content.push(row);
  }
  content.sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)));
  attachDeviceSharedPresetsToContent(content);
  return content;
}

const automationPerm = require('./lib/automation-permissions.cjs');
const canRunAutomationsForUser = automationPerm.canRunAutomationsForUser;
const canUseGlobalNotificationEmailForUser = automationPerm.canUseGlobalNotificationEmailForUser;

/**
 * Superadmin puede no tener fila en `user_devices` pero operar el equipo; la sesión LNS suele estar bajo el
 * usuario que recibió el join (gateway). Opciones extra para `tryLnsAppDownlinkEnqueue`.
 */
function downlinkRequestContext(req, deviceIdStr) {
  const idStr = String(deviceIdStr || '').trim();
  const allowGlobal = req.user && req.user.role === 'superadmin';
  const ud = store.getUserDeviceForLnsDownlink(req.user.id, idStr, { allowUnassignedCross: allowGlobal });
  return {
    ud,
    lnsOpts: { allowGlobalSessionFallback: allowGlobal },
  };
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
  return true;
}

function deviceAssignmentMiddleware(req, res, next) {
  if (!assertDeviceAssignedToUser(req, res, req.params.deviceId)) return;
  next();
}

/** Avatar público asociado al correo (Gravatar); muchas cuentas Gmail usan la misma foto allí. */
function profileAvatarUrl(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return '';
  const h = crypto.createHash('md5').update(e).digest('hex');
  return `https://www.gravatar.com/avatar/${h}?s=160&d=identicon&r=pg`;
}

/**
 * @param {object} user fila usuario (BD)
 * @param {{ impersonatorId?: string }} [opts] si `impersonatorId` está definido, JWT = sesión de soporte (superadmin viendo otra cuenta)
 */
function sessionJwtPayload(user, opts = {}) {
  const impersonatorId =
    opts && opts.impersonatorId != null && String(opts.impersonatorId).trim()
      ? String(opts.impersonatorId).trim()
      : '';
  const isImpersonation = Boolean(impersonatorId);
  const nav = navPerm.effectiveNavForUser(user);
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    profileName: user.profileName,
    mustChangePassword: isImpersonation ? false : Boolean(user.mustChangePassword),
    avatarUrl: profileAvatarUrl(user.email),
    nav,
  };
  if (impersonatorId) payload.impersonatorId = impersonatorId;
  return payload;
}

/** Respuestas API: sin contraseña de app ni contraseña del gateway. */
function sanitizeUserRecord(user) {
  if (!user) return user;
  const { password: _pw, navPermissionsJson: _npj, ...rest } = user;
  let milesightUgGateway = rest.milesightUgGateway;
  if (milesightUgGateway && typeof milesightUgGateway === 'object') {
    milesightUgGateway = {
      baseUrl: milesightUgGateway.baseUrl || '',
      apiUsername: milesightUgGateway.apiUsername || '',
      rejectUnauthorized: milesightUgGateway.rejectUnauthorized !== false,
      hasApiPassword: Boolean(milesightUgGateway.apiPassword),
    };
  }
  return {
    ...rest,
    milesightUgGateway,
    mustChangePassword: Boolean(user.mustChangePassword),
    avatarUrl: profileAvatarUrl(user.email),
    nav: navPerm.effectiveNavForUser(user),
  };
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

/** Si el uplink trae DevEUI pero el alta usó otro `device_id`, enlazar a la fila user_devices de esa cuenta. */
function resolveRegisteredUserDeviceForIngest(userId, canonicalDeviceId, incomingIdentifiers) {
  const c = String(canonicalDeviceId || '').trim();
  let reg = store.getUserDevice(userId, c);
  if (reg) return reg;
  const tried = new Set([normalizeId(c)].filter(Boolean));
  for (const x of incomingIdentifiers || []) {
    const n = normalizeId(x);
    if (n) tried.add(n);
  }
  for (const id of tried) {
    if (id.length !== 16 || !/^[0-9a-f]+$/.test(id)) continue;
    reg = store.getUserDeviceByDevEuiNorm(userId, id);
    if (reg) return reg;
  }
  return null;
}

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

  /** GWMP / ChirpStack: primera rxpk con RSSI, SNR, frecuencia y DR. */
  const rxList = Array.isArray(data.rxpk) ? data.rxpk : Array.isArray(data.rxPK) ? data.rxPK : null;
  if (rxList && rxList.length > 0) {
    const pk = rxList[0];
    if (pk && typeof pk === 'object') {
      if (pk.rssi != null && Number.isFinite(Number(pk.rssi))) properties.rssi = Number(pk.rssi);
      if (pk.lsnr != null && Number.isFinite(Number(pk.lsnr))) {
        const sn = Number(pk.lsnr);
        properties.lsnr = sn;
        properties.snr = sn;
      } else if (pk.snr != null && Number.isFinite(Number(pk.snr))) {
        properties.snr = Number(pk.snr);
      }
      if (pk.freq != null && Number.isFinite(Number(pk.freq))) properties.freq = Number(pk.freq);
      if (pk.datr != null && String(pk.datr).trim() !== '') {
        const dr = String(pk.datr).trim();
        properties.datr = dr;
        properties.dr = dr;
        properties.datarate = dr;
      }
    }
  }

  const metaKeys = new Set([
    'device_id', 'deviceSn', 'deviceEui', 'deviceId', 'devEui', 'devEUI', 'sn', 'deviceName', 'device_name', 'name',
    'timestamp', 'ts', 'time', 'userId', 'event', 'type', 'data', 'properties', 'metrics', 'measurements', 'fields',
    'ack', 'fport', 'method', 'nonce', 'sign', 'hardware_id', 'payload', 'rxpk', 'rxPK',
  ]);

  // Recursivo para extraer RSSI, SNR, etc de objetos como rxInfo (ChirpStack) o metadata (Milesight)
  const extractNested = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(extractNested);
      return;
    }
    Object.keys(obj).forEach((k) => {
      const lowK = k.toLowerCase();
      const val = obj[k];
      if (
        lowK === 'rssi' ||
        lowK === 'snr' ||
        lowK === 'lsnr' ||
        lowK === 'lorasnr' ||
        lowK === 'frequency' ||
        lowK === 'freq' ||
        lowK === 'dr' ||
        lowK === 'datarate' ||
        lowK === 'datr'
      ) {
        if (typeof val !== 'object') {
          properties[k] = val;
          if (lowK === 'lsnr' || lowK === 'lorasnr') properties.snr = val;
          if (lowK === 'frequency') properties.freq = val;
          if (lowK === 'datr' || lowK === 'datarate') {
            properties.dr = val;
            properties.datarate = val;
          }
        }
      }
      if (val && typeof val === 'object' && !metaKeys.has(k)) {
        extractNested(val);
      }
    });
  };
  extractNested(data);

  Object.keys(data).forEach((key) => {
    if (!metaKeys.has(key) && (typeof data[key] !== 'object' || data[key] === null)) {
      properties[key] = data[key];
    }
  });

  return { rawDeviceId, deviceName, properties };
}

/**
 * SEC-05: protección anti-replay por frame counter (fCnt) en la ingesta.
 * Estado en memoria por (userId, deviceId) con el último fCnt aceptado.
 * Se rechaza un uplink cuyo fCnt no avanza respecto al último visto, salvo:
 *   - rejoin (fCnt muy bajo: 0..2) → contador reiniciado por el nodo,
 *   - rollover (caída mayor que medio rango de 16 bits) → 65535→0.
 * Desactivable con SYSCOM_INGEST_FCNT_REPLAY_GUARD=0. No afecta uplinks sin fCnt.
 */
const lastUplinkFcntByDevice = new Map();
const FCNT_REPLAY_GUARD_ON = String(process.env.SYSCOM_INGEST_FCNT_REPLAY_GUARD || '1').trim() !== '0';
const FCNT_ROLLOVER_GAP = 32768; // medio rango de un contador de 16 bits

function isReplayByFcnt(userId, deviceId, fcnt) {
  if (!FCNT_REPLAY_GUARD_ON) return false;
  if (fcnt == null || !Number.isFinite(fcnt)) return false; // sin fCnt no aplicamos
  const key = `${userId}:${deviceId}`;
  const prev = lastUplinkFcntByDevice.get(key);
  if (prev == null) {
    lastUplinkFcntByDevice.set(key, fcnt);
    return false;
  }
  if (fcnt > prev) {
    lastUplinkFcntByDevice.set(key, fcnt);
    return false; // avance normal
  }
  // fcnt <= prev: posible replay/reordenado, salvo rejoin o rollover.
  const rejoin = fcnt <= 2; // nodo reinició el contador (join/rejoin)
  const rollover = prev - fcnt > FCNT_ROLLOVER_GAP; // 65535 → 0
  if (rejoin || rollover) {
    lastUplinkFcntByDevice.set(key, fcnt);
    return false;
  }
  // Limpieza acotada del Map para no crecer sin límite.
  if (lastUplinkFcntByDevice.size > 5000) {
    let i = 0;
    for (const k of lastUplinkFcntByDevice.keys()) {
      lastUplinkFcntByDevice.delete(k);
      if (++i >= 1000) break;
    }
  }
  return true; // replay: fCnt no avanzó y no es rejoin/rollover
}

function saveIngestEntry(userId, data) {
  const { rawDeviceId, deviceName, properties: baseProps } = extractIngestProperties(data);

  if (!rawDeviceId) {
    return { ok: true, test: true, message: 'Sin device id (aceptado como prueba)' };
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
  let canonicalDeviceId = resolveCanonicalDeviceId(userId, incomingIdentifiers) || rawDeviceId.toString();
  canonicalDeviceId = String(canonicalDeviceId).trim();
  const normalizedDeviceName = deviceName || canonicalDeviceId;

  // Syscom-IoT: Filtro de seguridad para evitar auto-descubrimiento de dispositivos "falsos" (ruido de radio)
  // Ignoramos dispositivos que no están en user_devices, a menos que sea un pseudo-dispositivo de Gateway.
  // LNS / muchos gateways identifican por DevEUI; el `device_id` dado de alta puede ser otro → resolver por dev_eui.
  if (!isGatewayPseudoDeviceId(canonicalDeviceId)) {
    const registered = resolveRegisteredUserDeviceForIngest(userId, canonicalDeviceId, incomingIdentifiers);
    if (!registered) {
      return { ok: true, saved: false, message: 'Dispositivo no registrado en la cuenta' };
    }
    canonicalDeviceId = String(registered.deviceId);
  }

  // SEC-05: descartar uplinks reenviados (fCnt que no avanza) salvo rejoin/rollover.
  if (isReplayByFcnt(userId, canonicalDeviceId, Number(data.fCnt))) {
    metrics.inc('telemetry_replay_skipped');
    return { ok: true, saved: false, reason: 'replay_fcnt', deviceId: canonicalDeviceId };
  }

  const properties = { ...baseProps };
  properties.deviceId = canonicalDeviceId;
  properties.deviceName = normalizedDeviceName;
  if (isGatewayPseudoDeviceId(canonicalDeviceId)) {
    properties.deviceType = 'GATEWAY';
  }
  if (!properties.devEUI && properties.devEui) properties.devEUI = properties.devEui;
  if (!properties.devEui && properties.devEUI) properties.devEui = properties.devEUI;
  const csRaw = properties.connectStatus != null ? String(properties.connectStatus).trim() : '';
  const stRaw = properties.status != null ? String(properties.status).trim() : '';
  if (!csRaw && !stRaw) {
    properties.connectStatus = 'online';
  }

  tryApplyStoredDecoder(store, canonicalDeviceId, rawDeviceId, properties);

  const persistCheck = shouldSkipTelemetryInsert(store, userId, canonicalDeviceId, properties);
  if (persistCheck.skip) {
    metrics.inc('telemetry_duplicate_skipped');
    const tsDedup = Date.now();
    Object.assign(properties, persistCheck.prepared);
    properties.deviceId = canonicalDeviceId;
    properties.deviceName = normalizedDeviceName;
    if (persistCheck.refreshLastSeen) {
      store.touchLastTelemetryTimestamp(
        userId,
        canonicalDeviceId,
        normalizedDeviceName,
        properties,
        tsDedup
      );
      invalidateDevicesLatestCache();
    }
    const sseOnDedup = String(process.env.SYSCOM_TELEMETRY_SSE_ON_DEDUP || '1').trim() !== '0';
    if (sseOnDedup && (persistCheck.refreshLastSeen || !isJoinOnlyProperties(persistCheck.prepared))) {
      store.broadcastTelemetryRealtime(
        userId,
        canonicalDeviceId,
        normalizedDeviceName,
        properties,
        tsDedup
      );
    }
    return {
      ok: true,
      saved: false,
      reason: persistCheck.reason || 'no_change',
      deviceId: canonicalDeviceId,
    };
  }
  Object.assign(properties, persistCheck.prepared);
  properties.deviceId = canonicalDeviceId;
  properties.deviceName = normalizedDeviceName;

  pushDebugWebhook({
    timestamp: Date.now(),
    deviceId: canonicalDeviceId,
    rawDeviceId: rawDeviceId.toString(),
    rawBody: data,
    extractedProps: properties,
  });

  const ts = Date.now();
  store.appendTelemetry(userId, canonicalDeviceId, normalizedDeviceName, properties, ts);
  invalidateDevicesLatestCache();
  metrics.inc('telemetry_saved');
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

/** Evita tormenta de SSE/log por el mismo TOO_EARLY/TOO_LATE en ráfaga. */
const uiEventRateLimitAt = new Map();

function shouldRateLimitLnsUiEvent(eventType, devEui, meta) {
  if (eventType !== 'gateway_tx_rejected') return false;
  const gw = String(meta?.gatewayEui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  const err = String(meta?.txpkError || '').toUpperCase();
  const deui = String(meta?.devEui || devEui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  const key = `${gw}:${err}:${deui.slice(0, 16)}`;
  const gap = /TOO_EARLY|TOO_LATE/.test(err)
    ? Math.max(15_000, parseInt(String(process.env.SYSCOM_LNS_UI_TX_REJECT_LOG_MS || '30000').trim(), 10) || 30_000)
    : 12_000;
  const now = Date.now();
  const prev = uiEventRateLimitAt.get(key) || 0;
  if (now - prev < gap) return true;
  uiEventRateLimitAt.set(key, now);
  if (uiEventRateLimitAt.size > 500) {
    for (const [k, t] of uiEventRateLimitAt) {
      if (now - t > gap * 4) uiEventRateLimitAt.delete(k);
      if (uiEventRateLimitAt.size <= 250) break;
    }
  }
  return false;
}

/** LNS UI event en BD + broadcast SSE (mismo contrato que store.lnsInsertUiEvent). */
function insertUiEventWithStream(userId, devEui, eventType, metaJson) {
  let meta = null;
  if (metaJson) {
    try {
      meta = JSON.parse(metaJson);
    } catch {
      meta = null;
    }
  }
  if (shouldRateLimitLnsUiEvent(eventType, devEui, meta)) {
    return null;
  }
  const id = store.lnsInsertUiEvent(userId, devEui, eventType, metaJson);
  metrics.inc('lns_ui_events');
  realtimeHub.broadcast(String(userId), realtimeSseContract.sseLns, {
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

/** Resultado GW_TX_ACK (éxito / error / timeout sin ACK) → evento `downlink_gateway_ack` para SSE y polling UI. */
store.setLnsTxAckOutcomeHook((p) => {
  const deui = String(p.devEui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (deui.length !== 16 || !p.userId) return;
  const meta = JSON.stringify({
    ok: Boolean(p.ok),
    error: p.error != null ? String(p.error) : null,
    fCnt: p.fCnt != null && Number.isFinite(Number(p.fCnt)) ? Number(p.fCnt) : null,
    gatewayEui: p.gatewayEui != null ? String(p.gatewayEui) : null,
    timeout: Boolean(p.timeout),
  });
  insertUiEventWithStream(String(p.userId), deui, 'downlink_gateway_ack', meta);
});

/** GW_TX_ACK con error: visibilidad en UI/SSE. */
store.setLnsGatewayTxFailHook((detail) => {
  const errStr = detail.error != null ? String(detail.error) : '';
  const errU = errStr.toUpperCase();
  /** ACK huérfano TOO_LATE/TOO_EARLY: colisión en el concentrador; no alarmar en UI (el DL suele reintentarse en cola). */
  if (detail.orphan && (errU.includes('TOO_LATE') || errU.includes('TOO_EARLY'))) {
    if (String(process.env.SYSCOM_LNS_LOG_ORPHAN_TX_ACK || '1').trim() !== '0') {
      console.warn(
        '[LNS] GW_TX_ACK huérfano',
        errStr || 'TX rechazada',
        'en',
        detail.gatewayEui,
        '— colisión de TX en el concentrador (p. ej. clase C + join/LinkCheck). Reintento automático en cola si SYSCOM_LNS_ORPHAN_TX_ACK_RETRY=1.'
      );
    }
    return;
  }
  const timing =
    errU.includes('TOO_EARLY') || errU.includes('TOO_LATE')
      ? 'TOO_EARLY/TOO_LATE: el concentrador rechazó el instante de TX (cola/ocupación tras RX/TX). Suele verse con downlinks clase C `imme` seguidos → suba SYSCOM_LNS_CLASS_C_TX_GAP_MS (p. ej. 1500–2200) o SYSCOM_LNS_CLASS_C_USE_GATEWAY_TMST=1. Si el nodo es clase A, revise GET /api/devices/:id/lora-profile (clase efectiva por telemetría/decode-config) y SYSCOM_LNS_DOWNLINK_IGNORE_TELEMETRY_CLASS=1 si la telemetría marca mal la clase; evite saturar el mismo GW con TX inmediatas.'
      : 'Rechazo TX en gateway; si usa clase C inmediato: SYSCOM_LNS_CLASS_C_TX_GAP_MS y/o SYSCOM_LNS_CLASS_C_USE_GATEWAY_TMST=1.';
  const metaObj = {
    gatewayEui: detail.gatewayEui,
    txpkError: detail.error,
    devEui: detail.devEui || null,
    orphanAck: Boolean(detail.orphan),
    hint: `${timing} RF US915: SYSCOM_LNS_TX_RFCH_IMME_US915=0 u 1. Si el token GW no cuadra: SYSCOM_LNS_TX_ACK_MATCH_LATEST_INFLIGHT=1.`,
  };
  const metaJson = JSON.stringify(metaObj);
  const uids =
    detail.userId != null && String(detail.userId).trim() !== ''
      ? [String(detail.userId).trim()]
      : store.findUserIdsByLorawanGatewayEuiNorm16(detail.gatewayEui);
  const deui = String(detail.devEui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  const gw = String(detail.gatewayEui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  const devForEvent = deui.length === 16 ? deui : gw.length === 16 ? gw : 'gateway';
  for (const uid of uids) {
    if (!uid) continue;
    insertUiEventWithStream(uid, devForEvent, 'gateway_tx_rejected', metaJson);
  }
});

let lnsEngineSingleton = null;

function resetLnsEngineAfterDatabaseImport() {
  lnsEngineSingleton = null;
  try {
    delete globalThis.lnsEngine;
  } catch (e) {
    /* ignore */
  }
}

function getLnsEngine() {
  if (process.env.SYSCOM_LNS_MAC === '0') return null;
  if (!lnsEngineSingleton) {
    const { createLorawanLnsEngine } = require('./lorawan-lns-engine');
    lnsEngineSingleton = createLorawanLnsEngine({
      store,
      saveIngestEntry,
      runLegacyUplink: (uid, b) => runUplinkPipeline(uid, b),
      insertUiEvent: insertUiEventWithStream,
    });
    globalThis.lnsEngine = lnsEngineSingleton;
  }
  return lnsEngineSingleton;
}

/**
 * Carga útil de aplicación: `payloadBase64` o hex (`payloadHex`, etc., igual que en `POST /api/devices/.../downlink`).
 * @returns {{ ok: true, buf: Buffer, hex: string } | { ok: false, status: number, json: object }}
 */
function resolveLnsDownlinkAppPayloadBuffer(body) {
  const b = body && typeof body === 'object' ? body : {};
  const b64Raw = b.payloadBase64 ?? b.payload_base64;
  if (b64Raw != null && String(b64Raw).trim() !== '') {
    let buf;
    try {
      buf = Buffer.from(String(b64Raw).trim(), 'base64');
    } catch {
      return { ok: false, status: 400, json: { error: 'payloadBase64 inválido', code: 'PAYLOAD_B64' } };
    }
    if (!buf.length) {
      return { ok: false, status: 400, json: { error: 'payloadBase64 vacío', code: 'PAYLOAD_B64' } };
    }
    return { ok: true, buf, hex: buf.toString('hex').toLowerCase() };
  }
  const rawPayload = b.payloadHex ?? b.payload_hex ?? b.data ?? b.payload ?? b.commandKey ?? '';
  let hex = String(rawPayload).replace(/\s/g, '').replace(/^0x/i, '');
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    const resolved =
      resolveWt201DownlinkHex(rawPayload) ||
      resolveAutomationDownlinkHex({ commandKey: rawPayload, command_key: rawPayload });
    if (resolved) hex = resolved;
  }
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0 || !hex.length) {
    return { ok: false, status: 400, json: { error: 'payloadHex inválido (hex par de bytes)', code: 'PAYLOAD_HEX' } };
  }
  return { ok: true, buf: Buffer.from(hex, 'hex'), hex: hex.toLowerCase() };
}

/**
 * Respuesta HTTP unificada tras encolar downlink (campos explícitos para la UI).
 * `txAckMaxWaitMs` solo si el motor espera GW_TX_ACK (aprox. tiempo hasta auto-liberación).
 */
function buildLnsDownlinkApiSuccessBody(out) {
  const pending = Boolean(out && out.txAckPending);
  const maxWait = pending ? readLnsTxAckPruneSilenceMs() : null;
  return {
    status: 'Success',
    txAckPending: pending,
    txAckMaxWaitMs: maxWait,
    ...out,
  };
}

function isLnsDeferrableDownlinkError(code) {
  if (!code || typeof code !== 'string') return false;
  return (
    code === 'CLASS_A_RX_WINDOW_CLOSED' ||
    code === 'CLASS_A_MISSING_GATEWAY_TMST' ||
    code === 'NO_GATEWAY' ||
    code === 'CLASS_B_MISSING_GATEWAY_TMST' ||
    code === 'CLASS_B_PING_SLOT_UNKNOWN'
  );
}

/**
 * ¿Guardar el downlink en `lorawan_lns_deferred_app_dl` tras un error recuperable?
 * **Ventana clase A / tmst GW:** siempre encolar hasta el próximo uplink (medidores clase A), salvo `deferUntilUplink: false`.
 * Otros códigos deferibles: respetan `SYSCOM_LNS_DEFER_APP_DOWNLINK` y `deferUntilUplink: true`.
 */
function shouldInsertDeferredDownlink(body, lnsEnqueueExtras, deferralCode) {
  if (!deferralCode || typeof deferralCode !== 'string' || !isLnsDeferrableDownlinkError(deferralCode)) {
    return false;
  }
  if (body && body.deferUntilUplink === false) return false;
  if (lnsEnqueueExtras && lnsEnqueueExtras.deferUntilUplink === false) return false;
  if (
    deferralCode === 'CLASS_A_RX_WINDOW_CLOSED' ||
    deferralCode === 'CLASS_A_MISSING_GATEWAY_TMST'
  ) {
    return true;
  }
  if (body && body.deferUntilUplink === true) return true;
  if (lnsEnqueueExtras && lnsEnqueueExtras.deferUntilUplink === true) return true;
  if (String(process.env.SYSCOM_LNS_DEFER_APP_DOWNLINK || '').trim() === '0') return false;
  return true;
}

/**
 * Encola downlink LoRaWAN de aplicación (cola → PULL_RESP → packet forwarder).
 * @param {{ skipTxAckTrack?: boolean, priority?: number, delayMs?: number, deferUntilUplink?: boolean, allowGlobalSessionFallback?: boolean }} [lnsEnqueueExtras] Solo uso interno (p. ej. automatización). `allowGlobalSessionFallback`: superadmin, sesión en otra fila `lorawan_lns_sessions` por DevEUI.
 * @returns {{ ok: true, out: object, fPort: number, confirmedDl: boolean, deviceIdStr: string, deui: string, hex: string, deferred?: false } | { ok: true, deferred: true, pendingId: number, pendingQueueLength: number, deferredReason: string, fPort: number, confirmedDl: boolean, deviceIdStr: string, deui: string, hex: string } | { ok: false, status: number, json: object }}
 */
function tryLnsAppDownlinkEnqueue(userId, idStr, ud, body, lnsEnqueueExtras = {}) {
  const eng = getLnsEngine();
  if (!eng || process.env.SYSCOM_LNS_MAC === '0') {
    return {
      ok: false,
      status: 501,
      json: {
        status: 'Error',
        errMsg:
          'LNS MAC desactivado (SYSCOM_LNS_MAC=0) o motor no cargado. Para downlinks LoRaWAN use el LNS integrado (UDP Semtech + OTAA).',
        code: 'LNS_DISABLED',
      },
    };
  }
  const deui = String(ud.devEUI || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (deui.length !== 16) {
    return { ok: false, status: 400, json: { error: 'El dispositivo debe tener DevEUI (16 hex) para downlink LoRaWAN' } };
  }
  const sessionUserId = store.lnsResolveSessionUserIdForDevice(String(idStr), userId, deui, {
    allowGlobalSessionFallback: Boolean(lnsEnqueueExtras && lnsEnqueueExtras.allowGlobalSessionFallback),
  });
  const fPort = resolveLnsDownlinkFPort(body, idStr);
  if (fPort == null || !Number.isInteger(fPort) || fPort < 1 || fPort > 223) {
    return {
      ok: false,
      status: 400,
      json: {
        error:
          'Puerto LoRaWAN (FPort) no definido o inválido. Debe coincidir con el «puerto» de la plantilla guardado en el dispositivo (decoder); reaplique la plantilla o configure el canal como superadmin. También puede enviar fPort explícito en el cuerpo (1–223).',
        code: 'DOWNLINK_FPORT_MISSING',
      },
    };
  }
  const udRow = ud || store.getUserDevice(userId, idStr) || store.getAnyUserDeviceForDeviceId(idStr);
  try {
    syncDeviceTemplateFromCatalog(store, idStr, udRow, userId);
  } catch (e) {
    console.warn('[LNS] syncDeviceTemplateFromCatalog:', e.message);
  }
  const pay = resolveLnsDownlinkAppPayloadBuffer(body);
  if (!pay.ok) return pay;
  const cfgPm = String(store.getDeviceDecodeConfig(String(idStr))?.productModel || '').trim();
  const udPm = String(ud?.productModel || ud?.model || '').trim();
  const productModel = udPm || cfgPm;
  let hex = remapWs501LegacyDownlinkHex(pay.hex, productModel);
  const wtResolved = resolveWt201DownlinkHex(hex);
  if (wtResolved) hex = wtResolved;
  let payloadBuf = hex !== pay.hex ? Buffer.from(hex, 'hex') : pay.buf;
  const confirmedDl = Boolean(body?.confirmed);

  const sess = store.lnsGetSessionByDevEui(sessionUserId, deui);
  const dlClass = resolveDownlinkDeviceClass(body, idStr, ud, sess?.deviceClass, userId);
  if (sess) {
    store.lnsSyncSessionDeviceClass(sessionUserId, deui, dlClass);
  }
  const gwOptRaw = body?.gatewayEui ?? body?.gateway_eui;
  const gwOpt =
    gwOptRaw != null && String(gwOptRaw).trim() !== ''
      ? String(gwOptRaw)
          .replace(/[^0-9a-fA-F]/g, '')
          .toLowerCase()
      : '';
  if (gwOpt && gwOpt.length === 16 && !store.lorawanGatewayExists(sessionUserId, gwOpt)) {
    return {
      ok: false,
      status: 400,
      json: {
        error:
          'gatewayEui no coincide con un gateway LoRaWAN dado de alta en la cuenta del vínculo LNS (dueño de sesión). Dé de alta el gateway o omita el campo para usar el último visto por el nodo.',
        code: 'UNKNOWN_GATEWAY',
      },
    };
  }
  const priBody = body?.priority != null ? Number(body.priority) : undefined;
  const priExtra = lnsEnqueueExtras?.priority != null ? Number(lnsEnqueueExtras.priority) : undefined;
  const priority =
    priExtra != null && Number.isFinite(priExtra)
      ? Math.max(0, Math.min(255, Math.floor(priExtra)))
      : priBody != null && Number.isFinite(priBody)
        ? Math.max(0, Math.min(255, Math.floor(priBody)))
        : undefined;
  const delayBody = body?.delayMs != null ? Number(body.delayMs) : NaN;
  const delayExtra = lnsEnqueueExtras?.delayMs != null ? Number(lnsEnqueueExtras.delayMs) : NaN;
  let delayMs;
  if (Number.isFinite(delayBody) || Number.isFinite(delayExtra)) {
    delayMs = Math.max(0, (Number.isFinite(delayBody) ? delayBody : 0) + (Number.isFinite(delayExtra) ? delayExtra : 0));
  }

  try {
    const out = eng.enqueueAppDownlink(sessionUserId, deui, fPort, payloadBuf, {
      confirmed: confirmedDl,
      delayMs,
      priority,
      deviceClass: dlClass,
      gatewayEui: gwOpt && gwOpt.length === 16 ? gwOpt : undefined,
      skipTxAckTrack: Boolean(lnsEnqueueExtras && lnsEnqueueExtras.skipTxAckTrack),
    });
    return { ok: true, deferred: false, out, fPort, confirmedDl, deviceIdStr: idStr, deui, hex };
  } catch (e) {
    const code = typeof e.code === 'string' && e.code ? e.code : 'LNS_DOWNLINK';
    if (shouldInsertDeferredDownlink(body, lnsEnqueueExtras, code)) {
      const ins = store.lnsInsertDeferredAppDownlink(sessionUserId, deui, fPort, hex, {
        confirmed: confirmedDl,
        priority,
        delayMs,
        gatewayEui: gwOpt && gwOpt.length === 16 ? gwOpt : '',
        deviceClass: dlClass,
      });
      if (ins.ok) {
        return {
          ok: true,
          deferred: true,
          pendingId: ins.id,
          pendingQueueLength: ins.queueLength,
          deferredReason: code,
          fPort,
          confirmedDl,
          deviceIdStr: idStr,
          deui,
          hex,
        };
      }
      if (ins.reason === 'QUEUE_FULL') {
        return {
          ok: false,
          status: 429,
          json: {
            status: 'Error',
            errMsg:
              'Cola de downlinks diferidos llena para este dispositivo. Espere uplinks o aumente SYSCOM_LNS_DEFER_APP_DOWNLINK_MAX.',
            code: 'DEFER_QUEUE_FULL',
            queueLength: ins.queueLength,
          },
        };
      }
      return {
        ok: false,
        status: 400,
        json: {
          status: 'Error',
          errMsg: `No se pudo guardar el downlink en cola (${ins.reason || 'error'}). Revise payload y FPort.`,
          code: ins.reason || 'DEFER_INSERT_FAILED',
          originalCode: code,
        },
      };
    }
    const status =
      code === 'NO_SESSION' || code === 'CLASS_A_RX_WINDOW_CLOSED' || code === 'NO_GATEWAY'
        ? 400
        : code === 'DOWNLINK_IN_FLIGHT'
          ? 429
          : 503;
    return { ok: false, status, json: { status: 'Error', errMsg: e.message, code } };
  }
}

/**
 * Respuesta HTTP unificada tras `tryLnsAppDownlinkEnqueue` (inmediato o diferido 202).
 * @param {import('express').Response} res
 * @param {{ deviceIdStr: string, logSource?: string, viaLnsIntegrationToken?: boolean }} meta
 */
function sendHttpResponseAfterLnsAppDownlinkEnqueue(res, userId, r, meta) {
  const deviceIdStr = meta.deviceIdStr;
  const integ = Boolean(meta.viaLnsIntegrationToken);
  const attribution = downlinkLogAttributionFields(userId, meta);
  if (!r.ok) return res.status(r.status).json(r.json);
  if (r.deferred) {
    appendDownlinkLog(userId, {
      deviceId: deviceIdStr,
      devEUI: r.deui,
      fPort: r.fPort,
      payloadHex: r.hex,
      lns: true,
      deferred: true,
      pendingId: r.pendingId,
      pendingQueueLength: r.pendingQueueLength,
      deferredReason: r.deferredReason,
      ...(integ ? { viaLnsIntegrationToken: true } : {}),
      ...attribution,
    });
    insertUiEventWithStream(
      userId,
      r.deui,
      'downlink_deferred',
      JSON.stringify({
        deviceId: deviceIdStr,
        devEUI: r.deui,
        fPort: r.fPort,
        payloadHex: r.hex,
        pendingId: r.pendingId,
        pendingQueueLength: r.pendingQueueLength,
        deferredReason: r.deferredReason,
        ...(integ ? { via: 'lns_integration_token' } : {}),
        ...attribution,
      })
    );
    return res.status(202).json({
      status: 'Accepted',
      deferred: true,
      message:
        'El downlink quedó en cola y se transmitirá en la próxima ventana tras un uplink del dispositivo (LNS ↔ gateway con PULL_DATA y tmst).',
      pendingId: r.pendingId,
      pendingQueueLength: r.pendingQueueLength,
      deferredReason: r.deferredReason,
      devEUI: r.deui,
      fPort: r.fPort,
      payloadHex: r.hex,
      confirmed: r.confirmedDl,
      ...(integ ? { via: 'lns_integration_token' } : {}),
    });
  }
  appendDownlinkLog(userId, {
    deviceId: deviceIdStr,
    devEUI: r.deui,
    fPort: r.fPort,
    payloadHex: r.hex,
    lns: true,
    ...(integ ? { viaLnsIntegrationToken: true } : {}),
    ...attribution,
    ...r.out,
  });
  const apiBody = buildLnsDownlinkApiSuccessBody(r.out);
  const apiWithDeui = { ...apiBody, devEUI: r.deui };
  insertUiEventWithStream(
    userId,
    r.deui,
    'downlink_sent',
    JSON.stringify({
      deviceId: deviceIdStr,
      devEUI: r.deui,
      fPort: r.fPort,
      fCnt: r.out.fCnt,
      payloadHex: r.hex,
      confirmed: r.confirmedDl,
      deviceClass: r.out.deviceClass,
      imme: r.out.imme,
      txScheduledTmst: r.out.txScheduledTmst,
      classARxWindow: r.out.classARxWindow,
      gatewayEui: r.out.gatewayEui,
      txAckPending: apiBody.txAckPending,
      txAckMaxWaitMs: apiBody.txAckMaxWaitMs,
      ...(integ ? { via: 'lns_integration_token' } : {}),
      ...attribution,
    })
  );
  return res.json(apiWithDeui);
}

const smtpMail = require('./lib/smtp-mail.cjs');
const automationRunner = require('./automation-runner');
automationRunner.configure({
  store,
  tryLnsAppDownlinkEnqueue,
  appendDownlinkLog,
  insertUiEventWithStream,
  buildLnsDownlinkApiSuccessBody,
  canRunAutomationsForUser,
  canUseGlobalNotificationEmailForUser,
  automationPerm,
  smtpMail,
});
smtpMail.startSmtpQueueWorker(store);
store.setAutomationTelemetryHook((payload) => {
  try {
    automationRunner.onTelemetry(payload);
  } catch (e) {
    console.warn('[automation] telemetry hook:', e && e.message);
  }
});
automationRunner.startAutomationScheduleTicker();

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
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  const p = req.path || '';
  const firstPwOk =
    req.method === 'POST' && (p === '/api/auth/first-password' || p.endsWith('/auth/first-password'));
  const meOk = req.method === 'GET' && (p === '/api/auth/me' || p.endsWith('/auth/me'));
  if (firstPwOk || meOk) return next();

  const fullUser = store.getUserById(req.user.id);
  if (fullUser) {
    req.user.nav = navPerm.effectiveNavForUser(fullUser);
    req.user.role = fullUser.role;
  }
  if (fullUser?.mustChangePassword && !req.user.impersonatorId) {
    return res.status(403).json({
      code: 'MUST_CHANGE_PASSWORD',
      error: 'Debe definir una contraseña segura antes de continuar.',
    });
  }
  next();
};

/**
 * Renovar JWT: acepta token aún vigente o recién caducado (dentro de JWT_REFRESH_GRACE_MS).
 * No sustituye al login: firma inválida o sesión demasiado antigua → 401.
 */
const refreshAuthMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  const expMs = typeof decoded.exp === 'number' ? decoded.exp * 1000 : 0;
  if (expMs > 0 && Date.now() > expMs + JWT_REFRESH_GRACE_MS) {
    return res.status(401).json({ error: 'Sesión expirada. Vuelva a iniciar sesión.' });
  }
  const fullUser = store.getUserById(decoded.id);
  if (!fullUser) return res.status(401).json({ error: 'Usuario no encontrado' });
  const impFromTok =
    decoded.impersonatorId != null && String(decoded.impersonatorId).trim()
      ? String(decoded.impersonatorId).trim()
      : '';
  req.impersonatorIdFromToken = impFromTok;
  req.user = {
    id: fullUser.id,
    email: fullUser.email,
    role: fullUser.role,
    profileName: fullUser.profileName,
    mustChangePassword: Boolean(fullUser.mustChangePassword),
    nav: navPerm.effectiveNavForUser(fullUser),
    ...(impFromTok ? { impersonatorId: impFromTok } : {}),
  };
  next();
};

const adminMiddleware = (req, res, next) => {
  const full = store.getUserById(req.user.id);
  if (!full) return res.status(401).json({ error: 'Usuario no encontrado' });
  if (!navPerm.userHasNav(full, 'Users')) {
    return res.status(403).json({ error: 'Permisos insuficientes para esta acción' });
  }
  next();
};

const staffOnlyMiddleware = (req, res, next) => {
  const full = store.getUserById(req.user.id);
  if (!full) return res.status(401).json({ error: 'Usuario no encontrado' });
  if (!navPerm.userHasNav(full, 'Devices')) {
    return res.status(403).json({ error: 'Permisos insuficientes para esta acción' });
  }
  next();
};

const navSettingsMiddleware = (req, res, next) => {
  const full = store.getUserById(req.user.id);
  if (!full) return res.status(401).json({ error: 'Usuario no encontrado' });
  if (!navPerm.userHasNav(full, 'Settings')) {
    return res.status(403).json({ error: 'Permisos insuficientes para esta acción' });
  }
  next();
};

const navGatewayMiddleware = (req, res, next) => {
  const full = store.getUserById(req.user.id);
  if (!full) return res.status(401).json({ error: 'Usuario no encontrado' });
  if (!navPerm.userHasNav(full, 'Gateway')) {
    return res.status(403).json({ error: 'Permisos insuficientes para esta acción' });
  }
  next();
};

const navAutomationsMiddleware = (req, res, next) => {
  const full = store.getUserById(req.user.id);
  if (!full) return res.status(401).json({ error: 'Usuario no encontrado' });
  if (!navPerm.userHasNav(full, 'Automations')) {
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

/** Superadmin real (no sesión de soporte viendo otra cuenta). */
const realSuperAdminMiddleware = (req, res, next) => {
  if (req.user.impersonatorId) {
    return res.status(403).json({
      error: 'No disponible durante una sesión de soporte. Use «Volver a mi cuenta» en la barra superior.',
    });
  }
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Solo el super administrador puede realizar esta acción' });
  }
  next();
};

/** JWT `typ: lns_integration` + fila activa en `lns_integration_token` (revocable). */
const lnsIntegrationAuthMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Token requerido', code: 'NO_TOKEN' });
  let decoded;
  try {
    decoded = jwt.verify(token, LNS_INTEGRATION_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido o caducado', code: 'INVALID_TOKEN' });
  }
  if (decoded.typ !== 'lns_integration' || decoded.sub == null || decoded.jti == null) {
    return res.status(401).json({ error: 'Token no es de integración LNS', code: 'WRONG_TOKEN_TYPE' });
  }
  const uid = String(decoded.sub).trim();
  const jti = String(decoded.jti).trim();
  if (!store.lnsIntegrationTokenIsActive(uid, jti)) {
    return res.status(401).json({ error: 'Token revocado o desconocido', code: 'TOKEN_REVOKED' });
  }
  req.user = { id: uid, role: decoded.role || 'viewer', _lnsIntegration: true };
  next();
};

function safeEqualText(a, b) {
  const aBuf = Buffer.from(String(a), 'utf8');
  const bBuf = Buffer.from(String(b), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function matchesLegacyAdminSecret(req) {
  if (!LEGACY_ADMIN_SECRET) return false;
  const bodySecret = req.body?.adminSecret;
  const querySecret = req.query?.adminSecret;
  const candidate = bodySecret != null ? bodySecret : querySecret;
  if (candidate == null) return false;
  return safeEqualText(String(candidate), LEGACY_ADMIN_SECRET);
}

/**
 * Instalación inicial: no hay ningún usuario en la base (tabla `users` vacía).
 * Si ya existe al menos un usuario (p. ej. importado desde `db.json` o creado antes), se muestra el login habitual.
 */
function setupNeedsBootstrap() {
  try {
    return store.countUsers() === 0;
  } catch {
    return true;
  }
}

function superAdminOrLegacySecret(req, res, next) {
  if (matchesLegacyAdminSecret(req)) return next();
  return authMiddleware(req, res, () => superAdminOnlyMiddleware(req, res, next));
}

/** Estado del motor en servidor (LNS, automatizaciones): no requiere JWT. */
app.get('/api/health/platform', (_req, res) => {
  const lnsMac = process.env.SYSCOM_LNS_MAC !== '0';
  let lnsEngine = false;
  try {
    lnsEngine = lnsMac && Boolean(getLnsEngine());
  } catch {
    lnsEngine = false;
  }
  res.json({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    sessionRequired: false,
    services: {
      lnsMac,
      lnsEngine,
      lnsUdpPort: LNS_UDP_PORT || 0,
      lnsUdpActive: Boolean(LNS_UDP_PORT),
      automationServer: String(process.env.SYSCOM_SERVER_AUTOMATIONS || '1').trim() !== '0',
      automationSchedule: String(process.env.SYSCOM_SERVER_AUTOMATION_SCHEDULE || '1').trim() !== '0',
      mqttIngest: Boolean(
        String(process.env.MQTT_BROKER_URL || '').trim() &&
          String(process.env.SYSCOM_MQTT_INGEST_URL || '').trim()
      ),
    },
    hint: 'LNS, SQLite y automatizaciones por horario siguen activos sin usuarios conectados a la web.',
  });
});

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
    message: 'Configure el gateway con POST /api/ingest/<userId>/<ingestToken> (ver Ajustes en la app).',
  });
});

// ── Auth routes ────────────────────────────────────────────
mountOAuthProvidersConfig(app);
mountGoogleAuthRoutes(app, {
  store,
  jwt,
  jwtSecret: JWT_SECRET,
  jwtExpiresIn: JWT_EXPIRES_IN,
  sessionJwtPayload,
  isProduction: IS_PRODUCTION,
  loginRateLimit,
  metrics,
});
mountMicrosoftAuthRoutes(app, {
  store,
  jwt,
  jwtSecret: JWT_SECRET,
  jwtExpiresIn: JWT_EXPIRES_IN,
  sessionJwtPayload,
  isProduction: IS_PRODUCTION,
  loginRateLimit,
  metrics,
});
mountYahooAuthRoutes(app, {
  store,
  jwt,
  jwtSecret: JWT_SECRET,
  jwtExpiresIn: JWT_EXPIRES_IN,
  sessionJwtPayload,
  isProduction: IS_PRODUCTION,
  loginRateLimit,
  metrics,
});

app.post('/api/auth/check-email', loginRateLimit, (req, res) => {
  const raw = req.body?.email;
  const email = String(raw || '')
    .trim()
    .toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Ingrese un correo electrónico válido.' });
  }
  const user = store.getUserByEmail(email);
  if (!user) {
    return res.json({ exists: false });
  }
  const staff =
    user.role === 'superadmin' ||
    ['Users', 'Gateway', 'Automations', 'Settings', 'Templates'].some((k) => navPerm.userHasNav(user, k));
  return res.json({
    exists: true,
    accountKind: staff ? 'staff' : 'user',
    profileName: String(user.profileName || '').trim(),
  });
});

app.post('/api/auth/login', loginRateLimit, (req, res) => {
  metrics.inc('login_attempt');
  const { email: rawEmail, password } = req.body || {};
  const email = String(rawEmail || '')
    .trim()
    .toLowerCase();
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
  const token = jwt.sign(sessionJwtPayload(user), JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.json({ token, user: sanitizeUserRecord(user) });
});

app.post('/api/auth/first-password', authMiddleware, (req, res) => {
  if (req.user.impersonatorId) {
    return res.status(403).json({ error: 'No disponible en sesión de soporte.' });
  }
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
  const token = jwt.sign(sessionJwtPayload(row), JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.json({ token, user: sanitizeUserRecord(row) });
});

app.post('/api/auth/refresh', refreshAuthMiddleware, (req, res) => {
  const row = store.getUserById(req.user.id);
  if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (row.mustChangePassword && !req.impersonatorIdFromToken) {
    return res.status(403).json({
      code: 'MUST_CHANGE_PASSWORD',
      error: 'Debe definir una contraseña segura antes de continuar.',
    });
  }
  const imp = req.impersonatorIdFromToken || '';
  const token = jwt.sign(
    sessionJwtPayload(row, imp ? { impersonatorId: imp } : {}),
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  res.json({ token, user: sanitizeUserRecord(row) });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = store.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const body = sanitizeUserRecord(user);
  const impId = req.user.impersonatorId != null ? String(req.user.impersonatorId).trim() : '';
  if (impId) {
    const actor = store.getUserById(impId);
    body.impersonation = actor
      ? {
          actorId: actor.id,
          actorEmail: actor.email,
          actorProfileName: String(actor.profileName || '').trim(),
        }
      : { actorId: impId, actorEmail: '', actorProfileName: '' };
  } else {
    body.impersonation = null;
  }
  res.json(body);
});

/** Debe declararse ANTES de `/impersonate/:targetUserId` para que «stop» no se interprete como id de usuario. */
app.post('/api/auth/impersonate/stop', authMiddleware, (req, res) => {
  const impId = req.user.impersonatorId != null ? String(req.user.impersonatorId).trim() : '';
  if (!impId) {
    return res.status(400).json({ error: 'No hay una sesión de soporte activa' });
  }
  const actor = store.getUserById(impId);
  if (!actor || actor.role !== 'superadmin') {
    return res.status(403).json({
      error: 'La sesión de soporte ya no es válida. Cierre sesión e inicie de nuevo.',
    });
  }
  const token = jwt.sign(sessionJwtPayload(actor), JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.json({ token, user: sanitizeUserRecord(actor), impersonation: null });
});

app.post('/api/auth/impersonate/:targetUserId', authMiddleware, realSuperAdminMiddleware, (req, res) => {
  const raw = req.params.targetUserId != null ? String(req.params.targetUserId).trim() : '';
  if (!raw) return res.status(400).json({ error: 'Usuario destino requerido' });
  if (raw === req.user.id) {
    return res.status(400).json({ error: 'No puede iniciar soporte sobre su propia cuenta' });
  }
  const target = store.getUserById(raw);
  if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (target.role === 'superadmin') {
    return res.status(403).json({
      error: 'Por seguridad no se permite el modo soporte sobre otra cuenta de super administrador.',
    });
  }
  const token = jwt.sign(sessionJwtPayload(target, { impersonatorId: req.user.id }), JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
  res.json({
    token,
    user: sanitizeUserRecord(target),
    impersonation: {
      actorId: req.user.id,
      actorEmail: req.user.email,
      actorProfileName: String(req.user.profileName || '').trim(),
    },
  });
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
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  const fullUser = store.getUserById(req.user.id);
  if (fullUser) {
    req.user.nav = navPerm.effectiveNavForUser(fullUser);
    req.user.role = fullUser.role;
  }
  if (fullUser?.mustChangePassword && !req.user.impersonatorId) {
    return res.status(403).json({
      code: 'MUST_CHANGE_PASSWORD',
      error: 'Debe definir una contraseña segura antes de continuar.',
    });
  }
  next();
};

/**
 * Server-Sent Events: tipos definidos en `shared/realtime-sse-contract.json` (p. ej. sseTelemetry, sseLns).
 * Ejemplo: GET `/api/events/stream?token=<JWT>` (mismo host que la API).
 */
app.get('/api/events/stream', authFromBearerOrQuery, (req, res) => {
  try {
    req.socket.setTimeout(0);
  } catch {
    /* ignore */
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  realtimeHub.subscribe(req.user.id, res);
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
});

/** Métricas y uptime en memoria (sin servicios externos). Solo administradores. */
app.get('/api/admin/syscom-metrics', authMiddleware, navSettingsMiddleware, (req, res) => {
  const snap = metrics.snapshot();
  res.json({
    status: 'Success',
    ...snap,
    realtime: { sseSubscribers: realtimeHub.subscriberCount() },
  });
});

/**
 * Proxy REST del UG65/67 (puerto 8080): diagnóstico y datos. La **cola downlink** del firmware
 * no sustituye al LNS integrado (Semtech UDP); por defecto está **cerrada** — ver `rejectMilesightUgQueueProxy`.
 */
function milesightUgQueueProxyAllowed() {
  return String(process.env.SYSCOM_MILESIGHT_UG_QUEUE_PROXY || '').trim() === '1';
}

/** @returns {boolean} true si ya respondió 410 (no continuar al gateway). */
function rejectMilesightUgQueueProxy(res) {
  if (milesightUgQueueProxyAllowed()) return false;
  res.status(410).json({
    status: 'Error',
    code: 'USE_INTERNAL_LNS_DOWNLINK_ONLY',
    errMsg:
      'Los downlinks LoRaWAN se gestionan solo con el LNS integrado de esta aplicación (UDP Semtech / GWMP). No use la cola REST del gateway Milesight para tráfico MAC ni payload de aplicación. Use POST /api/devices/:deviceId/downlink (JWT de sesión y dispositivo asignado) o POST /api/lns/v1/devices/:devEUI/queue (token de integración). El gateway debe ser solo packet forwarder hacia LNS_UDP_PORT. Para un proxy experimental de la cola del UG65 defina SYSCOM_MILESIGHT_UG_QUEUE_PROXY=1.',
  });
  return true;
}

// ── Milesight UG65/UG67 API (proxy autenticado hacia https://gateway:8080) ──
app.post('/api/milesight-ug-gateway/probe', authMiddleware, navSettingsMiddleware, async (req, res) => {
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

app.post('/api/milesight-ug-gateway/probe-saved', authMiddleware, navSettingsMiddleware, requireMilesightUgGateway, async (req, res) => {
  try {
    await loginToGateway(req.milesightUgConfig);
    res.json({ ok: true, message: 'Login en el gateway correcto (credenciales guardadas)' });
  } catch (e) {
    const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    res.status(code).json({ error: e.message, details: e.body });
  }
});

app.get('/api/milesight-ug-gateway/applications', authMiddleware, navSettingsMiddleware, requireMilesightUgGateway, async (req, res) => {
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

app.get('/api/milesight-ug-gateway/applications/:name', authMiddleware, navSettingsMiddleware, requireMilesightUgGateway, async (req, res) => {
  try {
    const name = encodeURIComponent(req.params.name);
    const r = await ugJsonRequest(req.user.id, req.milesightUgConfig, 'GET', `/api/applications/${name}`, null);
    sendUgGatewayResponse(res, r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/milesight-ug-gateway/devices', authMiddleware, navSettingsMiddleware, requireMilesightUgGateway, async (req, res) => {
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

app.get('/api/milesight-ug-gateway/devices/by-name/:name', authMiddleware, navSettingsMiddleware, requireMilesightUgGateway, async (req, res) => {
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
  navSettingsMiddleware,
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
  navSettingsMiddleware,
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
  navSettingsMiddleware,
  (req, res, next) => {
    if (rejectMilesightUgQueueProxy(res)) return;
    next();
  },
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
  navSettingsMiddleware,
  (req, res, next) => {
    if (rejectMilesightUgQueueProxy(res)) return;
    next();
  },
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
  navSettingsMiddleware,
  (req, res, next) => {
    if (rejectMilesightUgQueueProxy(res)) return;
    next();
  },
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

app.get('/api/milesight-ug-gateway/urpackets', authMiddleware, navSettingsMiddleware, requireMilesightUgGateway, (req, res) => {
  streamUrpackets(req.user.id, req.milesightUgConfig, res).catch((e) => {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  });
});

app.put(
  '/api/milesight-ug-gateway/users/:username/password',
  authMiddleware,
  navSettingsMiddleware,
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

app.post('/api/milesight-mqtt/downlink', authMiddleware, navSettingsMiddleware, async (req, res) => {
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

app.post('/api/milesight-mqtt/ns-request', authMiddleware, navSettingsMiddleware, async (req, res) => {
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
    const selfRow = store.getUserById(req.user.id);
    const subtree = store.listUsersInSubtree(req.user.id);
    raw = selfRow ? [selfRow, ...subtree] : subtree;
  }
  res.json(raw.map((u) => sanitizeUserRecord(u)));
});

/** Dispositivos asignados en `user_devices` (vista admin / super admin). */
app.get('/api/users/:id/devices', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const rawId = req.params.id != null ? String(req.params.id).trim() : '';
    if (!rawId) return res.status(400).json({ error: 'Id de usuario requerido' });
    const row = store.getUserById(rawId);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });

    const staffId = String(req.user.id ?? '').trim();
    const isSuper = req.user.role === 'superadmin';
    if (!isSuper) {
      const self = staffId === String(row.id);
      const inSubtree = self || store.isUserDescendantOf(staffId, String(row.id));
      if (!inSubtree) {
        return res.status(403).json({ error: 'Sin permiso para ver los dispositivos de este usuario' });
      }
    }

    const targetUserId = String(row.id).trim();
    const devices = store.listUserDevices(targetUserId).map((d) => ({
      deviceId: d.deviceId != null ? String(d.deviceId) : '',
      displayName: d.displayName != null ? String(d.displayName) : '',
      devEUI: d.devEUI != null ? String(d.devEUI) : '',
      tag: d.tag != null ? String(d.tag) : '',
      productModel: d.productModel != null ? String(d.productModel) : '',
      lorawanClass: d.lorawanClass != null ? String(d.lorawanClass) : '',
      notes: d.notes != null ? String(d.notes) : '',
    }));
    res.json({
      userId: targetUserId,
      email: row.email,
      profileName: row.profileName || '',
      devices,
    });
  } catch (e) {
    console.error('[GET /api/users/:id/devices]', e);
    return res.status(500).json({ error: e.message || 'Error al listar dispositivos' });
  }
});

app.post('/api/users', authMiddleware, adminMiddleware, (req, res) => {
  const actor = store.getUserById(req.user.id);
  if (!actor) return res.status(401).json({ error: 'Usuario no encontrado' });

  const { password, profileName, navPermissions: navBody, role: roleBody } = req.body || {};
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Correo electrónico no válido' });
  }
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
  if (roleBody === 'superadmin') {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Solo el super administrador puede crear cuentas super administrador' });
    }
    newRole = 'superadmin';
  }

  let navJson;
  if (newRole === 'superadmin') {
    navJson = navPerm.navToJson(navPerm.allNavTrue());
  } else {
    navJson = navPerm.navToJson(navPerm.sanitizeNavAssignment(actor, navBody));
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
    navPermissionsJson: navJson,
  };
  try {
    store.insertUser(newUser);
  } catch (e) {
    const msg = String(e && e.message);
    if (msg.includes('UNIQUE') && msg.toLowerCase().includes('email')) {
      return res.status(409).json({ error: 'Ese correo ya está registrado.', code: 'USER_EXISTS' });
    }
    throw e;
  }
  res.status(201).json(sanitizeUserRecord(newUser));
});

app.put('/api/users/:id', authMiddleware, (req, res) => {
  const row = store.getUserById(req.params.id);
  if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
  const isSelf = row.id === req.user.id;
  const isSuper = req.user.role === 'superadmin';
  const canManageDesc = store.isUserDescendantOf(req.user.id, row.id);
  if (!isSelf && !isSuper && !canManageDesc) return res.status(403).json({ error: 'Sin permiso' });
  const { password, regenerateIngestToken, ...updates } = req.body;
  if (updates.role !== undefined) {
    const nr = updates.role;
    if (!['superadmin', 'user'].includes(nr)) {
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
  if (updates.navPermissions !== undefined && (isSuper || canManageDesc || isSelf)) {
    if (row.role === 'superadmin') {
      row.navPermissionsJson = navPerm.navToJson(navPerm.allNavTrue());
    } else {
      const editor = store.getUserById(req.user.id);
      const sanitized = navPerm.sanitizeNavAssignment(editor, updates.navPermissions);
      row.navPermissionsJson = navPerm.navToJson(sanitized);
    }
  }
  if (updates.profileName !== undefined) row.profileName = updates.profileName;
  if (updates.email !== undefined && updates.email !== null) {
    const email = String(updates.email || '')
      .trim()
      .toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Correo electrónico no válido' });
    }
    const other = store.getUserByEmail(email);
    if (other && String(other.id) !== String(row.id)) {
      return res.status(409).json({
        error: 'Ese correo ya está registrado en otra cuenta.',
        code: 'USER_EXISTS',
      });
    }
    row.email = email;
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
  if (regenerateIngestToken === true && (isSelf || canManageDesc || isSuper)) {
    row.ingestToken = crypto.randomBytes(24).toString('hex');
  }
  if (updates.milesightUgGateway !== undefined && (isSelf || canManageDesc || isSuper)) {
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
  try {
    store.updateUserRecord(row);
  } catch (e) {
    const msg = String(e && e.message);
    if (msg.includes('UNIQUE') && msg.toLowerCase().includes('email')) {
      return res.status(409).json({
        error: 'Ese correo ya está registrado en otra cuenta.',
        code: 'USER_EXISTS',
      });
    }
    throw e;
  }
  res.json(sanitizeUserRecord(row));
});

app.delete('/api/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const row = store.getUserById(req.params.id);
  if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (row.id === req.user.id) return res.status(400).json({ error: 'No puede eliminarse a sí mismo' });
  if (req.user.role === 'superadmin') {
    if (row.role === 'superadmin') {
      const supers = store.allUsersSanitized().filter((u) => u.role === 'superadmin');
      if (supers.length <= 1) {
        return res.status(400).json({ error: 'No puede eliminar el único super administrador' });
      }
    }
  } else if (!store.isUserDescendantOf(req.user.id, row.id)) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  store.deleteUserById(req.params.id);
  res.json({ ok: true });
});

// ── Dispositivos (solo datos locales / ingesta) ────────────


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

function gatewayTelemetryAggregateForActor(userId, role, gwEui16) {
  if (role !== 'superadmin') return gatewayTelemetryAggregate(userId, gwEui16);
  let best = { lastTs: 0, latest: null };
  for (const sid of store.listSuperadminUserIds()) {
    const agg = gatewayTelemetryAggregate(sid, gwEui16);
    if (agg.lastTs > best.lastTs) best = agg;
  }
  return best;
}

function computeGatewayOnline(latest, lastTs, now) {
  if (!lastTs) return { online: false, lastSeenAt: null };
  const fresh = now - lastTs < COMMS_STALE_OFFLINE_MS;
  if (!fresh) return { online: false, lastSeenAt: lastTs };
  const p = (latest && latest.properties) || {};
  const dt = String(p.deviceType || '').toUpperCase();
  const st = p.connectStatus != null ? p.connectStatus : p.status;
  if (dt === 'GATEWAY' && st != null && String(st).length) {
    const sl = String(st).toLowerCase();
    if (['offline', 'disconnected', 'false', '0', 'off'].includes(sl)) {
      return { online: false, lastSeenAt: lastTs };
    }
    if (['online', 'joined', 'connected', 'true', '1', 'on'].includes(sl)) {
      return { online: true, lastSeenAt: lastTs };
    }
  }
  return { online: true, lastSeenAt: lastTs };
}

// ── Gateways LoRaWAN registrados (catálogo local por usuario) ───────────
app.get('/api/lorawan-gateways', authMiddleware, (req, res) => {
  const list =
    req.user.role === 'superadmin'
      ? store.listLorawanGatewaysUnifiedForSuperadmin()
      : store.listLorawanGateways(req.user.id);
  const now = Date.now();
  const enriched = list.map((g) => {
    const { lastTs, latest } = gatewayTelemetryAggregateForActor(req.user.id, req.user.role, g.gatewayEui);
    const { online, lastSeenAt } = computeGatewayOnline(latest, lastTs, now);
    return {
      ...g,
      online,
      lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
    };
  });
  res.json(enriched);
});

app.post('/api/lorawan-gateways', authMiddleware, navGatewayMiddleware, (req, res) => {
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
      error: 'Seleccione una banda de frecuencia válida de la lista.',
      code: 'GATEWAY_VALIDATION',
    });
  }
  const el = eui.toLowerCase();
  if (store.lorawanGatewayEuiExistsGlobally(el)) {
    return res.status(409).json({
      error: 'Ya existe un gateway registrado con este EUI (en el sistema).',
      code: 'GATEWAY_EXISTS',
    });
  }
  const row = {
    id: Date.now().toString(),
    userId: req.user.id,
    name: nameTrim.slice(0, 128),
    gatewayEui: el,
    frequencyBand: String(frequencyBand).slice(0, 64),
    createdAt: new Date().toISOString(),
  };
  store.insertLorawanGateway(row);
  store.mirrorLorawanGatewayToSuperadminPool(row);
  let lnsAbpBootstrapRetry = { attempted: 0, provisioned: 0, results: [] };
  try {
    lnsAbpBootstrapRetry = retryMilesightAbpBootstrapAll(store, req.user.id);
    if (lnsAbpBootstrapRetry.provisioned > 0) {
      console.log(
        '[LNS] Tras alta de gateway: sesiones Milesight ABP automáticas provisionadas:',
        lnsAbpBootstrapRetry.provisioned,
        '/',
        lnsAbpBootstrapRetry.attempted
      );
    }
  } catch (e) {
    console.warn('[LNS] Auto Milesight ABP (tras gateway):', e.message || e);
  }
  res.status(201).json({ ...row, lnsAbpBootstrapRetry });
});

app.delete('/api/lorawan-gateways/:id', authMiddleware, navGatewayMiddleware, (req, res) => {
  const ok = store.deleteLorawanGateway(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ok: true });
});

app.get('/api/devices', authMiddleware, (req, res) => {
  const role = req.user.role;
  const content = getDevicesContentCached(role, req.user.id);
  res.json({ status: 'Success', data: { content } });
});

/** Diagnóstico de tamaño de SQLite y telemetría (solo superadmin). */
app.get('/api/admin/storage-stats', authMiddleware, realSuperAdminMiddleware, (req, res) => {
  try {
    const stats = store.getTelemetryStorageStats();
    const estMirrorFactor =
      stats.distinctUsers > 0 && stats.topUsersByRows.length >= 2
        ? Math.round(stats.totalRows / Math.max(1, stats.topUsersByRows[0]?.rows || stats.totalRows))
        : 1;
    res.json({
      status: 'Success',
      data: {
        ...stats,
        fileSizeMB: Math.round((stats.fileBytes / (1024 * 1024)) * 100) / 100,
        walSizeMB: Math.round((stats.walBytes / (1024 * 1024)) * 100) / 100,
        hint:
          stats.totalRows > 500000
            ? 'BD muy grande: reduzca SYSCOM_TELEMETRY_RETENTION_MS y ejecute npm run db:prune'
            : stats.joinEventRows > stats.totalRows * 0.2
              ? 'Muchos eventos join en telemetría; el pool superadmin duplica filas por cuenta'
              : null,
        noteMirrorPool:
          estMirrorFactor > 1
            ? `Hasta ~${estMirrorFactor}× filas por uplink si el dispositivo está en el pool superadmin (varias cuentas).`
            : null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error leyendo estadísticas' });
  }
});

app.post('/api/admin/storage-prune', authMiddleware, realSuperAdminMiddleware, (req, res) => {
  try {
    const vacuum = req.body?.vacuum === true || req.query?.vacuum === '1';
    const pruneGateways = req.body?.pruneGateways === true || req.query?.pruneGateways === '1';
    const data = { retention: store.runRetentionPruneNow({ vacuum: false }) };
    if (pruneGateways) {
      data.gateways = store.pruneGatewayTelemetryHistory();
    }
    if (vacuum && (data.retention.deleted > 0 || (data.gateways && data.gateways.deleted > 0))) {
      try {
        store.db.exec('VACUUM');
        data.vacuumed = true;
      } catch (e) {
        data.vacuumError = e.message || String(e);
      }
    }
    invalidateDevicesListCache();
    res.json({ status: 'Success', data });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error en poda' });
  }
});

app.get('/api/device-templates', authMiddleware, (req, res) => {
  try {
    const cat = store.getDeviceTemplatesCatalog();
    res.json({
      templates: cat.templates,
      defaultTemplateId: cat.defaultTemplateId,
      updatedAt: cat.updatedAt,
    });
  } catch (e) {
    console.error('[GET /api/device-templates]', e);
    res.status(500).json({ error: e.message || 'Error al leer plantillas' });
  }
});

app.put('/api/device-templates', authMiddleware, realSuperAdminMiddleware, (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.templates)) {
      return res.status(400).json({ error: 'templates debe ser un array' });
    }
    if (body.templates.length > 400) {
      return res.status(400).json({ error: 'Demasiadas plantillas en el catálogo' });
    }
    const modeloSeen = new Map();
    for (let i = 0; i < body.templates.length; i += 1) {
      const t = body.templates[i];
      const m = t?.modelo != null ? String(t.modelo).trim().toLowerCase() : '';
      if (m) {
        if (modeloSeen.has(m)) {
          return res.status(409).json({
            error:
              'El catálogo contiene más de una plantilla con el mismo modelo. Cada modelo debe ser único (comparación sin distinguir mayúsculas).',
            code: 'TEMPLATE_MODEL_EXISTS',
          });
        }
        modeloSeen.set(m, i);
      }
    }
    for (let i = 0; i < body.templates.length; i += 1) {
      const t = body.templates[i];
      const dec = t?.decoderScript != null ? String(t.decoderScript) : '';
      if (dec.length > 450000) {
        return res.status(400).json({ error: `Plantilla ${i + 1}: decoder demasiado grande` });
      }
    }
    const defaultTemplateId =
      body.defaultTemplateId != null && String(body.defaultTemplateId).trim()
        ? String(body.defaultTemplateId).trim()
        : null;
    const templatesNorm = sanitizeTemplatesCatalog(body.templates);
    store.setDeviceTemplatesCatalog({ templates: templatesNorm, defaultTemplateId });
    const cat = store.getDeviceTemplatesCatalog();
    res.json({
      templates: cat.templates,
      defaultTemplateId: cat.defaultTemplateId,
      updatedAt: cat.updatedAt,
    });
  } catch (e) {
    console.error('[PUT /api/device-templates]', e);
    res.status(500).json({ error: e.message || 'Error al guardar plantillas' });
  }
});

app.get(
  '/api/device-templates/assigned-device-ids',
  authMiddleware,
  (req, res) => {
    const tid = String(req.query.templateId || '').trim();
    if (!tid) return res.status(400).json({ error: 'templateId requerido (query)' });
    try {
      const full = store.getUserById(req.user.id);
      const fleetWide = full && navPerm.userHasNav(full, 'Devices');
      const deviceIds = fleetWide
        ? store.listDeviceIdsWithCatalogTemplate(tid)
        : store.listAssignedDeviceIdsWithCatalogTemplate(tid, req.user.id);
      res.json({ templateId: tid, deviceIds });
    } catch (e) {
      console.error('[GET /api/device-templates/assigned-device-ids]', e);
      res.status(500).json({ error: e.message || 'Error al listar dispositivos' });
    }
  }
);

app.get(
  '/api/devices/:deviceId/downlink-presets',
  authMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
    const did = decodeURIComponent(String(req.params.deviceId || '').trim());
    const ud = store.getUserDevice(req.user.id, did) || store.getAnyUserDeviceForDeviceId(did);
    try {
      syncDeviceTemplateFromCatalog(store, did, ud, req.user.id);
    } catch (e) {
      console.warn('[Syscom] syncDeviceTemplateFromCatalog (presets GET):', e.message);
    }
    const raw = store.getDeviceSharedPresetsParsed(did);
    const presets =
      raw && typeof raw === 'object'
        ? normalizeDeviceSharedPresetsBody(raw, did)
        : normalizeDeviceSharedPresetsBody({}, did);
    res.json({ deviceId: did, presets });
  }
);

app.put(
  '/api/devices/:deviceId/downlink-presets',
  authMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
    const did = decodeURIComponent(String(req.params.deviceId || '').trim());
    const ud = store.getUserDevice(req.user.id, did) || store.getAnyUserDeviceForDeviceId(did);
    store.setDeviceSharedPresetsParsed(did, normalizeDeviceSharedPresetsBody(req.body || {}, did));
    try {
      syncDeviceTemplateFromCatalog(store, did, ud, req.user.id);
    } catch (e) {
      console.warn('[Syscom] syncDeviceTemplateFromCatalog (presets PUT):', e.message);
    }
    const presets = normalizeDeviceSharedPresetsBody(store.getDeviceSharedPresetsParsed(did) || {}, did);
    res.json({ deviceId: did, presets });
  }
);

app.post('/api/devices/assign', authMiddleware, (req, res) => {
  const actor = store.getUserById(req.user.id);
  if (!actor) return res.status(401).json({ error: 'Usuario no encontrado' });
  const canAssign =
    actor.role === 'superadmin' ||
    (navPerm.userHasNav(actor, 'Devices') && navPerm.userHasNav(actor, 'Users'));
  if (!canAssign) {
    return res.status(403).json({ error: 'No tiene permiso para asignar dispositivos' });
  }

  const { deviceId, assigneeEmail } = req.body || {};
  const did = deviceId != null ? String(deviceId).trim() : '';
  const emailRaw = assigneeEmail != null ? String(assigneeEmail).trim().toLowerCase() : '';
  if (!did || !emailRaw) return res.status(400).json({ error: 'deviceId y assigneeEmail requeridos' });

  const assignee = store.getUserByEmail(emailRaw);
  if (!assignee) return res.status(404).json({ error: 'No existe un usuario con ese correo' });
  if (assignee.id === actor.id) return res.status(400).json({ error: 'No puede asignarse a sí mismo' });

  if (actor.role !== 'superadmin') {
    if (!store.isUserDescendantOf(actor.id, assignee.id)) {
      return res.status(403).json({ error: 'Solo puede asignar a usuarios de su jerarquía' });
    }
    if (!store.getUserDevice(actor.id, did)) {
      return res.status(403).json({ error: 'No tiene este dispositivo en su cuenta' });
    }
  }

  if (actor.role === 'superadmin') {
    if (!['user', 'superadmin'].includes(assignee.role)) {
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

  const base =
    store.getUserDevice(actor.id, did) || store.getAnyUserDeviceForDeviceId(did) || {
      displayName: did,
      devEUI: '',
      notes: '',
      appEui: '',
      appKey: '',
      tag: '',
      lorawanClass: '',
      productModel: '',
    };
  const nowIso = new Date().toISOString();
  const prevA = store.getUserDevice(assignee.id, did);
  const pmFromBase = base.productModel != null ? String(base.productModel).trim() : '';
  const pmFromPrev = prevA && prevA.productModel != null ? String(prevA.productModel).trim() : '';
  const productModelMerged = (pmFromBase || pmFromPrev || '').slice(0, 200);
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
    productModel: productModelMerged,
    lorawanClass: base.lorawanClass || '',
    deviceSerialHex: base.deviceSerialHex || '',
    updatedAt: nowIso,
    createdAt: prevA ? prevA.createdAt : nowIso,
  };
  store.upsertUserDevice(row);
  if (assignee.role === 'superadmin') {
    store.syncUserDeviceToSuperadminPool(row);
  }
  const deuiA = String(row.devEUI || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (deuiA.length === 16 && row.lorawanClass != null && String(row.lorawanClass).trim() !== '') {
    store.lnsSyncSessionDeviceClass(assignee.id, deuiA, row.lorawanClass);
  }
  store.ensureDeviceLicenseIfMissing(did);
  store.upsertDeviceLabel(assignee.id, did, row.displayName);
  try {
    store.propagateDeviceBsdPreferencesToUser(actor.id, assignee.id, did);
    store.propagateDeviceDashboardWidgetsToUser(actor.id, assignee.id, did);
  } catch (e) {
    console.warn('[devices/assign] BSD prefs / dashboard widgets:', e.message || e);
  }
  invalidateDevicesListCache();
  res.status(prevA ? 200 : 201).json({ ok: true, userDevice: row });
});

/**
 * Borrado definitivo del equipo en SQLite: telemetría, **todas** las asignaciones (incl. superadmin), decode, licencia, etc.
 * Para solo quitar el vínculo de una cuenta: `DELETE /api/user-devices/:deviceId` o `DELETE /api/users/:userId/devices/:deviceId`.
 */
app.delete('/api/devices/:deviceId/permanent', authMiddleware, superAdminOnlyMiddleware, (req, res) => {
  const did = decodeURIComponent(req.params.deviceId || '').trim();
  if (!did) return res.status(400).json({ error: 'deviceId requerido' });
  store.purgeDeviceGlobally(did);
  res.json({ ok: true });
});

/**
 * Quita la asignación de un dispositivo a **un usuario concreto** (etiquetas/tablero BSD solo de esa cuenta).
 * No borra telemetría global, decode-config, presets compartidos ni licencia; el superadmin u otros asignados conservan su vínculo.
 * Permisos: `superadmin`, o usuario con módulos Usuarios + Dispositivos y objetivo descendiente en la jerarquía (`created_by`).
 */
app.delete('/api/users/:targetUserId/devices/:deviceId', authMiddleware, (req, res) => {
  const actor = store.getUserById(req.user.id);
  if (!actor) return res.status(401).json({ error: 'Usuario no encontrado' });
  const targetUserId = decodeURIComponent(String(req.params.targetUserId || '').trim());
  const did = decodeURIComponent(String(req.params.deviceId || '').trim());
  if (!targetUserId || !did) {
    return res.status(400).json({ error: 'targetUserId y deviceId requeridos' });
  }
  const canUnassignOther =
    actor.role === 'superadmin' ||
    (navPerm.userHasNav(actor, 'Users') &&
      navPerm.userHasNav(actor, 'Devices') &&
      store.isUserDescendantOf(req.user.id, targetUserId));
  if (!canUnassignOther) {
    return res.status(403).json({ error: 'Sin permiso para quitar este dispositivo a ese usuario' });
  }
  if (!store.getUserDevice(targetUserId, did)) {
    return res.status(404).json({ error: 'El usuario no tiene este dispositivo asignado' });
  }
  store.deleteUserDevice(targetUserId, did);
  res.json({ ok: true, unassignedUserId: targetUserId, deviceId: did });
});

app.get('/api/user-devices', authMiddleware, (req, res) => {
  res.json(store.listUserDevices(req.user.id));
});

app.post('/api/user-devices', authMiddleware, superAdminOnlyMiddleware, (req, res) => {
  const {
    deviceId,
    displayName,
    devEUI,
    appEUI,
    appKey,
    tag,
    notes,
    lorawanClass,
    serialNumber,
    sn,
    deviceSn,
    productModel,
    templateModel,
  } = req.body || {};
  const eui = devEUI != null ? String(devEUI).replace(/[^0-9a-fA-F]/gi, '').toLowerCase() : '';
  const idRaw = deviceId != null ? String(deviceId).trim() : '';
  const id = idRaw || eui;
  if (!id) {
    return res.status(400).json({ error: 'DevEUI o deviceId requerido', code: 'DEVICE_VALIDATION' });
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

  const prev = store.getUserDevice(req.user.id, id);
  /** El alta desde la UI no debe «actualizar en silencio»; las ediciones van por PATCH u otras rutas. */
  if (prev) {
    return res.status(409).json({
      error:
        'Este dispositivo ya está registrado en su cuenta (mismo DevEUI o identificador). No se puede duplicar el alta.',
      code: 'DEVICE_EXISTS',
    });
  }
  const pmBodyRaw = productModel !== undefined ? productModel : templateModel;
  const pmFromBody =
    pmBodyRaw != null && String(pmBodyRaw).trim() !== '' ? String(pmBodyRaw).trim().slice(0, 200) : '';
  const productModelStr =
    pmFromBody ||
    (prev && prev.productModel != null ? String(prev.productModel).trim().slice(0, 200) : '') ||
    '';
  const existingById = store.getAnyUserDeviceForDeviceId(id);
  if (existingById && (!prev || existingById.id !== prev.id)) {
    return res.status(409).json({
      error: 'Ya existe un dispositivo con este identificador en el sistema (no se puede duplicar).',
      code: 'DEVICE_EXISTS',
    });
  }
  const duEui = store.getAnyUserDeviceByDevEuiNorm(eui);
  if (duEui && (!prev || duEui.id !== prev.id)) {
    return res.status(409).json({
      error: 'Ya existe un dispositivo con este DevEUI en el sistema (no se puede duplicar).',
      code: 'DEVICE_EXISTS',
    });
  }
  const serialRawPick =
    serialNumber != null && String(serialNumber).trim() !== ''
      ? String(serialNumber)
      : sn != null && String(sn).trim() !== ''
        ? String(sn)
        : deviceSn != null && String(deviceSn).trim() !== ''
          ? String(deviceSn)
          : '';
  const serialNorm = String(serialRawPick || '').replace(/[^0-9a-fA-F]/gi, '').toLowerCase();
  const prevSerial = prev ? String(prev.deviceSerialHex || '').replace(/[^0-9a-fA-F]/gi, '').toLowerCase() : '';
  const mergedSerialHex = serialNorm.length >= 8 ? serialNorm : prevSerial;

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
    productModel: productModelStr,
    lorawanClass: lorawanClass != null ? String(lorawanClass) : prev?.lorawanClass,
    deviceSerialHex: mergedSerialHex.length >= 8 ? mergedSerialHex : prevSerial || '',
    updatedAt: nowIso,
    createdAt: prev ? prev.createdAt : nowIso,
  };
  store.upsertUserDevice(row);
  store.syncUserDeviceToSuperadminPool(row);
  try {
    const syncTpl = syncDeviceTemplateFromCatalog(store, id, row, req.user.id);
    if (syncTpl.applied) {
      const refreshed = store.getUserDevice(req.user.id, id);
      if (refreshed) Object.assign(row, refreshed);
    }
  } catch (e) {
    console.warn('[Syscom] syncDeviceTemplateFromCatalog (alta):', e.message);
  }
  if (/vs\s*133|vs133/i.test(productModelStr)) {
    const existingDec = store.getDeviceDecodeConfig(id);
    const hasScript =
      existingDec &&
      existingDec.decoderScript != null &&
      String(existingDec.decoderScript).trim().length > 0;
    if (!hasScript && VS133_BUILTIN_DECODER) {
      store.setDeviceDecodeConfig(id, VS133_BUILTIN_DECODER, '85', row.lorawanClass, productModelStr);
    }
  }
  const deuiSync = String(row.devEUI || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (deuiSync.length === 16 && row.lorawanClass != null && String(row.lorawanClass).trim() !== '') {
    for (const sid of store.listSuperadminUserIds()) {
      store.lnsSyncSessionDeviceClass(sid, deuiSync, row.lorawanClass);
    }
  }
  store.ensureDeviceLicenseIfMissing(id);
  store.upsertDeviceLabel(req.user.id, id, name);

  let lnsAutoBootstrap = { ok: false, skipped: true, reason: 'not_attempted' };
  try {
    lnsAutoBootstrap = tryBootstrapMilesightAbpSession(store, req.user.id, row, mergedSerialHex);
  } catch (e) {
    console.warn('[LNS] Auto Milesight ABP (alta dispositivo):', e.message || e);
    lnsAutoBootstrap = { ok: false, skipped: true, reason: 'exception', detail: String(e.message || e) };
  }

  res.status(201).json({ ...row, lnsAutoBootstrap });
});

app.patch('/api/user-devices/:deviceId', authMiddleware, superAdminOnlyMiddleware, (req, res) => {
  const did = decodeURIComponent(req.params.deviceId || '').trim();
  if (!did) return res.status(400).json({ error: 'deviceId requerido' });
  const ud = store.getUserDevice(req.user.id, did);
  if (!ud) return res.status(404).json({ error: 'Dispositivo no encontrado' });
  const lcRaw = req.body?.lorawanClass ?? req.body?.deviceClass;
  const cls = String(lcRaw ?? ud.lorawanClass ?? 'A')
    .trim()
    .toUpperCase();
  const lorawanClass = cls === 'B' || cls === 'C' ? cls : 'A';
  const pmRaw = req.body?.productModel ?? req.body?.templateModel;
  const productModel =
    pmRaw !== undefined ? String(pmRaw).trim().slice(0, 200) : String(ud.productModel || '').trim();
  const row = {
    ...ud,
    lorawanClass,
    productModel,
    updatedAt: new Date().toISOString(),
  };
  store.upsertUserDevice(row);
  store.syncUserDeviceToSuperadminPool(row);
  try {
    syncDeviceTemplateFromCatalog(store, did, row, req.user.id);
  } catch (e) {
    console.warn('[Syscom] syncDeviceTemplateFromCatalog (patch):', e.message);
  }
  const deui = String(row.devEUI || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (deui.length === 16) {
    for (const sid of store.listSuperadminUserIds()) {
      store.lnsSyncSessionDeviceClass(sid, deui, lorawanClass);
    }
  }
  res.json(row);
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
  deviceAssignmentMiddleware,
  (req, res) => {
    res.json(store.getDeviceDecodeConfig(req.params.deviceId));
  }
);

/** FPort y clase LoRaWAN efectivos para downlinks (misma cuenta y dispositivo asignado). */
app.get(
  '/api/devices/:deviceId/lora-profile',
  authMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
    const idStr = decodeURIComponent(req.params.deviceId || '').trim();
    if (!idStr) return res.status(400).json({ error: 'deviceId requerido' });
    const ud = getUserDeviceForActorReq(req, idStr);
    const cfg = store.getDeviceDecodeConfig(idStr);
    const fromDecRaw = decodeConfigLorawanClassRawForUserDevice(idStr, ud);
    const fromUd = String(ud?.lorawanClass || '').trim();
    const skipTelProf = String(process.env.SYSCOM_LNS_DOWNLINK_IGNORE_TELEMETRY_CLASS || '').trim() === '1';
    const tuidProf = telemetryUserIdForRequest(req, idStr);
    const fromTel = skipTelProf ? null : lorawanClassFromLatestTelemetry(tuidProf, idStr);
    const deuiProf = String(ud?.devEUI || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    const allowGlobal = req.user && req.user.role === 'superadmin';
    const sessionUserIdProf =
      deuiProf.length === 16
        ? store.lnsResolveSessionUserIdForDevice(idStr, req.user.id, deuiProf, {
            allowGlobalSessionFallback: allowGlobal,
          })
        : null;
    const sessProf =
      deuiProf.length === 16 && sessionUserIdProf
        ? store.lnsGetSessionByDevEui(sessionUserIdProf, deuiProf)
        : null;
    const fromSess = sessProf?.deviceClass != null ? String(sessProf.deviceClass).trim() : '';
    let raw = 'A';
    let lorawanClassSource = 'default';
    if (fromDecRaw) {
      raw = fromDecRaw;
      lorawanClassSource = 'decode';
    } else if (fromUd) {
      raw = fromUd;
      lorawanClassSource = 'user_device';
    } else if (fromSess) {
      raw = fromSess;
      lorawanClassSource = 'session';
    } else if (fromTel != null) {
      raw = fromTel;
      lorawanClassSource = 'telemetry';
    }
    res.json({
      channel: String(cfg.channel || '').trim(),
      lorawanClass: normalizeLnsDeviceClassLetter(raw),
      /** Origen del valor mostrado (mismo criterio que downlink sin `lorawanClass` en el cuerpo). */
      lorawanClassSource,
    });
  }
);

app.put(
  '/api/devices/:deviceId/decode-config',
  authMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
    const body = req.body || {};
    const { decoderScript, channel, lorawanClass } = body;
    const did = decodeURIComponent(req.params.deviceId || '').trim();
    if (!did) return res.status(400).json({ error: 'deviceId requerido' });
    let script = decoderScript != null ? String(decoderScript) : '';
    if (script.length > 512 * 1024) {
      return res.status(400).json({ error: 'Decoder demasiado largo (máx. 512 KB)' });
    }
    if (script.trim()) {
      script = prepareDecoderScriptForRuntime(script);
    }
    let ch = channel != null ? String(channel).trim().slice(0, 64) : '';
    let productModelPass = undefined;
    if (Object.prototype.hasOwnProperty.call(body, 'productModel')) {
      productModelPass = String(body.productModel ?? '').trim().slice(0, 200);
    } else if (Object.prototype.hasOwnProperty.call(body, 'templateModel')) {
      productModelPass = String(body.templateModel ?? '').trim().slice(0, 200);
    }
    if (!script.trim() && /vs\s*133|vs133/i.test(productModelPass || '')) {
      script = VS133_BUILTIN_DECODER;
      if (!ch) ch = '85';
    }
    store.setDeviceDecodeConfig(did, script, ch, lorawanClass, productModelPass);
    const cfgOut = store.getDeviceDecodeConfig(did);
    const lcFinal = normalizeLnsDeviceClassLetter(cfgOut.lorawanClass);
    const pmFromDecode = String(cfgOut.productModel || '').trim();
    const nowIso = new Date().toISOString();
    const assigneeIds = store.listUserIdsAssignedToDevice(did);
    for (const uid of assigneeIds) {
      const ud = store.getUserDevice(uid, did);
      if (!ud) continue;
      const udPm = String(ud.productModel || '').trim();
      const mergePm = udPm || pmFromDecode || '';
      store.upsertUserDevice({ ...ud, lorawanClass: lcFinal, productModel: mergePm, updatedAt: nowIso });
      const deui = String(ud.devEUI || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toLowerCase();
      if (deui.length === 16) {
        store.lnsSyncSessionDeviceClass(uid, deui, lcFinal);
      }
    }
    res.json(cfgOut);
  }
);

/**
 * AppKey / Join EUI (App EUI) para OTAA con el LNS integrado. Cualquier usuario con el dispositivo asignado.
 * Cuerpo: `{ "appEui": "…16 hex…", "appKey": "…32 hex…" }` — use cadena vacía para borrar un campo.
 */
app.patch(
  '/api/devices/:deviceId/lora-credentials',
  authMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
    const did = decodeURIComponent(req.params.deviceId || '').trim();
    if (!did) return res.status(400).json({ status: 'Error', errMsg: 'deviceId requerido' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const hasEui = Object.prototype.hasOwnProperty.call(body, 'appEui') || Object.prototype.hasOwnProperty.call(body, 'app_eui');
    const hasKey = Object.prototype.hasOwnProperty.call(body, 'appKey') || Object.prototype.hasOwnProperty.call(body, 'app_key');
    if (!hasEui && !hasKey) {
      return res.status(400).json({
        status: 'Error',
        errMsg: 'Indique appEui y/o appKey (hex). Use "" para vaciar.',
      });
    }
    const appEui = hasEui ? body.appEui ?? body.app_eui : undefined;
    const appKey = hasKey ? body.appKey ?? body.app_key : undefined;
    const r = store.patchUserDeviceLoraCredentials(req.user.id, did, { appEui, appKey });
    if (!r.ok) {
      if (r.error === 'not_found') return res.status(404).json({ status: 'Error', errMsg: 'Dispositivo no encontrado' });
      if (r.error === 'app_eui_invalid') {
        return res.status(400).json({ status: 'Error', errMsg: 'appEui debe ser 16 caracteres hex (8 bytes) o vacío.' });
      }
      if (r.error === 'app_key_invalid') {
        return res.status(400).json({ status: 'Error', errMsg: 'appKey debe ser 32 caracteres hex (16 bytes) o vacío.' });
      }
      return res.status(400).json({ status: 'Error', errMsg: r.error || 'No se pudo actualizar' });
    }
    const ud = getUserDeviceForActorReq(req, did);
    res.json({
      status: 'Success',
      deviceId: did,
      appEuiPreview: ud?.appEui ? `${String(ud.appEui).slice(0, 4)}…${String(ud.appEui).slice(-4)}` : '',
      appKeySet: Boolean(ud?.appKey && String(ud.appKey).replace(/[^0-9a-fA-F]/gi, '').length === 32),
    });
  }
);

/** Solo quita el vínculo del JWT actual (`user_devices` + etiquetas/tab BSD de esa cuenta); no afecta a otros asignados. */
app.delete(
  '/api/user-devices/:deviceId',
  authMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
    const id = decodeURIComponent(req.params.deviceId);
    store.deleteUserDevice(req.user.id, id);
    res.json({ ok: true });
  }
);

app.get('/api/automations', authMiddleware, (req, res) => {
  res.json({ rules: store.listAutomationRules(req.user.id) });
});

app.put('/api/automations', authMiddleware, navAutomationsMiddleware, (req, res) => {
  const { rules } = req.body || {};
  if (!Array.isArray(rules)) return res.status(400).json({ error: 'rules debe ser un array' });
  store.replaceAutomationRules(req.user.id, rules);
  res.json({ ok: true, count: rules.length });
});

const BACKUP_NAS_SETTING_KEY = 'backup_nas_destination';
const BACKUP_NAS_DEST_MAX_LEN = 2048;

/** Destino de copia de respaldos (solo superadmin). Ruta local/montaje → copia integrada; opcional SYSCOM_DB_BACKUP_SYNC_CMD con $FILE/$NAS. */
app.get('/api/admin/backup-config', authMiddleware, navSettingsMiddleware, (req, res) => {
  res.json({ nasDestination: store.getServerSetting(BACKUP_NAS_SETTING_KEY) });
});

app.put('/api/admin/backup-config', authMiddleware, navSettingsMiddleware, (req, res) => {
  const raw = req.body && req.body.nasDestination != null ? String(req.body.nasDestination) : '';
  if (raw.length > BACKUP_NAS_DEST_MAX_LEN) {
    return res.status(400).json({
      error: `La dirección no puede superar ${BACKUP_NAS_DEST_MAX_LEN} caracteres.`,
    });
  }
  if (raw.includes('..') || raw.includes('\0')) {
    return res.status(400).json({ error: 'La dirección no puede contener ".." ni caracteres nulos.' });
  }
  store.setServerSetting(BACKUP_NAS_SETTING_KEY, raw.trimEnd().slice(0, BACKUP_NAS_DEST_MAX_LEN));
  res.json({ ok: true, nasDestination: store.getServerSetting(BACKUP_NAS_SETTING_KEY) });
});

/** SMTP gratuito (Gmail, Outlook, Yahoo, GMX): estado y configuración. La contraseña en producción debe ir en variables de entorno. */
/** Estado SMTP global (sin contraseña): cualquier usuario autenticado puede ver si el correo del sistema está listo. */
app.get('/api/settings/smtp', authMiddleware, (req, res) => {
  try {
    res.json(smtpMail.getPublicSmtpStatus(store));
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : 'Error SMTP' });
  }
});

app.put('/api/settings/smtp', authMiddleware, navSettingsMiddleware, superAdminOnlyMiddleware, (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const status = smtpMail.saveSmtpConfig(store, body);
    res.json({ ok: true, ...status });
  } catch (e) {
    const code = e && e.code === 'VALIDATION' ? 400 : 500;
    res.status(code).json({ error: e && e.message ? e.message : 'No se pudo guardar SMTP' });
  }
});

app.post('/api/settings/smtp/test', authMiddleware, navSettingsMiddleware, superAdminOnlyMiddleware, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const to = String(body.to || '').trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'Indique un correo de prueba válido.' });
  }
  const inlineUser = String(body.user ?? body.from ?? '').trim();
  const inlinePass = String(body.password ?? body.pass ?? '').trim();
  const configOverride =
    inlineUser || inlinePass || body.provider != null || body.host != null
      ? {
          user: inlineUser,
          password: inlinePass,
          provider: body.provider,
          host: body.host,
          port: body.port,
        }
      : undefined;
  try {
    const result = await smtpMail.sendNotificationEmail(store, {
      to,
      subject: 'Prueba SYSCOM IoT — SMTP',
      text: `Este es un correo de prueba enviado desde SYSCOM IoT el ${new Date().toLocaleString()}.\nSi lo recibió, la configuración SMTP es correcta.`,
      meta: { source: 'smtp_test' },
      configOverride,
      allowQueue: false,
    });
    res.json({
      ok: true,
      queued: Boolean(result && result.queued),
      messageId: result && result.messageId,
      reason: result && result.reason,
    });
  } catch (e) {
    const classified = smtpMail.classifySmtpError(e.cause || e);
    const status =
      classified.code === 'NOT_CONFIGURED' || classified.code === 'VALIDATION' ? 400 : 502;
    res.status(status).json({
      error: classified.userMessage || (e && e.message) || 'Envío fallido',
      code: classified.code,
    });
  }
});

/** Volcado completo SQLite (solo superadmin): usuarios, dispositivos, gateways, historial, reglas, dashboards, LNS, etc. */
app.get('/api/admin/database/export', authMiddleware, navSettingsMiddleware, (req, res) => {
  const os = require('os');
  const tmp = path.join(
    os.tmpdir(),
    `syscom-export-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`
  );
  try {
    store.exportDatabaseSnapshotToPath(tmp);
    const fname = `syscom-backup-${new Date().toISOString().slice(0, 10)}.db`;
    res.download(tmp, fname, (err) => {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        /* ignore */
      }
      if (err && !res.headersSent) {
        console.warn('[admin/database/export]', err.message);
      }
    });
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (x) {
      /* ignore */
    }
    res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * Restauración desde volcado SQLite (solo superadmin). Cuerpo: bytes del .db (application/octet-stream).
 * Tras importar conviene reiniciar el proceso Node para el motor LNS.
 */
app.post(
  '/api/admin/database/import',
  authMiddleware,
  superAdminOnlyMiddleware,
  express.raw({ limit: '512mb', type: () => true }),
  (req, res) => {
    try {
      const body = req.body;
      const len = Buffer.isBuffer(body) ? body.length : body ? Buffer.byteLength(body) : 0;
      if (!body || len < 512) {
        return res.status(400).json({
          error:
            'Cuerpo vacío o demasiado pequeño. Envíe el archivo .db como application/octet-stream (sin multipart).',
        });
      }
      store.replaceMainDatabaseFromBuffer(body);
      resetLnsEngineAfterDatabaseImport();
      res.json({
        ok: true,
        message:
          'Base de datos restaurada. Reinicie el proceso del servidor si usa LoRaWAN LNS. Los clientes pueden tener que volver a iniciar sesión.',
      });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  }
);

/** Reenvío servidor → URL externa (evita CORS del navegador en webhooks de reglas). */
app.post('/api/automation/webhook-relay', authMiddleware, navAutomationsMiddleware, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const payload = req.body?.payload;
  if (!url) return res.status(400).json({ error: 'url requerida' });
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'payload debe ser un objeto JSON' });
  }
  const verr = validateWebhookRelayUrl(url);
  if (verr) return res.status(400).json({ error: verr });
  try {
    const out = await relayWebhookPost(url, payload, {
      forcePushMorePlain:
        Boolean(req.body?.pushMorePlain) && /pushmore\.io\/webhook\//i.test(String(url)),
    });
    if (!out.ok) {
      return res.status(502).json({
        error: `El destino respondió HTTP ${out.status}`,
        upstreamStatus: out.status,
        upstreamBodyPreview: out.textSnippet,
      });
    }
    return res.json({ ok: true, upstreamStatus: out.status, upstreamBodyPreview: out.textSnippet });
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'Tiempo de espera agotado al contactar la URL' : e.message || 'Error de red';
    return res.status(502).json({ error: msg });
  }
});

app.get('/api/downlinks', authMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json({ list: store.listDownlinks(req.user.id, limit) });
});

app.get('/api/devices/:deviceId/properties', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const tuid = telemetryUserIdForRequest(req, req.params.deviceId);
  const did = String(req.params.deviceId);
  const decodeCfg = store.getDeviceDecodeConfig(did);
  const pm = decodeCfg && decodeCfg.productModel != null ? String(decodeCfg.productModel).trim() : '';
  let latest = store.getMergedLatestTelemetryForDevice(tuid, did, { historyRowLimit: 16 });
  if (latest?.properties) {
    let props = enrichStoredTelemetryProperties(store, did, { ...latest.properties });
    applyVs133TelemetryAliases(props, { productModel: pm });
    latest = { ...latest, properties: props };
  }
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
  const tuid = telemetryUserIdForRequest(req, req.params.deviceId);
  const latest = store.getMergedLatestTelemetryForDevice(tuid, req.params.deviceId, {
    historyRowLimit: 24,
  });
  const props = latest?.properties || {};
  const flat = flattenTelemetryProps(props);
  const list = Object.keys(flat)
    .sort()
    .map((k) => ({ id: k, propertyKey: k, name: k, unit: '' }));
  res.json({ status: 'Success', data: { properties: list } });
  }
);

app.get('/api/devices/:deviceId/dashboard-widgets', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const widgets = store.getDeviceDashboardWidgetsWithPeerFallback(req.user.id, req.params.deviceId);
  res.json({ status: 'Success', widgets });
});

function handleDashboardWidgetsSave(req, res) {
  try {
    if (!assertDeviceAssignedToUser(req, res, req.params.deviceId)) return;
    const result = validateDashboardWidgets(req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    store.setDeviceDashboardWidgetsForAllAssignees(req.params.deviceId, result.widgets, req.user.id);
    res.json({ status: 'Success', widgets: result.widgets });
  } catch (e) {
    console.error('[dashboard-widgets]', e);
    res.status(500).json({ error: e.message || 'Error al guardar el tablero' });
  }
}

app.put('/api/devices/:deviceId/dashboard-widgets', authMiddleware, deviceAssignmentMiddleware, handleDashboardWidgetsSave);
/** Mismo cuerpo que PUT; por si el proxy o el cliente no envían PUT correctamente. */
app.post('/api/devices/:deviceId/dashboard-widgets', authMiddleware, deviceAssignmentMiddleware, handleDashboardWidgetsSave);

function normalizeDeviceBsdPreferencesBody(body) {
  if (!body || typeof body !== 'object') return { error: 'Cuerpo inválido' };
  const out = {};
  if (body.valueWidgets && typeof body.valueWidgets === 'object') out.valueWidgets = body.valueWidgets;
  if (Array.isArray(body.gridLayout)) out.gridLayout = body.gridLayout;
  if (body.visibility && typeof body.visibility === 'object') out.visibility = body.visibility;
  if (Array.isArray(body.downlinks)) out.downlinks = body.downlinks;
  const json = JSON.stringify(out);
  if (json.length > 900000) return { error: 'Preferencias demasiado grandes (máx. ~900 KB)' };
  return { ok: true, prefs: out };
}

app.get('/api/devices/:deviceId/bsd-preferences', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  try {
    const { prefs, updatedAt } = store.getDeviceBsdPreferencesWithPeerFallback(
      req.user.id,
      req.params.deviceId
    );
    res.json({ status: 'Success', prefs, updatedAt });
  } catch (e) {
    console.error('[bsd-preferences GET]', e);
    res.status(500).json({ error: e.message || 'Error al leer preferencias' });
  }
});

app.put('/api/devices/:deviceId/bsd-preferences', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  try {
    if (!assertDeviceAssignedToUser(req, res, req.params.deviceId)) return;
    const r = normalizeDeviceBsdPreferencesBody(req.body || {});
    if (r.error) return res.status(400).json({ error: r.error });
    const did = req.params.deviceId;
    if (req.user.role === 'superadmin' || Boolean(req.user.nav && req.user.nav.Devices)) {
      store.setDeviceBsdPreferencesForAllAssignees(did, r.prefs, req.user.id);
    } else {
      store.setDeviceBsdPreferences(req.user.id, did, r.prefs);
    }
    const { prefs, updatedAt } = store.getDeviceBsdPreferences(req.user.id, did);
    res.json({ status: 'Success', prefs, updatedAt });
  } catch (e) {
    console.error('[bsd-preferences PUT]', e);
    res.status(400).json({ error: e.message || 'Error al guardar preferencias' });
  }
});

app.get('/api/me/panel-bsd-preferences', authMiddleware, (req, res) => {
  try {
    const seg = req.query.segment != null ? String(req.query.segment) : '';
    const panelId =
      req.query.panelId != null && String(req.query.panelId).trim() ? String(req.query.panelId).trim() : 'main';
    const { prefs, updatedAt } = store.getUserPanelBsdPreferences(req.user.id, seg, panelId);
    res.json({ status: 'Success', prefs, updatedAt });
  } catch (e) {
    console.error('[panel-bsd-preferences GET]', e);
    res.status(500).json({ error: e.message || 'Error al leer preferencias del panel' });
  }
});

app.put('/api/me/panel-bsd-preferences', authMiddleware, (req, res) => {
  try {
    const segment = req.body?.segment != null ? String(req.body.segment) : '';
    const panelId =
      req.body?.panelId != null && String(req.body.panelId).trim() ? String(req.body.panelId).trim() : 'main';
    const r = normalizeDeviceBsdPreferencesBody(req.body || {});
    if (r.error) return res.status(400).json({ error: r.error });
    store.setUserPanelBsdPreferences(req.user.id, segment, panelId, r.prefs);
    const { prefs, updatedAt } = store.getUserPanelBsdPreferences(req.user.id, segment, panelId);
    res.json({ status: 'Success', prefs, updatedAt });
  } catch (e) {
    console.error('[panel-bsd-preferences PUT]', e);
    res.status(400).json({ error: e.message || 'Error al guardar preferencias del panel' });
  }
});

app.get('/api/devices/:deviceId/properties/history', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const { startTime, endTime, pageSize } = req.query;
  const startMs = startTime != null ? Number(startTime) : undefined;
  const endMs = endTime != null ? Number(endTime) : undefined;
  const limit = pageSize != null ? Number(pageSize) : 50;
  const tuid = telemetryUserIdForRequest(req, req.params.deviceId);
  const entries = store.getTelemetryHistory(tuid, req.params.deviceId, {
    startMs,
    endMs,
    limit,
  });
  const did = String(req.params.deviceId);
  const dlLimit = Math.min(parseInt(String(req.query.downlinkLimit || pageSize || limit), 10) || limit, 200);
  const downlinks = store.listDownlinksForDevice(tuid, did, dlLimit).map((dl) => {
    const ts = dl.createdAt ? Date.parse(dl.createdAt) : NaN;
    return {
      id: dl.id,
      timestamp: Number.isFinite(ts) ? ts : Date.now(),
      kind: 'downlink',
      payloadHex: dl.payloadHex != null ? String(dl.payloadHex) : '',
      source: dl.source != null ? String(dl.source) : 'user',
      ruleId: dl.ruleId != null ? String(dl.ruleId) : null,
      ruleName: dl.ruleName != null ? String(dl.ruleName) : null,
      actorUserName: dl.actorUserName != null ? String(dl.actorUserName) : null,
      deferred: Boolean(dl.deferred),
    };
  });
  res.json({
    list: entries.map((t) => ({
      kind: 'telemetry',
      timestamp: t.timestamp,
      properties: enrichStoredTelemetryProperties(store, did, t.properties && typeof t.properties === 'object' ? t.properties : {}),
    })),
    downlinks,
  });
});

app.put('/api/devices', authMiddleware, staffOnlyMiddleware, (req, res) => {
  const body = req.body || {};
  const { deviceId, name, tag } = body;
  if (!deviceId) return res.status(400).json({ status: 'Error', errMsg: 'deviceId requerido' });
  const idStr = deviceId.toString();
  if (!assertDeviceAssignedToUser(req, res, idStr)) return;
  const ud = getUserDeviceForActorReq(req, idStr);
  if (!ud) return res.status(400).json({ status: 'Error', errMsg: 'Dispositivo no asignado a su cuenta' });
  const displayName = name != null ? String(name).trim() : String(ud.displayName || '').trim();
  if (!displayName) return res.status(400).json({ status: 'Error', errMsg: 'Indique el nombre del dispositivo' });
  const tagStr = Object.prototype.hasOwnProperty.call(body, 'tag')
    ? String(tag ?? '').trim().slice(0, 128)
    : String(ud.tag || '').trim().slice(0, 128);
  store.upsertDeviceLabel(req.user.id, idStr, displayName);
  store.upsertUserDevice({
    ...ud,
    displayName,
    tag: tagStr,
    updatedAt: new Date().toISOString(),
  });
  res.json({ status: 'Success' });
});

app.post('/api/devices/:deviceId/downlink', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const idStr = req.params.deviceId.toString();
  const { ud, lnsOpts } = downlinkRequestContext(req, idStr);
  if (!ud) return res.status(404).json({ error: 'Dispositivo no encontrado' });
  const r = tryLnsAppDownlinkEnqueue(req.user.id, idStr, ud, req.body, lnsOpts);
  const actor = store.getUserById(req.user.id);
  const actorUserName = String(actor?.profileName || actor?.email || 'Usuario').trim() || 'Usuario';
  return sendHttpResponseAfterLnsAppDownlinkEnqueue(res, req.user.id, r, {
    deviceIdStr: idStr,
    logSource: 'user',
    actorUserName,
  });
});

/**
 * JWT de integración (larga vigencia, revocable). Solo staff: las cuentas finales usan JWT de sesión y
 * `POST /api/devices/:deviceId/downlink` con dispositivo asignado.
 * Cuerpo opcional: `{ "label": "Datacake", "expiresInDays": 365 }` (máx. 730).
 */
app.post('/api/lns/integration-tokens', authMiddleware, staffOnlyMiddleware, (req, res) => {
  let days = parseInt(String(req.body?.expiresInDays ?? '365'), 10);
  if (!Number.isFinite(days)) days = 365;
  days = Math.min(730, Math.max(1, days));
  const label = String(req.body?.label || '').trim().slice(0, 200);
  const jti = crypto.randomUUID();
  if (!store.lnsIntegrationTokenRecord(jti, req.user.id, label)) {
    return res.status(500).json({ error: 'No se pudo registrar el token (jti duplicado improbable)' });
  }
  let token;
  try {
    token = jwt.sign(
      { typ: 'lns_integration', sub: req.user.id, role: req.user.role },
      LNS_INTEGRATION_JWT_SECRET,
      { expiresIn: `${days}d`, jwtid: jti }
    );
  } catch (e) {
    store.lnsIntegrationTokenRevoke(req.user.id, jti);
    return res.status(500).json({ error: e.message || 'sign_failed' });
  }
  res.json({
    status: 'Success',
    token,
    jti,
    expiresInDays: days,
    message:
      'Guarde el valor de `token` ahora; no se vuelve a mostrar. Downlinks solo por el LNS integrado: Authorization: Bearer + POST /api/lns/v1/devices/{devEUI}/queue (payloadBase64 o payloadHex, fPort opcional).',
  });
});

app.get('/api/lns/integration-tokens', authMiddleware, staffOnlyMiddleware, (req, res) => {
  res.json({ status: 'Success', tokens: store.lnsIntegrationTokenList(req.user.id) });
});

app.delete('/api/lns/integration-tokens/:jti', authMiddleware, staffOnlyMiddleware, (req, res) => {
  const jti = decodeURIComponent(String(req.params.jti || '').trim());
  const ok = store.lnsIntegrationTokenRevoke(req.user.id, jti);
  if (!ok) return res.status(404).json({ error: 'Token no encontrado o ya revocado' });
  res.json({ status: 'Success', jti });
});

/**
 * Cola de downlink vía LNS propio (no API del gateway Milesight). Autenticación: JWT de integración.
 */
app.post('/api/lns/v1/devices/:devEUI/queue', lnsIntegrationAuthMiddleware, (req, res) => {
  const deuiPath = String(req.params.devEUI || '')
    .replace(/[^0-9a-fA-F]/gi, '')
    .toLowerCase();
  if (deuiPath.length !== 16) {
    return res.status(400).json({ error: 'devEUI debe ser 16 caracteres hexadecimales', code: 'DEUI_INVALID' });
  }
  const ud = store.getUserDeviceByDevEuiNorm(req.user.id, deuiPath);
  if (!ud) {
    return res.status(404).json({ error: 'Dispositivo no encontrado o no asignado a esta cuenta', code: 'NOT_FOUND' });
  }
  const r = tryLnsAppDownlinkEnqueue(req.user.id, ud.deviceId, ud, req.body);
  return sendHttpResponseAfterLnsAppDownlinkEnqueue(res, req.user.id, r, {
    deviceIdStr: ud.deviceId,
    viaLnsIntegrationToken: true,
  });
});

/**
 * Borra la sesión LNS (OTAA) del dispositivo en SQLite. Tras esto el nodo debe volver a hacer Join
 * (reinicio / rejoin); corrige MIC inválido cuando las claves de sesión en BD ya no coinciden con el nodo.
 */
app.delete(
  '/api/devices/:deviceId/lns/session',
  authMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
    const idStr = String(req.params.deviceId || '').trim();
    const ud = getUserDeviceForActorReq(req, idStr);
    if (!ud) return res.status(404).json({ status: 'Error', errMsg: 'Dispositivo no encontrado' });
    const deui = String(ud.devEUI || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (deui.length !== 16) {
      return res.status(400).json({
        status: 'Error',
        errMsg: 'El dispositivo no tiene DevEUI (16 hex) en el alta; no hay sesión LNS que borrar.',
      });
    }
    const lnsUid = store.lnsResolveSessionUserIdForDevice(idStr, req.user.id, deui, {
      allowGlobalSessionFallback: req.user.role === 'superadmin',
    });
    const { removed, devEui } = store.lnsDeleteSessionForUserDev(lnsUid, deui);
    res.json({
      status: 'Success',
      removed,
      devEui,
      hint:
        removed > 0
          ? 'Sesión eliminada. Provocar Join OTAA en el nodo (p. ej. reinicio) para registrar nuevas claves.'
          : 'No había fila en lorawan_lns_sessions; si el MIC falla, el nodo puede estar usando otra sesión o AppKey distinta.',
    });
  }
);

/**
 * Estado de sesión MAC LoRaWAN (sin exponer claves completas).
 */
app.get('/api/devices/:deviceId/lns/session', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const idStr = String(req.params.deviceId || '').trim();
  const ud = getUserDeviceForActorReq(req, idStr);
  if (!ud) return res.status(404).json({ status: 'Error', errMsg: 'Dispositivo no encontrado' });
  const deui = String(ud.devEUI || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (deui.length !== 16) {
    return res.status(400).json({
      status: 'Error',
      errMsg: 'El dispositivo no tiene DevEUI (16 hex); no aplica sesión LNS.',
    });
  }
  const lnsUid = store.lnsResolveSessionUserIdForDevice(idStr, req.user.id, deui, {
    allowGlobalSessionFallback: req.user.role === 'superadmin',
  });
  const sess = store.lnsGetSessionByDevEui(lnsUid, deui);
  if (!sess) {
    return res.json({
      status: 'Success',
      session: null,
      hint: 'Sin sesión en el LNS. Use OTAA (join por radio) o importe DevAddr + NwkSKey + AppSKey si el nodo está en ABP o exportó claves de otro servidor.',
    });
  }
  let nk = '';
  try {
    nk = sess.nwkSKey && typeof sess.nwkSKey.toString === 'function' ? sess.nwkSKey.toString('hex') : '';
  } catch {
    nk = '';
  }
  const mask = nk.length >= 8 ? `${nk.slice(0, 4)}…${nk.slice(-4)}` : '';
  res.json({
    status: 'Success',
    session: {
      devEui: sess.devEui,
      devAddr: sess.devAddr,
      fcntUp: sess.fcntUp,
      fcntDown: sess.fcntDown,
      deviceClass: sess.deviceClass,
      lastGatewayEui: sess.lastGatewayEui || '',
      lastUplinkWallMs: sess.lastUplinkWallMs,
      nwkSKeyPreview: mask,
    },
  });
});

/**
 * Ajusta solo `fcnt_down` en sesión (p. ej. el servidor avanzó el contador sin TX al aire y el nodo rechaza downlinks).
 * Cuerpo: `{ "fcntDown": -1 }` para que el siguiente downlink use de nuevo **FCnt 0**; o un valor 0..65535
 * igual al último FCnt↓ que el nodo **sí** decodificó (el siguiente envío será ese valor + 1).
 * Vacía la cola PULL_RESP de aplicación pendiente para este DevEUI.
 */
app.patch(
  '/api/devices/:deviceId/lns/session',
  authMiddleware,
  deviceAssignmentMiddleware,
  (req, res) => {
    const idStr = String(req.params.deviceId || '').trim();
    const ud = getUserDeviceForActorReq(req, idStr);
    if (!ud) return res.status(404).json({ status: 'Error', errMsg: 'Dispositivo no encontrado' });
    const deui = String(ud.devEUI || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (deui.length !== 16) {
      return res.status(400).json({
        status: 'Error',
        errMsg: 'El dispositivo no tiene DevEUI (16 hex); no aplica sesión LNS.',
      });
    }
    const lnsUid = store.lnsResolveSessionUserIdForDevice(idStr, req.user.id, deui, {
      allowGlobalSessionFallback: req.user.role === 'superadmin',
    });
    const sess = store.lnsGetSessionByDevEui(lnsUid, deui);
    if (!sess) {
      return res.status(404).json({
        status: 'Error',
        errMsg: 'Sin sesión LNS para este dispositivo.',
        code: 'NO_SESSION',
      });
    }
    const raw = req.body?.fcntDown ?? req.body?.fcnt_down;
    if (raw == null || String(raw).trim() === '' || !Number.isFinite(Number(raw))) {
      return res.status(400).json({
        status: 'Error',
        errMsg: 'Indique fcntDown (número). Use -1 para reiniciar el contador de bajada (siguiente trama con FCnt 0).',
      });
    }
    const n = Math.floor(Number(raw));
    if (n < -1 || n > 65535) {
      return res.status(400).json({
        status: 'Error',
        errMsg: 'fcntDown debe estar entre -1 y 65535.',
      });
    }
    const removedQueue = store.lnsDeletePendingAppDownlinksForDev(lnsUid, deui);
    store.lnsSetFcntDown(lnsUid, deui, n);
    res.json({
      status: 'Success',
      devEui: deui,
      fcntDown: n,
      pendingAppDownlinksRemoved: removedQueue,
      hint:
        n === -1
          ? 'El próximo downlink usará FCnt 0. Si el nodo ya había recibido tramas antes, fije fcntDown al último FCnt aceptado por el nodo.'
          : `El próximo downlink usará FCnt ${(n + 1) % 65536}.`,
    });
  }
);

/**
 * Crea o actualiza la sesión LoRaWAN en SQLite (NwkSKey / AppSKey / DevAddr) para alinear el LNS con el nodo
 * cuando ya conoce las claves de sesión (ABP, migración desde otro NS, o copia tras un join en otro sistema).
 * No sustituye OTAA: si las claves no coinciden con el firmware, seguirá habiendo MIC inválido.
 */
app.post('/api/devices/:deviceId/lns/session', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const idStr = String(req.params.deviceId || '').trim();
  const ud = getUserDeviceForActorReq(req, idStr);
  if (!ud) return res.status(404).json({ status: 'Error', errMsg: 'Dispositivo no encontrado' });
  const deui = String(ud.devEUI || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (deui.length !== 16) {
    return res.status(400).json({
      status: 'Error',
      errMsg: 'El dispositivo no tiene DevEUI (16 hex); no se puede guardar sesión LNS.',
    });
  }
  const devAddr = String(req.body?.devAddr || req.body?.dev_addr || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
  const nwkSKey = String(req.body?.nwkSKey || req.body?.nwk_s_key || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  const appSKey = String(req.body?.appSKey || req.body?.app_s_key || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (devAddr.length !== 8) {
    return res.status(400).json({ status: 'Error', errMsg: 'devAddr debe ser 8 caracteres hex (4 bytes).' });
  }
  if (nwkSKey.length !== 32 || appSKey.length !== 32) {
    return res.status(400).json({
      status: 'Error',
      errMsg: 'nwkSKey y appSKey deben ser 32 caracteres hex (16 bytes) cada una.',
    });
  }
  const sessOwnerId = String(ud.userId);
  const other = store.lnsGetSessionByDevAddr(sessOwnerId, devAddr);
  if (other && String(other.devEui).toLowerCase() !== deui) {
    return res.status(409).json({
      status: 'Error',
      errMsg: `El DevAddr ${devAddr} ya está asignado a otra sesión (dev_eui ${other.devEui}). Elija otro DevAddr o borre la otra sesión.`,
      code: 'DEVADDR_IN_USE',
    });
  }
  let gwNorm = String(req.body?.gatewayEui || req.body?.gateway_eui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  if (gwNorm.length !== 16) {
    const gws =
      req.user.role === 'superadmin'
        ? store.listLorawanGatewaysUnifiedForSuperadmin()
        : store.listLorawanGateways(req.user.id);
    gwNorm = gws.length > 0 ? String(gws[0].gatewayEui || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase() : '';
  }
  if (gwNorm.length !== 16) {
    return res.status(400).json({
      status: 'Error',
      errMsg:
        'Indique gatewayEui (16 hex) en el cuerpo o dé de alta al menos un gateway LoRaWAN en la app para fijar last_gateway_eui.',
    });
  }
  const bandU = (() => {
    const row =
      store.lnsGetGatewayByEui(sessOwnerId, gwNorm) ||
      (typeof store.lnsGetGatewayByEuiAnyUser === 'function'
        ? store.lnsGetGatewayByEuiAnyUser(gwNorm)
        : null);
    return row ? String(row.frequencyBand || '').toUpperCase() : '';
  })();
  const isUs = isUs915ForUserGateway(bandU);
  const rxDelaySec = Math.max(1, Math.min(15, Number(req.body?.rxDelaySec ?? req.body?.rx_delay_sec) || (isUs ? 5 : 1)));
  const clsRaw = req.body?.deviceClass ?? req.body?.lorawanClass ?? ud.lorawanClass ?? 'A';
  const cls = String(clsRaw || 'A')
    .trim()
    .toUpperCase();
  const deviceClass = cls === 'B' || cls === 'C' ? cls : 'A';
  const fcntUpRaw = req.body?.fcntUp ?? req.body?.fcnt_up;
  const fcntUp =
    fcntUpRaw != null && String(fcntUpRaw).trim() !== '' && Number.isFinite(Number(fcntUpRaw))
      ? Math.max(0, Math.floor(Number(fcntUpRaw)))
      : -1;
  const lastRxFreq =
    req.body?.lastRxFreq != null && Number.isFinite(Number(req.body.lastRxFreq))
      ? Number(req.body.lastRxFreq)
      : isUs
        ? 905.3
        : 868.5;
  const lastRxDatr = String(req.body?.lastRxDatr || req.body?.last_rx_datr || (isUs ? 'SF10BW125' : 'SF12BW125')).trim();
  const upsert = {
    userId: sessOwnerId,
    devEui: deui,
    devAddr,
    nwkSKeyHex: nwkSKey,
    appSKeyHex: appSKey,
    lastGatewayEui: gwNorm,
    lastRxTmst: 0,
    lastRxFreq,
    lastRxDatr,
    lastRxCodr: '4/5',
    lastRxRfch: 0,
    deviceClass,
    lastUplinkWallMs: Date.now(),
    classBPingPeriodicity: -1,
    classBDataRate: null,
    rxDelaySec,
    pendingMacAck: false,
  };
  store.lnsUpsertSessionJoin(upsert);
  store.lnsSyncSessionDeviceClass(sessOwnerId, deui, deviceClass);
  if (fcntUp >= 0) {
    store.lnsSetFcntUp(sessOwnerId, deui, fcntUp);
  }
  const ts = Date.now();
  store.appendTelemetry(sessOwnerId, idStr, ud.displayName || idStr, {
    devEUI: deui,
    deviceId: idStr,
    lorawan_event: 'lns_session_upserted',
    devAddr,
    connectStatus: 'joined',
    gateway_id: gwNorm,
    fcnt_up_seed: fcntUp,
  }, ts);
  res.json({
    status: 'Success',
    devEui: deui,
    devAddr,
    gatewayEui: gwNorm,
    deviceClass,
    fcntUp: fcntUp >= 0 ? fcntUp : null,
    hint: 'Sesión guardada. El siguiente uplink por radio debe pasar MIC si las claves coinciden con el nodo.',
  });
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
    lastRxTmst: 0,
    lastRxFreq: 905.3,
    lastRxDatr: 'SF10BW125',
    lastRxCodr: '4/5',
    lastRxRfch: 0,
    deviceClass,
    lastUplinkWallMs: Date.now(),
    rxDelaySec: 5,
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
  deviceAssignmentMiddleware,
  (req, res) => {
    const idStr = decodeURIComponent(String(req.params.deviceId || '').trim());
    const serviceId = String(req.body?.serviceId || '').trim();
    if (!idStr) return res.status(400).json({ status: 'Error', errMsg: 'deviceId requerido' });
    if (!serviceId) return res.status(400).json({ status: 'Error', errMsg: 'serviceId requerido' });
    const { ud, lnsOpts } = downlinkRequestContext(req, idStr);
    if (!ud) return res.status(404).json({ status: 'Error', errMsg: 'Dispositivo no encontrado' });
    const hex = resolveAutomationDownlinkHex({
      commandKey: serviceId,
      targetDeviceId: idStr,
      target: serviceId,
    });
    if (!hex) {
      return res.status(400).json({
        status: 'Error',
        errMsg:
          'Servicio no mapeado a payload hex en este servidor. Use POST /api/devices/:deviceId/downlink con payloadHex, o un id admitido (p. ej. system_on, system_off, reboot, sync_time, temperature_control_enable).',
        code: 'SERVICE_NOT_MAPPED',
      });
    }
    const r = tryLnsAppDownlinkEnqueue(
      req.user.id,
      idStr,
      ud,
      {
        payloadHex: hex,
        confirmed: req.body?.confirmed === true,
      },
      lnsOpts
    );
    return sendHttpResponseAfterLnsAppDownlinkEnqueue(res, req.user.id, r, {
      deviceIdStr: idStr,
      logSource: 'service_call',
    });
  }
);

// ── Telemetry (cliente autenticado) ───────────────────────
app.get('/api/devices/latest', authMiddleware, (req, res) => {
  const key = `${req.user.role}:${req.user.id}`;
  const now = Date.now();
  if (
    devicesLatestCache.key === key &&
    devicesLatestCache.data &&
    now - devicesLatestCache.at < DEVICES_LATEST_CACHE_MS
  ) {
    return res.json(devicesLatestCache.data);
  }
  const data = store.getLatestTelemetryListForActor(req.user.id, req.user.role);
  devicesLatestCache = { key, at: now, data };
  res.json(data);
});

app.post('/api/telemetry', authMiddleware, staffOnlyMiddleware, (req, res) => {
  const { deviceId, deviceName, properties } = req.body;
  const did = deviceId.toString();
  if (store.lastPropertiesJsonEqual(req.user.id, did, properties)) {
    metrics.inc('telemetry_duplicate_skipped');
    return res.status(200).json({ ok: true, saved: false, reason: 'no_change' });
  }
  const ts = Date.now();
  store.appendTelemetry(req.user.id, did, deviceName, properties, ts);
  metrics.inc('telemetry_saved');
  res.status(201).json({ ok: true, saved: true });
});

app.get('/api/telemetry/:deviceId', authMiddleware, deviceAssignmentMiddleware, (req, res) => {
  const { startMs, endMs, propKey, limit } = req.query;
  let maxRows = 500;
  if (limit != null && limit !== '') {
    const n = parseInt(String(limit), 10);
    if (Number.isFinite(n)) maxRows = Math.min(4000, Math.max(50, n));
  }
  const tuid = telemetryUserIdForRequest(req, req.params.deviceId);
  const entries = store.getTelemetrySeries(
    tuid,
    req.params.deviceId,
    startMs,
    endMs,
    propKey,
    maxRows
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
app.post('/api/reset-password', loginRateLimit, superAdminOrLegacySecret, (req, res) => {
  const { email, newPassword, adminSecret } = req.body;
  if (adminSecret != null && !matchesLegacyAdminSecret(req)) return res.status(403).json({ error: 'Clave incorrecta' });
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

app.get('/api/admin/users', loginRateLimit, superAdminOrLegacySecret, (req, res) => {
  if (req.query?.adminSecret != null && !matchesLegacyAdminSecret(req)) {
    return res.status(403).json({ error: 'Clave incorrecta' });
  }
  const users = store.allUsersSanitized().map(({ password: _, ...rest }) => rest);
  res.json(users);
});

// ── Setup ──────────────────────────────────────────────────
app.post('/api/setup', loginRateLimit, (req, res) => {
  if (!setupNeedsBootstrap()) {
    return res.status(409).json({
      error: 'Ya existen usuarios en el sistema. Use el inicio de sesión o un administrador con acceso a la base.',
      code: 'SETUP_ALREADY_COMPLETED',
    });
  }
  const { password, profileName } = req.body;
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Correo electrónico no válido' });
  }
  if (store.getUserByEmail(email)) {
    return res.status(409).json({
      error: 'Ese correo ya está registrado.',
      code: 'USER_EXISTS',
    });
  }
  const pv = validatePasswordStrength(password);
  if (!pv.ok) return res.status(400).json({ error: pv.error });
  const admin = {
    id: Date.now().toString(),
    email,
    password: bcrypt.hashSync(password, 10),
    role: 'superadmin',
    profileName: profileName || 'Super administrador',
    createdBy: null,
    createdByEmail: null,
    ingestToken: crypto.randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
    mustChangePassword: false,
    navPermissionsJson: navPerm.navToJson(navPerm.allNavTrue()),
  };
  try {
    store.insertUser(admin);
  } catch (e) {
    const msg = String(e && e.message);
    if (msg.includes('UNIQUE') && msg.toLowerCase().includes('email')) {
      return res.status(409).json({ error: 'Ese correo ya está registrado.', code: 'USER_EXISTS' });
    }
    throw e;
  }
  res.status(201).json({ ok: true });
});

app.get('/api/setup/status', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  let userCount = 0;
  let countOk = true;
  try {
    userCount = store.countUsers();
  } catch {
    countOk = false;
  }
  res.json({
    needsSetup: !countOk || userCount === 0,
    userCount: countOk ? userCount : null,
  });
});

// ── Frontend: prioridad al build Vite (dist); public solo como respaldo ──
const distPath = path.join(__dirname, '../dist');
const publicPath = path.join(__dirname, '../public');

if (fs.existsSync(distPath)) {
  console.log(`📡 UI React (Vite build): ${distPath}`);
  const distStaticOpts = IS_PRODUCTION
    ? {
        maxAge: 0,
        etag: true,
        setHeaders(res, absPath) {
          const norm = String(absPath).replace(/\\/g, '/');
          if (norm.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (/\/index\.html$/i.test(norm)) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }
    : {};
  app.use(express.static(distPath, distStaticOpts));
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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Syscom IoT API en http://0.0.0.0:${PORT}`);
  console.log(
    `[Auth] JWT sesión: expiresIn=${JWT_EXPIRES_IN} (SYSCOM_JWT_EXPIRES). Renovación POST /api/auth/refresh con gracia ${Math.round(JWT_REFRESH_GRACE_MS / 86400000)} d (SYSCOM_JWT_REFRESH_GRACE_MS).`
  );
  console.log(
    `📥 Ingesta: …/api/ingest/<userId>/<token>  |  LoRaWAN/Milesight: …/api/lorawan/uplink/… o …/api/milesight/uplink/…`
  );
  console.log(`📊 Widgets dispositivo: GET | PUT | POST /api/devices/:deviceId/dashboard-widgets`);
  console.log(`📁 Base de datos (SQLite): ${store.dbPath()}`);
  try {
    ensureBuiltinCatalogSeeded(store);
    const fleet = reconcileFleetTemplatesOnStartup(store);
    if (fleet.synced > 0) {
      console.log(
        `[Syscom] Flota auto-alineada con plantillas: ${fleet.synced} dispositivo(s) en ${fleet.users} cuenta(s).`
      );
    }
    const poolSync = store.reconcileSuperadminPool();
    if (poolSync.devicesMirrored > 0 || poolSync.gatewaysMirrored > 0) {
      console.log(
        `[Syscom] Pool superadmin (SYSCOM_SUPERADMIN_POOL_MIRROR=1): ${poolSync.devicesMirrored} dispositivo(s) y ${poolSync.gatewaysMirrored} gateway(s) replicados entre cuentas.`
      );
    }
  } catch (e) {
    console.warn('[Syscom] Arranque flota/plantillas:', e.message);
  }
  try {
    const { scheduleDailyDatabaseBackup } = require('./db-backup-scheduler');
    scheduleDailyDatabaseBackup(store);
  } catch (e) {
    console.warn('[Syscom] Programador de respaldos BD:', e.message);
  }
  if (String(process.env.SYSCOM_LICENSE_AUTO_ENFORCE || '').trim() === '1') {
    console.log(
      '[Syscom] Licencias: SYSCOM_LICENSE_AUTO_ENFORCE=1 → se desasignan/borran dispositivos por vencimiento (cada 1 h).'
    );
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
  } else {
    console.log(
      '[Syscom] Licencias: sin mantenimiento destructivo (defecto). Los datos solo se eliminan con acciones manuales o con SYSCOM_LICENSE_AUTO_ENFORCE=1.'
    );
  }
  const retentionPruneHours = Math.min(
    168,
    Math.max(1, parseInt(String(process.env.SYSCOM_TELEMETRY_PRUNE_INTERVAL_HOURS || '').trim(), 10) || 6)
  );
  const runBgMaintenance = (label, withVacuum = false) => {
    try {
      const r = store.runStorageMaintenance({ vacuum: withVacuum });
      if (r.totalDeleted > 0) {
        console.log(
          `[Syscom] Mantenimiento BD (${label}): ${r.totalDeleted} filas (retención ${r.retention.deleted}, gateway ${r.gateways.deleted || 0})${r.vacuumed ? ', VACUUM' : ''}`
        );
        invalidateDevicesListCache();
      }
    } catch (e) {
      console.warn(`[Syscom] Mantenimiento BD (${label}):`, e.message || e);
    }
  };
  setImmediate(() => runBgMaintenance('arranque', false));
  setInterval(() => runBgMaintenance('periódico', false), retentionPruneHours * 60 * 60 * 1000);
  console.log(
    `[Syscom] Mantenimiento BD automático cada ${retentionPruneHours} h: retención sensores ${Math.round(RETENTION_MS / 86400000)} d; gateways conservan últimas ${Math.round((parseInt(String(process.env.SYSCOM_GATEWAY_TELEMETRY_KEEP_MS || '').trim(), 10) || 48 * 60 * 60 * 1000) / 3600000)} h.`
  );
  const { startMqttIngest } = require('./mqtt-ingest');
  startMqttIngest();

  try {
    ensureBuiltinCatalogSeeded(store);
  } catch (e) {
    console.warn('[Syscom] ensureBuiltinCatalogSeeded:', e.message);
  }
  try {
    const eng = getLnsEngine();
    if (eng) {
      console.log('[LNS] Motor MAC LoRaWAN activo (Join OTAA, uplinks cifrados, downlinks).');
      console.log(
        '[Syscom] 24/7: LNS, SQLite y automatizaciones por horario NO dependen de sesión web ni de SSE.'
      );
      console.log('[Syscom] Salud del motor: GET /api/health/platform');
      const txAckOff = String(process.env.SYSCOM_LNS_TX_ACK || '').trim() === '0';
      const appTxAckExplicitOff = String(process.env.SYSCOM_LNS_APP_DOWNLINK_TX_ACK || '').trim() === '0';
      const appTxAckExplicitOn = ['1', 'true', 'on', 'yes'].includes(
        String(process.env.SYSCOM_LNS_APP_DOWNLINK_TX_ACK || '').trim().toLowerCase()
      );
      if (txAckOff || appTxAckExplicitOff) {
        console.log(
          '[LNS] Prueba sin GW_TX_ACK:',
          [
            txAckOff ? 'SYSCOM_LNS_TX_ACK=0' : null,
            appTxAckExplicitOff ? 'SYSCOM_LNS_APP_DOWNLINK_TX_ACK=0' : null,
          ]
            .filter(Boolean)
            .join(' · ')
        );
      }
      if (!appTxAckExplicitOff && !appTxAckExplicitOn) {
        console.log(
          '[LNS] Downlinks de aplicación: sin esperar GW_TX_ACK por defecto (FCnt al encolar). Forzar espera: SYSCOM_LNS_APP_DOWNLINK_TX_ACK=1.'
        );
      }
      if (String(process.env.SYSCOM_LNS_CLASS_C_USE_GATEWAY_TMST || '').trim() === '1') {
        console.log(
          '[LNS] Clase C: txpk por tmst del gateway + SYSCOM_LNS_CLASS_C_TMST_OFFSET_US (SYSCOM_LNS_CLASS_C_USE_GATEWAY_TMST=1).'
        );
      }
    } else {
      console.log('[LNS] Motor MAC desactivado (SYSCOM_LNS_MAC=0): solo ingesta legada sin cifrado LoRaWAN MAC.');
    }
  } catch (e) {
    console.error('[LNS] Error al inicializar motor MAC:', e.message);
  }
  console.log(
    '[Syscom] Producción: use `npm run production` en un host siempre encendido; cerrar sesión web no detiene el motor, pero cerrar la terminal sí.'
  );

  if (LNS_UDP_PORT) {
    const { startSemtechUdpLns } = require('./semtech-udp-lns');
    startSemtechUdpLns({
      port: LNS_UDP_PORT,
      store,
      refreshPullRespJson: (row) => {
        const eng = getLnsEngine();
        if (eng && typeof eng.refreshPullRespJsonBeforeSend === 'function') {
          return eng.refreshPullRespJsonBeforeSend(row);
        }
        return row.json;
      },
      processPushDataJson: (mac, json, userIds) => {
        const eng = getLnsEngine();
        const ids = Array.isArray(userIds) ? userIds.filter(Boolean) : [];
        if (ids.length === 0) return;
        if (eng) {
          let handled = false;
          for (const uid of ids) {
            try {
              if (eng.processPushJson(String(uid), mac, json)) {
                handled = true;
                break;
              }
            } catch (e) {
              console.error('[LNS-UDP] processPushJson user=', uid, e.message);
            }
          }
          if (!handled) {
            try {
              runUplinkPipeline(String(ids[0]), json);
            } catch (e) {
              console.error('[LNS-UDP] runUplinkPipeline:', e.message);
            }
          }
        } else {
          try {
            runUplinkPipeline(String(ids[0]), json);
          } catch (e) {
            console.error('[LNS-UDP] runUplinkPipeline:', e.message);
          }
        }
      },
      onHeartbeat: (mac) => {
        const eui = mac.toString('hex').toUpperCase();
        const { ensureGatewaysAutoRegistered: ensureGw } = require('./lib/auto-fleet-sync.cjs');
        let uids = ensureGw(store, mac);
        const gwProps = { deviceType: 'GATEWAY', status: 'online', gateway_id: eui };
        const ts = Date.now();
        for (const uid of uids) {
          if (store.lastPropertiesJsonEqual(uid, eui, gwProps)) continue;
          store.appendTelemetry(uid, eui, eui, gwProps, ts);
        }
      },
    });
  } else {
    console.log(
      '[LNS-UDP] Escucha Semtech desactivada (LNS_UDP_PORT=0 o SYSCOM_LNS_UDP=0). Uplinks LoRaWAN MAC vía HTTP POST …/api/lorawan/uplink/… o ingesta dedicada.'
    );
  }
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ El puerto ${PORT} ya está en uso (otra ventana con npm start, u otra app).`);
    console.error('   1) Ver PID:  netstat -ano | findstr :' + PORT);
    console.error('   2) Cerrar:   taskkill /PID <número_PID> /F');
    console.error('   3) O otro puerto:  $env:PORT="3003"; npm start\n');
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
