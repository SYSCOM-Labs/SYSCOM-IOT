/**
 * Persistencia SQLite para carga masiva (miles de sensores, muchos usuarios).
 * - Índices por usuario/dispositivo/tiempo
 * - WAL + synchronous NORMAL
 * - Poda de telemetría por antigüedad sin reescribir todo el archivo
 * Migración opcional desde server/db.json (solo con SYSCOM_IMPORT_LEGACY_DB_JSON=1 la primera vez).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DatabaseSync } = require('node:sqlite');
const { telemetryRowHasPropertyKey } = require(path.join(__dirname, 'lib', 'telemetryPropertyPath.js'));
const {
  expandNestedGatewayTelemetry,
  flattenTelemetryProps,
  isMeaningfulTelemetryMergeValue,
} = require(path.join(__dirname, 'lib', 'telemetryPayloadUtils.js'));
const {
  hasDecodedPeopleCountTelemetry,
} = require(path.join(__dirname, 'lib', 'vs133-telemetry-aliases.js'));
const navPerm = require('./navPermissions');
const deviceAssignPerm = require('./lib/device-assignment-permissions.cjs');

/** JSON PULL_RESP de Join-Accept OTAA (`lorawan-lns-engine` marca `_syscomLnsKind`). */
function pullRespJsonIsJoinAccept(raw) {
  if (raw == null || String(raw).trim() === '') return false;
  try {
    const o = JSON.parse(String(raw));
    return Boolean(o && o._syscomLnsKind === 'join_accept');
  } catch {
    return false;
  }
}

const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_SQLITE = path.join(DATA_DIR, 'syscom.db');
const LEGACY_JSON = path.join(__dirname, 'db.json');
const MIGRATE_MARKER = path.join(DATA_DIR, '.migrated-from-json');

/** Vigencia estándar: 1 año desde la fecha de alta (primera fila user_devices). */
const LICENSE_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
/** Tras vencer para admin/usuario, el super admin conserva el dispositivo 30 días más antes del borrado total. */
const LICENSE_SUPERADMIN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** Aviso diario en la app durante los últimos 30 días antes del vencimiento (mensaje con días restantes). */
const LICENSE_WARNING_BEFORE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Convierte `expires_at` / `started_at` de SQLite (ISO o epoch en segundos/ms) a ms UTC.
 * Devuelve NaN si no es parseable (evita purgar por `new Date(null)` o cadenas corruptas).
 */
function parseIsoOrEpochMsToMs(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const s = String(raw).trim();
  if (!s) return NaN;
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return NaN;
    return s.length <= 10 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Tiempo sin GW_TX_ACK antes de liberar `await_tx_ack` (ms).
 * Preferir `SYSCOM_LNS_TX_ACK_TIMEOUT_MS`; si no está definido, `SYSCOM_LNS_TX_ACK_SILENCE_MS`; defecto **5000**.
 */
function readLnsTxAckPruneSilenceMs() {
  for (const key of ['SYSCOM_LNS_TX_ACK_TIMEOUT_MS', 'SYSCOM_LNS_TX_ACK_SILENCE_MS']) {
    const raw = process.env[key];
    if (raw != null && String(raw).trim() !== '') {
      const n = parseInt(String(raw).trim(), 10);
      if (Number.isFinite(n)) return Math.max(3000, n);
    }
  }
  return 5000;
}

/** EUI gateway 16 hex para colas LNS / inflight (minúsculas, sin separadores). */
function normalizeLnsGatewayEuiKey(gw) {
  return String(gw || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function openDb(filePath) {
  ensureDir(path.dirname(filePath));
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** Parámetros con nombre tipo @id → objeto { id: … } */
function prepareBare(db, sql) {
  const s = db.prepare(sql);
  s.setAllowBareNamedParameters(true);
  return s;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT,
      profile_name TEXT,
      created_by TEXT,
      created_by_email TEXT,
      ingest_token TEXT NOT NULL,
      created_at TEXT,
      milesight_ug_json TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT,
      properties_json TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_user_ts ON telemetry(user_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_telemetry_user_device_ts ON telemetry(user_id, device_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON telemetry(device_id, ts DESC);

    CREATE TABLE IF NOT EXISTS device_labels (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      PRIMARY KEY (user_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS lorawan_gateways (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      gateway_eui TEXT NOT NULL,
      frequency_band TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lgw_user ON lorawan_gateways(user_id);

    CREATE TABLE IF NOT EXISTS user_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      dev_eui TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ud_user ON user_devices(user_id);

    CREATE TABLE IF NOT EXISTS automation_rules (
      user_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (user_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS downlink_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      body_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dl_user_created ON downlink_log(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS device_dashboard (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      widgets_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS device_license (
      device_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS report_templates (
      user_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, template_id)
    );
    CREATE INDEX IF NOT EXISTS idx_report_templates_user_updated ON report_templates(user_id, updated_at DESC);
  `);
}

function migrateFromJson(db, jsonPath) {
  if (!fs.existsSync(jsonPath)) return;
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const insertUser = prepareBare(db, `
    INSERT OR REPLACE INTO users (id, email, password, role, profile_name, created_by, created_by_email, ingest_token, created_at, milesight_ug_json, must_change_password)
    VALUES (@id, @email, @password, @role, @profile_name, @created_by, @created_by_email, @ingest_token, @created_at, @milesight_ug_json, @must_change_password)
  `);
  const insertTel = prepareBare(db, `
    INSERT INTO telemetry (user_id, device_id, device_name, properties_json, ts)
    VALUES (@user_id, @device_id, @device_name, @properties_json, @ts)
  `);
  const insertLabel = db.prepare(`
    INSERT OR REPLACE INTO device_labels (user_id, device_id, display_name) VALUES (?, ?, ?)
  `);
  const insertLgw = db.prepare(`
    INSERT OR REPLACE INTO lorawan_gateways (id, user_id, name, gateway_eui, frequency_band, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertUd = db.prepare(`
    INSERT OR REPLACE INTO user_devices (id, user_id, device_id, display_name, dev_eui, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRule = db.prepare(`
    INSERT OR REPLACE INTO automation_rules (user_id, rule_id, payload_json) VALUES (?, ?, ?)
  `);
  const insertDl = db.prepare(`
    INSERT OR REPLACE INTO downlink_log (id, user_id, created_at, body_json) VALUES (?, ?, ?, ?)
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const u of raw.users || []) {
      insertUser.run({
        id: u.id,
        email: u.email,
        password: u.password,
        role: u.role || null,
        profile_name: u.profileName || '',
        created_by: u.createdBy || null,
        created_by_email: u.createdByEmail || null,
        ingest_token: u.ingestToken || crypto.randomBytes(24).toString('hex'),
        created_at: u.createdAt || new Date().toISOString(),
        milesight_ug_json: u.milesightUgGateway ? JSON.stringify(u.milesightUgGateway) : null,
        must_change_password: u.mustChangePassword ? 1 : 0,
      });
    }
    for (const t of raw.telemetry || []) {
      insertTel.run({
        user_id: t.userId,
        device_id: String(t.deviceId),
        device_name: t.deviceName || null,
        properties_json: JSON.stringify(t.properties || {}),
        ts: Number(t.timestamp) || Date.now(),
      });
    }
    for (const l of raw.deviceLabels || []) {
      insertLabel.run(l.userId, String(l.deviceId), l.displayName);
    }
    for (const g of raw.lorawanGateways || []) {
      insertLgw.run(
        g.id,
        g.userId,
        g.name,
        g.gatewayEui,
        g.frequencyBand,
        g.createdAt || new Date().toISOString()
      );
    }
    for (const d of raw.userDevices || []) {
      insertUd.run(
        d.id,
        d.userId,
        String(d.deviceId),
        d.displayName,
        d.devEUI || '',
        d.notes || '',
        d.createdAt || new Date().toISOString(),
        d.updatedAt || d.createdAt || new Date().toISOString()
      );
    }
    for (const r of raw.automationRules || []) {
      const payload = r.payload || {};
      const rid = r.ruleId || payload.id || `${Date.now()}`;
      insertRule.run(r.userId, String(rid), JSON.stringify(payload));
    }
    for (const dl of raw.downlinkLog || []) {
      insertDl.run(
        dl.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        dl.userId,
        dl.createdAt || new Date().toISOString(),
        JSON.stringify(dl)
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  fs.writeFileSync(MIGRATE_MARKER, new Date().toISOString(), 'utf8');
  console.log('[Syscom] Migración desde db.json completada → SQLite:', DEFAULT_SQLITE);
}

function rowToUser(row) {
  if (!row) return null;
  let milesightUgGateway;
  if (row.milesight_ug_json) {
    try {
      milesightUgGateway = JSON.parse(row.milesight_ug_json);
    } catch {
      milesightUgGateway = undefined;
    }
  }
  let eg71Gateway;
  if (row.eg71_gateway_json) {
    try {
      eg71Gateway = JSON.parse(row.eg71_gateway_json);
    } catch {
      eg71Gateway = undefined;
    }
  }
  return {
    id: row.id,
    email: row.email,
    password: row.password,
    role: row.role,
    profileName: row.profile_name || '',
    createdBy: row.created_by,
    createdByEmail: row.created_by_email,
    ingestToken: row.ingest_token,
    createdAt: row.created_at,
    milesightUgGateway,
    eg71Gateway,
    mustChangePassword: Number(row.must_change_password) === 1,
    navPermissionsJson: row.nav_permissions_json != null ? String(row.nav_permissions_json) : null,
  };
}

function clampTelemetrySampleBucketMs(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1000) return 0;
  return Math.min(n, 7 * 86400000);
}

function rowToTelemetryRow(row) {
  let properties = {};
  try {
    properties = JSON.parse(row.properties_json || '{}');
  } catch {
    properties = {};
  }
  return {
    id: String(row.id),
    userId: row.user_id,
    deviceId: row.device_id,
    deviceName: row.device_name || row.device_id,
    properties,
    timestamp: row.ts,
  };
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = openDb(filePath);
    initSchema(this.db);
    this._migrateUserMustChangePassword();
    /** Solo si SYSCOM_IMPORT_LEGACY_DB_JSON=1: migra `server/db.json` una vez (usuarios de demo, telemetría, etc.). Por defecto desactivado para que el primer arranque sea tabla `users` vacía → asistente de superadmin. */
    const importLegacyDbJson = String(process.env.SYSCOM_IMPORT_LEGACY_DB_JSON ?? '').trim() === '1';
    if (importLegacyDbJson && !fs.existsSync(MIGRATE_MARKER) && fs.existsSync(LEGACY_JSON)) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM users').get();
      const n = Number(row && row.c);
      if (n === 0) migrateFromJson(this.db, LEGACY_JSON);
    }
    this._migrateDeviceSchema();
    this._migrateLnsSchema();
    this._migrateServerSettings();
    this._migrateEg71GatewayColumn();
    this._migrateNavPermissions();
    this._prepareStatements();
    this._migrateRoles();
    this._pruneCounter = 0;
    this.retentionMs = 365 * 24 * 60 * 60 * 1000;
    /** @type {null | function({ userIds: string[], deviceId: string, deviceName: string|null, ts: number }): void} */
    this._telemetryBroadcastHook = null;
    /** @type {null | function({ userIds: string[], deviceId: string, deviceName: string|null, ts: number, properties: object }): void} */
    this._automationTelemetryHook = null;
    /** @type {null | function({ gatewayEui: string, error: string, devEui?: string|null, userId?: string|null, orphan: boolean }): void} */
    this._lnsGatewayTxFailHook = null;
    /** @type {null | function({ userId: string, devEui: string, ok: boolean, error?: string|null, fCnt?: number|null, gatewayEui?: string|null, timeout?: boolean }): void} */
    this._lnsTxAckOutcomeHook = null;
    /** @type {Map<string, number>} */
    this._orphanAckRetryAt = new Map();
    /** @type {Map<string, number>} */
    this._orphanAckRetryCount = new Map();
    /** Gateways que deben usar `imme` en clase C tras TOO_EARLY/TOO_LATE (UG65 saturado). */
    this._gwForceClassCImme = new Set();
    /** @type {Map<string, { at: number, data: object[] }>} */
    this._telemetrySeriesCache = new Map();
  }

  /**
   * Opcional: invocado al final de appendTelemetry (p. ej. SSE). Evita import circular store → server.
   * @param {null | function({ userIds: string[], deviceId: string, deviceName: string|null, ts: number })} fn
   */
  setTelemetryBroadcastHook(fn) {
    this._telemetryBroadcastHook = typeof fn === 'function' ? fn : null;
  }

  /**
   * Tras persistir telemetría (p. ej. motor de automatización en servidor).
   * @param {null | function({ userIds: string[], deviceId: string, deviceName: string|null, ts: number, properties: object })} fn
   */
  setAutomationTelemetryHook(fn) {
    this._automationTelemetryHook = typeof fn === 'function' ? fn : null;
  }

  /**
   * GW_TX_ACK con error (p. ej. TX_FREQ, TOO_LATE). Sin esto, downlinks app sin `track_tx_ack` fallan en el GW sin rastro en UI.
   * @param {null | function({ gatewayEui: string, error: string, devEui?: string|null, userId?: string|null, orphan: boolean })} fn
   */
  setLnsGatewayTxFailHook(fn) {
    this._lnsGatewayTxFailHook = typeof fn === 'function' ? fn : null;
  }

  /**
   * Tras GW_TX_ACK (éxito/error), o al liberar por timeout sin ACK (gateways que no envían `txpk_ack`).
   * El servidor suele registrar aquí `insertUiEventWithStream` → SSE `downlink_gateway_ack`.
   */
  setLnsTxAckOutcomeHook(fn) {
    this._lnsTxAckOutcomeHook = typeof fn === 'function' ? fn : null;
  }

  _emitLnsTxAckOutcome(payload) {
    if (typeof this._lnsTxAckOutcomeHook !== 'function') return;
    try {
      this._lnsTxAckOutcomeHook(payload);
    } catch (e) {
      console.warn('[store] _lnsTxAckOutcomeHook:', e.message);
    }
  }

  _migrateDeviceSchema() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS device_decode_config (
          device_id TEXT PRIMARY KEY,
          decoder_script TEXT,
          channel TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      const decodeCols = this.db.prepare('PRAGMA table_info(device_decode_config)').all();
      const decodeNames = new Set(decodeCols.map((c) => c.name));
      if (!decodeNames.has('lorawan_class')) {
        this.db.exec('ALTER TABLE device_decode_config ADD COLUMN lorawan_class TEXT');
      }
      if (!decodeNames.has('product_model')) {
        this.db.exec('ALTER TABLE device_decode_config ADD COLUMN product_model TEXT');
      }
      const cols = this.db.prepare('PRAGMA table_info(user_devices)').all();
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('app_eui')) this.db.exec('ALTER TABLE user_devices ADD COLUMN app_eui TEXT');
      if (!names.has('app_key')) this.db.exec('ALTER TABLE user_devices ADD COLUMN app_key TEXT');
      if (!names.has('tag')) this.db.exec('ALTER TABLE user_devices ADD COLUMN tag TEXT');
      if (!names.has('lorawan_class')) this.db.exec(`ALTER TABLE user_devices ADD COLUMN lorawan_class TEXT`);
      if (!names.has('device_serial_hex'))
        this.db.exec('ALTER TABLE user_devices ADD COLUMN device_serial_hex TEXT');
      if (!names.has('product_model')) this.db.exec('ALTER TABLE user_devices ADD COLUMN product_model TEXT');
      if (!names.has('assignment_permissions_json')) {
        this.db.exec('ALTER TABLE user_devices ADD COLUMN assignment_permissions_json TEXT');
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS device_license (
          device_id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this._backfillDeviceLicenses();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS device_bsd_preferences (
          user_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          prefs_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, device_id)
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS user_panel_bsd_preferences (
          user_id TEXT NOT NULL,
          segment TEXT NOT NULL DEFAULT '',
          panel_id TEXT NOT NULL DEFAULT 'main',
          prefs_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, segment, panel_id)
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS device_shared_presets (
          device_id TEXT PRIMARY KEY,
          body_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS report_templates (
          user_id TEXT NOT NULL,
          template_id TEXT NOT NULL,
          name TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, template_id)
        );
        CREATE INDEX IF NOT EXISTS idx_report_templates_user_updated ON report_templates(user_id, updated_at DESC);
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS device_latest (
          device_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          device_name TEXT,
          properties_json TEXT NOT NULL,
          ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_device_latest_ts ON device_latest(ts DESC);
        CREATE INDEX IF NOT EXISTS idx_device_latest_user ON device_latest(user_id);
      `);
    } catch (e) {
      console.warn('[Syscom] Migración device schema:', e.message);
    }
  }

  _migrateLnsSchema() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lorawan_lns_sessions (
          user_id TEXT NOT NULL,
          dev_eui TEXT NOT NULL,
          dev_addr TEXT NOT NULL,
          nwk_s_key TEXT NOT NULL,
          app_s_key TEXT NOT NULL,
          fcnt_up INTEGER NOT NULL DEFAULT -1,
          fcnt_down INTEGER NOT NULL DEFAULT -1,
          last_gateway_eui TEXT,
          last_rx_tmst INTEGER,
          last_rx_freq REAL,
          last_rx_datr TEXT,
          last_rx_codr TEXT,
          last_rx_rfch INTEGER,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, dev_eui)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_lns_user_devaddr ON lorawan_lns_sessions(user_id, dev_addr);
        CREATE TABLE IF NOT EXISTS lorawan_lns_downlink (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          gateway_eui TEXT NOT NULL,
          pull_resp_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lns_dl_gw ON lorawan_lns_downlink(gateway_eui, status, created_at);
      `);
    } catch (e) {
      console.warn('[Syscom] Migración LNS:', e.message);
    }
    this._migrateLnsExtraColumns();
  }

  _migrateUserMustChangePassword() {
    try {
      const cols = this.db.prepare('PRAGMA table_info(users)').all();
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('must_change_password')) {
        this.db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
      }
    } catch (e) {
      console.warn('[Syscom] Migración must_change_password:', e.message);
    }
  }

  _migrateServerSettings() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS server_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );
      `);
    } catch (e) {
      console.warn('[Syscom] Migración server_settings:', e.message);
    }
  }

  _migrateEg71GatewayColumn() {
    try {
      const cols = this.db.prepare('PRAGMA table_info(users)').all();
      if (!cols.some((c) => c.name === 'eg71_gateway_json')) {
        this.db.exec('ALTER TABLE users ADD COLUMN eg71_gateway_json TEXT');
      }
    } catch (e) {
      console.warn('[Syscom] Migración eg71_gateway_json:', e.message);
    }
  }

  _migrateLnsExtraColumns() {
    const add = (sql) => {
      try {
        this.db.exec(sql);
      } catch (e) {
        if (!String(e.message || '').includes('duplicate column')) {
          console.warn('[Syscom] LNS column:', e.message);
        }
      }
    };
    add(`ALTER TABLE lorawan_lns_sessions ADD COLUMN device_class TEXT DEFAULT 'A'`);
    add('ALTER TABLE lorawan_lns_sessions ADD COLUMN last_uplink_wall_ms INTEGER');
    add('ALTER TABLE lorawan_lns_sessions ADD COLUMN class_b_ping_periodicity INTEGER DEFAULT -1');
    add('ALTER TABLE lorawan_lns_sessions ADD COLUMN class_b_data_rate INTEGER');
    add('ALTER TABLE lorawan_lns_downlink ADD COLUMN not_before_ms INTEGER NOT NULL DEFAULT 0');
    add('ALTER TABLE lorawan_lns_sessions ADD COLUMN rx_delay_sec INTEGER NOT NULL DEFAULT 1');
    add('ALTER TABLE lorawan_lns_sessions ADD COLUMN pending_mac_ack INTEGER NOT NULL DEFAULT 0');
    add('ALTER TABLE lorawan_lns_downlink ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
    add('ALTER TABLE lorawan_lns_downlink ADD COLUMN track_tx_ack INTEGER NOT NULL DEFAULT 0');
    add('ALTER TABLE lorawan_lns_downlink ADD COLUMN tx_dev_eui TEXT');
    add('ALTER TABLE lorawan_lns_downlink ADD COLUMN tx_new_fcnt INTEGER');
    add('ALTER TABLE lorawan_lns_downlink ADD COLUMN tx_prev_fcnt INTEGER');
    add('ALTER TABLE lorawan_lns_downlink ADD COLUMN tx_retries_left INTEGER');
    add('ALTER TABLE lorawan_lns_downlink ADD COLUMN is_confirmed_down INTEGER NOT NULL DEFAULT 0');
    add('ALTER TABLE lorawan_lns_downlink ADD COLUMN join_session_json TEXT');
    add('ALTER TABLE lorawan_lns_sessions ADD COLUMN awaiting_confirmed_dl_ack INTEGER NOT NULL DEFAULT 0');
    this._migrateLnsTxInflightTable();
    this._migrateLnsUiEventsTable();
    this._migrateLnsDeferredAppDownlinkTable();
    this._migrateLnsIntegrationTokenTable();
  }

  /** Downlinks de aplicación diferidos hasta próximo uplink (clase A sin ventana, sin tmst, etc.). */
  _migrateLnsDeferredAppDownlinkTable() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lorawan_lns_deferred_app_dl (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          dev_eui TEXT NOT NULL,
          f_port INTEGER NOT NULL,
          payload_hex TEXT NOT NULL,
          confirmed INTEGER NOT NULL DEFAULT 0,
          priority INTEGER NOT NULL DEFAULT 0,
          delay_ms INTEGER NOT NULL DEFAULT 0,
          gateway_eui TEXT NOT NULL DEFAULT '',
          device_class TEXT NOT NULL DEFAULT 'A',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lns_def_dl_user_dev ON lorawan_lns_deferred_app_dl(user_id, dev_eui, id);
      `);
    } catch (e) {
      console.warn('[Syscom] Migración LNS deferred app dl:', e.message);
    }
  }

  _migrateLnsIntegrationTokenTable() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lns_integration_token (
          jti TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          label TEXT,
          created_at INTEGER NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_lns_int_tok_user ON lns_integration_token(user_id, created_at);
      `);
    } catch (e) {
      console.warn('[Syscom] LNS integration_token:', e.message);
    }
  }

  _migrateLnsUiEventsTable() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lns_ui_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          dev_eui TEXT NOT NULL,
          event_type TEXT NOT NULL,
          meta_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lns_ui_ev_user_time ON lns_ui_events(user_id, created_at);
      `);
    } catch (e) {
      console.warn('[Syscom] LNS ui_events:', e.message);
    }
  }

  _migrateLnsTxInflightTable() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lorawan_lns_tx_inflight (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          gateway_eui TEXT NOT NULL,
          token_h INTEGER NOT NULL,
          token_l INTEGER NOT NULL,
          downlink_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lns_tx_inflight_gw_tok ON lorawan_lns_tx_inflight(gateway_eui, token_h, token_l, id);
      `);
    } catch (e) {
      console.warn('[Syscom] LNS tx_inflight table:', e.message);
    }
  }

  /** Licencia 1 año desde alta; dispositivos sin fila reciben una desde la primera fecha user_devices. */
  _backfillDeviceLicenses() {
    const has = this.db.prepare('SELECT 1 FROM device_license WHERE device_id = ? LIMIT 1');
    const ins = this.db.prepare(`
      INSERT OR IGNORE INTO device_license (device_id, started_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const rows = this.db.prepare(
      'SELECT device_id, MIN(created_at) AS first_at FROM user_devices GROUP BY device_id'
    ).all();
    const nowIso = new Date().toISOString();
    for (const r of rows) {
      if (has.get(r.device_id)) continue;
      const minStr = r.first_at != null ? String(r.first_at).trim() : '';
      let startMs = parseIsoOrEpochMsToMs(minStr);
      if (!Number.isFinite(startMs)) startMs = Date.now();
      const twentyYearsMs = 20 * 365 * 24 * 60 * 60 * 1000;
      if (startMs < Date.now() - twentyYearsMs) startMs = Date.now();
      let expMs = startMs + LICENSE_DURATION_MS;
      if (expMs <= Date.now()) {
        startMs = Date.now();
        expMs = startMs + LICENSE_DURATION_MS;
      }
      const startIso = new Date(startMs).toISOString();
      const expIso = new Date(expMs).toISOString();
      ins.run(r.device_id, startIso, expIso, nowIso);
    }
  }

  _migrateRoles() {
    /** `admin` y `viewer` se normalizan en `_migrateNavPermissions` tras rellenar permisos. */
  }

  _migrateNavPermissions() {
    try {
      const cols = this.db.prepare('PRAGMA table_info(users)').all();
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('nav_permissions_json')) {
        this.db.exec('ALTER TABLE users ADD COLUMN nav_permissions_json TEXT');
      }
    } catch (e) {
      console.warn('[store] nav_permissions_json column:', e.message);
    }
    try {
      const rows = this.db.prepare('SELECT id, role, nav_permissions_json FROM users').all();
      const upd = this.db.prepare('UPDATE users SET nav_permissions_json = ? WHERE id = ?');
      for (const r of rows) {
        const raw = r.nav_permissions_json != null ? String(r.nav_permissions_json).trim() : '';
        if (raw !== '' && raw !== '{}') continue;
        const role = r.role != null ? String(r.role) : 'user';
        let obj;
        if (role === 'superadmin' || role === 'demo') obj = navPerm.allNavTrue();
        else if (role === 'admin') obj = navPerm.defaultNavLegacyAdmin();
        else obj = navPerm.defaultNavLegacyUser();
        upd.run(navPerm.navToJson(obj), r.id);
      }
      this.db.exec(`UPDATE users SET role = 'user' WHERE role = 'admin' OR role = 'viewer'`);
    } catch (e) {
      console.warn('[store] _migrateNavPermissions:', e.message);
    }
  }

  _prepareStatements() {
    this.st = {
      userByEmail: this.db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)'),
      userById: this.db.prepare('SELECT * FROM users WHERE id = ?'),
      usersByCreator: this.db.prepare('SELECT * FROM users WHERE created_by = ?'),
      allUsers: this.db.prepare('SELECT * FROM users'),
      usersSuperadminIds: this.db.prepare(
        `SELECT id FROM users WHERE lower(trim(COALESCE(role, ''))) = 'superadmin'`
      ),
      insertUser: prepareBare(this.db, `
        INSERT INTO users (id, email, password, role, profile_name, created_by, created_by_email, ingest_token, created_at, milesight_ug_json, eg71_gateway_json, must_change_password, nav_permissions_json)
        VALUES (@id, @email, @password, @role, @profile_name, @created_by, @created_by_email, @ingest_token, @created_at, @milesight_ug_json, @eg71_gateway_json, @must_change_password, @nav_permissions_json)
      `),
      updateUserFull: prepareBare(this.db, `
        UPDATE users SET email=@email, password=@password, role=@role, profile_name=@profile_name,
          created_by=@created_by, created_by_email=@created_by_email, ingest_token=@ingest_token, created_at=@created_at, milesight_ug_json=@milesight_ug_json,
          eg71_gateway_json=@eg71_gateway_json,
          must_change_password=@must_change_password, nav_permissions_json=@nav_permissions_json
        WHERE id=@id
      `),
      deleteUser: this.db.prepare('DELETE FROM users WHERE id = ?'),
      insertTelemetry: prepareBare(this.db, `
        INSERT INTO telemetry (user_id, device_id, device_name, properties_json, ts)
        VALUES (@user_id, @device_id, @device_name, @properties_json, @ts)
      `),
      pruneTelemetry: this.db.prepare('DELETE FROM telemetry WHERE ts < ?'),
      pruneTelemetryChunk: this.db.prepare(
        'DELETE FROM telemetry WHERE id IN (SELECT id FROM telemetry WHERE ts < ? LIMIT 1500)'
      ),
      pruneGatewayTelemetryChunk: this.db.prepare(
        `DELETE FROM telemetry WHERE id IN (
           SELECT id FROM telemetry WHERE device_id LIKE 'gateway-%' AND ts < ? LIMIT 1500
         )`
      ),
      latestByUser: this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM (
          SELECT id, user_id, device_id, device_name, properties_json, ts,
            ROW_NUMBER() OVER (PARTITION BY user_id, device_id ORDER BY ts DESC, id DESC) AS rn
          FROM telemetry WHERE user_id = ?
        ) WHERE rn = 1
      `),
      telemetryRecentForUser: this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM telemetry
        WHERE user_id = ? AND ts >= ?
        ORDER BY ts DESC
        LIMIT ?
      `),
      telemetryForResolve: this.db.prepare(`
        SELECT device_id, device_name, properties_json, ts FROM telemetry
        WHERE user_id = ? ORDER BY ts DESC LIMIT ?
      `),
      latestForDevice: this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM telemetry
        WHERE user_id = ? AND device_id = ?
        ORDER BY ts DESC, id DESC LIMIT 1
      `),
      latestForDeviceAny: this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM telemetry
        WHERE device_id = ?
        ORDER BY ts DESC, id DESC LIMIT 1
      `),
      getDeviceLatest: this.db.prepare(`
        SELECT device_id, user_id, device_name, properties_json, ts FROM device_latest WHERE device_id = ?
      `),
      upsertDeviceLatest: prepareBare(this.db, `
        INSERT INTO device_latest (device_id, user_id, device_name, properties_json, ts)
        VALUES (@device_id, @user_id, @device_name, @properties_json, @ts)
        ON CONFLICT(device_id) DO UPDATE SET
          user_id = excluded.user_id,
          device_name = excluded.device_name,
          properties_json = excluded.properties_json,
          ts = excluded.ts
        WHERE excluded.ts >= device_latest.ts
      `),
      telemetryHistory: this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM telemetry
        WHERE user_id = ? AND device_id = ? AND ts >= ? AND ts <= ?
        ORDER BY ts DESC
        LIMIT ?
      `),
      telemetryHistoryMergedBatch: this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM (
          SELECT id, user_id, device_id, device_name, properties_json, ts,
            ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY ts DESC, id DESC) AS rn
          FROM telemetry
          WHERE user_id = ? AND ts >= ? AND ts <= ?
        ) WHERE rn <= ?
      `),
      telemetryRange: this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM telemetry
        WHERE user_id = ? AND device_id = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
      `),
      lastTelemetrySameProps: this.db.prepare(`
        SELECT properties_json, ts FROM telemetry
        WHERE user_id = ? AND device_id = ?
        ORDER BY ts DESC, id DESC LIMIT 1
      `),
      deleteDeviceLatest: this.db.prepare('DELETE FROM device_latest WHERE device_id = ?'),
      updateTelemetryTs: prepareBare(this.db, `
        UPDATE telemetry SET ts = @ts WHERE id = @id
      `),
      labelsForUser: this.db.prepare('SELECT * FROM device_labels WHERE user_id = ?'),
      upsertLabel: this.db.prepare(`
        INSERT INTO device_labels (user_id, device_id, display_name) VALUES (?, ?, ?)
        ON CONFLICT(user_id, device_id) DO UPDATE SET display_name = excluded.display_name
      `),
      lgwList: this.db.prepare('SELECT * FROM lorawan_gateways WHERE user_id = ?'),
      lgwInsert: this.db.prepare(`
        INSERT INTO lorawan_gateways (id, user_id, name, gateway_eui, frequency_band, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      lgwDelete: this.db.prepare('DELETE FROM lorawan_gateways WHERE id = ? AND user_id = ?'),
      lgwGetById: this.db.prepare('SELECT * FROM lorawan_gateways WHERE id = ?'),
      lgwUpdate: this.db.prepare(`
        UPDATE lorawan_gateways SET name = ?, gateway_eui = ?, frequency_band = ?
        WHERE id = ?
      `),
      lgwExistsGloballyExceptId: this.db.prepare(`
        SELECT 1 FROM lorawan_gateways
        WHERE lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) = ?
          AND id != ?
        LIMIT 1
      `),
      lgwDeleteAllForUser: this.db.prepare('DELETE FROM lorawan_gateways WHERE user_id = ?'),
      lgwExists: this.db.prepare(
        'SELECT 1 FROM lorawan_gateways WHERE user_id = ? AND lower(gateway_eui) = lower(?)'
      ),
      lgwExistsGlobally: this.db.prepare(`
        SELECT 1 FROM lorawan_gateways
        WHERE lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) = ?
        LIMIT 1
      `),
      lgwEuiForMac: this.db.prepare(`
        SELECT gateway_eui FROM lorawan_gateways WHERE user_id = ?
        AND lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) IN (?, ?) LIMIT 1
      `),
      lgwGetByEui: this.db.prepare(`
        SELECT * FROM lorawan_gateways WHERE user_id = ? AND lower(gateway_eui) = lower(?) LIMIT 1
      `),
      lnsOtaaDevice: this.db.prepare(`
        SELECT * FROM user_devices WHERE user_id = ?
        AND lower(replace(replace(replace(dev_eui,':',''),'-',''),' ','')) = ?
        AND lower(replace(replace(replace(app_eui,':',''),'-',''),' ','')) = ?
        AND app_key IS NOT NULL AND length(trim(app_key)) = 32
        LIMIT 1
      `),
      lnsOtaaDeviceByDevEuiOnly: this.db.prepare(`
        SELECT * FROM user_devices WHERE user_id = ?
        AND lower(replace(replace(replace(dev_eui,':',''),'-',''),' ','')) = ?
        AND app_key IS NOT NULL AND length(trim(app_key)) = 32
        LIMIT 1
      `),
      /** Alta con device_id = DevEUI pero dev_eui vacío en columna (OTAA por identificador). */
      lnsOtaaDeviceByDeviceIdAsDevEui: this.db.prepare(`
        SELECT * FROM user_devices WHERE user_id = ?
        AND lower(replace(replace(replace(device_id,':',''),'-',''),' ','')) = ?
        AND app_key IS NOT NULL AND length(trim(app_key)) = 32
        LIMIT 1
      `),
      /** OTAA en cualquier cuenta (gateway compartido ≠ dueño del dispositivo). */
      lnsOtaaDeviceGlobal: this.db.prepare(`
        SELECT * FROM user_devices
        WHERE lower(replace(replace(replace(dev_eui,':',''),'-',''),' ','')) = ?
        AND lower(replace(replace(replace(app_eui,':',''),'-',''),' ','')) = ?
        AND app_key IS NOT NULL AND length(trim(app_key)) = 32
        LIMIT 1
      `),
      lnsOtaaDeviceGlobalByDevEuiOnly: this.db.prepare(`
        SELECT * FROM user_devices
        WHERE lower(replace(replace(replace(dev_eui,':',''),'-',''),' ','')) = ?
        AND app_key IS NOT NULL AND length(trim(app_key)) = 32
        LIMIT 1
      `),
      lnsOtaaDeviceGlobalByDeviceIdAsDevEui: this.db.prepare(`
        SELECT * FROM user_devices
        WHERE lower(replace(replace(replace(device_id,':',''),'-',''),' ','')) = ?
        AND app_key IS NOT NULL AND length(trim(app_key)) = 32
        LIMIT 1
      `),
      lnsSessionByDevEui: this.db.prepare('SELECT * FROM lorawan_lns_sessions WHERE user_id = ? AND dev_eui = ?'),
      lnsSessionByDevAddr: this.db.prepare('SELECT * FROM lorawan_lns_sessions WHERE user_id = ? AND dev_addr = ?'),
      lnsSessionByDevAddrGlobal: this.db.prepare(`
        SELECT * FROM lorawan_lns_sessions
        WHERE upper(replace(replace(dev_addr,':',''),'-','')) = ?
        LIMIT 1
      `),
      lgwGetByEuiGlobal: this.db.prepare(`
        SELECT * FROM lorawan_gateways
        WHERE lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) = ?
        LIMIT 1
      `),
      lnsSessionDeleteByDevEui: this.db.prepare('DELETE FROM lorawan_lns_sessions WHERE user_id = ? AND dev_eui = ?'),
      lnsUpsertSession: this.db.prepare(`
        INSERT INTO lorawan_lns_sessions (
          user_id, dev_eui, dev_addr, nwk_s_key, app_s_key, fcnt_up, fcnt_down,
          last_gateway_eui, last_rx_tmst, last_rx_freq, last_rx_datr, last_rx_codr, last_rx_rfch,
          device_class, last_uplink_wall_ms, class_b_ping_periodicity, class_b_data_rate,
          rx_delay_sec, pending_mac_ack, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, dev_eui) DO UPDATE SET
          dev_addr = excluded.dev_addr,
          nwk_s_key = excluded.nwk_s_key,
          app_s_key = excluded.app_s_key,
          fcnt_up = excluded.fcnt_up,
          fcnt_down = excluded.fcnt_down,
          last_gateway_eui = excluded.last_gateway_eui,
          last_rx_tmst = excluded.last_rx_tmst,
          last_rx_freq = excluded.last_rx_freq,
          last_rx_datr = excluded.last_rx_datr,
          last_rx_codr = excluded.last_rx_codr,
          last_rx_rfch = excluded.last_rx_rfch,
          device_class = excluded.device_class,
          last_uplink_wall_ms = excluded.last_uplink_wall_ms,
          class_b_ping_periodicity = excluded.class_b_ping_periodicity,
          class_b_data_rate = excluded.class_b_data_rate,
          rx_delay_sec = excluded.rx_delay_sec,
          pending_mac_ack = excluded.pending_mac_ack,
          updated_at = excluded.updated_at
      `),
      lnsUpdateSessionRx: this.db.prepare(`
        UPDATE lorawan_lns_sessions SET
          fcnt_up = ?, last_gateway_eui = ?, last_rx_tmst = ?, last_rx_freq = ?,
          last_rx_datr = ?, last_rx_codr = ?, last_rx_rfch = ?, last_uplink_wall_ms = ?,
          pending_mac_ack = ?, updated_at = ?
        WHERE user_id = ? AND dev_eui = ?
      `),
      lnsPatchClassBMac: this.db.prepare(`
        UPDATE lorawan_lns_sessions SET class_b_ping_periodicity = ?, class_b_data_rate = ?, updated_at = ?
        WHERE user_id = ? AND dev_eui = ?
      `),
      lnsSetDeviceClass: this.db.prepare(`
        UPDATE lorawan_lns_sessions SET device_class = ?, updated_at = ?
        WHERE user_id = ? AND dev_eui = ?
      `),
      lnsUpdateFcntDown: this.db.prepare(
        'UPDATE lorawan_lns_sessions SET fcnt_down = ?, updated_at = ? WHERE user_id = ? AND dev_eui = ?'
      ),
      lnsSetAwaitingConfirmedDl: this.db.prepare(`
        UPDATE lorawan_lns_sessions SET awaiting_confirmed_dl_ack = 1, updated_at = ? WHERE user_id = ? AND dev_eui = ?
      `),
      lnsClearAwaitingConfirmedDl: this.db.prepare(`
        UPDATE lorawan_lns_sessions SET awaiting_confirmed_dl_ack = 0, updated_at = ? WHERE user_id = ? AND dev_eui = ?
      `),
      lnsUiEventInsert: this.db.prepare(`
        INSERT INTO lns_ui_events (user_id, dev_eui, event_type, meta_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      lnsUiEventListSince: this.db.prepare(`
        SELECT id, dev_eui, event_type, meta_json, created_at FROM lns_ui_events
        WHERE user_id = ? AND created_at > ? ORDER BY id ASC LIMIT 100
      `),
      lnsUiEventListAfterId: this.db.prepare(`
        SELECT id, dev_eui, event_type, meta_json, created_at FROM lns_ui_events
        WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 100
      `),
      lnsDevAddrTaken: this.db.prepare(
        'SELECT 1 FROM lorawan_lns_sessions WHERE user_id = ? AND dev_addr = ? LIMIT 1'
      ),
      lnsIntTokInsert: this.db.prepare(`
        INSERT INTO lns_integration_token (jti, user_id, label, created_at, revoked)
        VALUES (?, ?, ?, ?, 0)
      `),
      lnsIntTokRevoke: this.db.prepare(
        'UPDATE lns_integration_token SET revoked = 1 WHERE user_id = ? AND jti = ? AND revoked = 0'
      ),
      lnsIntTokIsActive: this.db.prepare(`
        SELECT 1 AS x FROM lns_integration_token
        WHERE user_id = ? AND jti = ? AND revoked = 0 LIMIT 1
      `),
      lnsIntTokList: this.db.prepare(`
        SELECT jti, label, created_at, revoked FROM lns_integration_token
        WHERE user_id = ? ORDER BY created_at DESC
      `),
      lnsDlInsert: this.db.prepare(`
        INSERT INTO lorawan_lns_downlink (
          user_id, gateway_eui, pull_resp_json, status, created_at, not_before_ms, priority,
          track_tx_ack, tx_dev_eui, tx_new_fcnt, tx_prev_fcnt, tx_retries_left, is_confirmed_down,
          join_session_json
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      lnsDlDequeue: this.db.prepare(`
        SELECT id, user_id, gateway_eui, pull_resp_json, track_tx_ack, tx_dev_eui, tx_new_fcnt, tx_prev_fcnt, tx_retries_left, priority, not_before_ms,
          join_session_json
        FROM lorawan_lns_downlink
        WHERE lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) = ?
          AND status = 'pending' AND not_before_ms <= ?
        ORDER BY priority DESC, created_at ASC LIMIT 1
      `),
      lnsDlSent: this.db.prepare('UPDATE lorawan_lns_downlink SET status = ? WHERE id = ?'),
      lnsDlAwaitTxAck: this.db.prepare(`UPDATE lorawan_lns_downlink SET status = 'await_tx_ack' WHERE id = ?`),
      lnsDlDeleteById: this.db.prepare('DELETE FROM lorawan_lns_downlink WHERE id = ?'),
      lnsDlCancelPendingJoinForDev: this.db.prepare(`
        DELETE FROM lorawan_lns_downlink
        WHERE user_id = ? AND status = 'pending'
        AND lower(replace(replace(replace(tx_dev_eui,':',''),'-',''),' ','')) = ?
        AND (priority >= 255 OR (join_session_json IS NOT NULL AND trim(join_session_json) != ''))
      `),
      lnsTxInflightInsert: this.db.prepare(`
        INSERT INTO lorawan_lns_tx_inflight (gateway_eui, token_h, token_l, downlink_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      lnsTxInflightSelectJoin: this.db.prepare(`
        SELECT i.id AS inflight_id, d.id AS downlink_id, d.user_id, d.gateway_eui, d.pull_resp_json,
          d.tx_dev_eui, d.tx_new_fcnt, d.tx_prev_fcnt, d.tx_retries_left, d.priority, d.track_tx_ack,
          d.is_confirmed_down, d.join_session_json
        FROM lorawan_lns_tx_inflight i
        INNER JOIN lorawan_lns_downlink d ON d.id = i.downlink_id
        WHERE lower(replace(replace(replace(i.gateway_eui,':',''),'-',''),' ','')) = ?
          AND i.token_h = ? AND i.token_l = ?
        ORDER BY i.id ASC LIMIT 1
      `),
      lnsTxInflightSelectLatestAwaitAppByGw: this.db.prepare(`
        SELECT i.id AS inflight_id, d.id AS downlink_id, d.user_id, d.gateway_eui, d.pull_resp_json,
          d.tx_dev_eui, d.tx_new_fcnt, d.tx_prev_fcnt, d.tx_retries_left, d.priority, d.track_tx_ack,
          d.is_confirmed_down, d.join_session_json
        FROM lorawan_lns_tx_inflight i
        INNER JOIN lorawan_lns_downlink d ON d.id = i.downlink_id
        WHERE lower(replace(replace(replace(i.gateway_eui,':',''),'-',''),' ','')) = ?
          AND d.track_tx_ack = 1 AND d.status = 'await_tx_ack'
          AND (d.join_session_json IS NULL OR trim(d.join_session_json) = '')
        ORDER BY i.id DESC LIMIT 1
      `),
      lnsTxInflightDelete: this.db.prepare('DELETE FROM lorawan_lns_tx_inflight WHERE id = ?'),
      /** Solo downlinks de aplicación (mismo criterio que la purga previa a encolar). Excluye Join-Accept diferido (`join_session_json`). */
      lnsHasTrackedDlForDev: this.db.prepare(`
        SELECT 1 FROM lorawan_lns_downlink
        WHERE user_id = ?
          AND lower(replace(replace(replace(ifnull(tx_dev_eui,''),':',''),'-',''),' ','')) = ?
          AND track_tx_ack = 1 AND status IN ('pending', 'await_tx_ack')
          AND (join_session_json IS NULL OR trim(join_session_json) = '')
        LIMIT 1
      `),
      lnsDefDlCount: this.db.prepare(`
        SELECT COUNT(*) AS n FROM lorawan_lns_deferred_app_dl
        WHERE user_id = ? AND dev_eui = ?
      `),
      lnsDefDlInsert: this.db.prepare(`
        INSERT INTO lorawan_lns_deferred_app_dl (
          user_id, dev_eui, f_port, payload_hex, confirmed, priority, delay_ms, gateway_eui, device_class, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      lnsDefDlPeekOldest: this.db.prepare(`
        SELECT id, user_id, dev_eui, f_port, payload_hex, confirmed, priority, delay_ms, gateway_eui, device_class, created_at
        FROM lorawan_lns_deferred_app_dl
        WHERE user_id = ? AND dev_eui = ?
        ORDER BY id ASC LIMIT 1
      `),
      lnsDefDlDeleteById: this.db.prepare('DELETE FROM lorawan_lns_deferred_app_dl WHERE id = ?'),
      lnsDefDlDeleteForDev: this.db.prepare(
        'DELETE FROM lorawan_lns_deferred_app_dl WHERE user_id = ? AND dev_eui = ?'
      ),
      lnsDefDlPruneOldForDev: this.db.prepare(
        'DELETE FROM lorawan_lns_deferred_app_dl WHERE user_id = ? AND dev_eui = ? AND created_at < ?'
      ),
      udList: this.db.prepare('SELECT * FROM user_devices WHERE user_id = ?'),
      udGet: this.db.prepare('SELECT * FROM user_devices WHERE user_id = ? AND device_id = ?'),
      udGetByUserDevEuiNorm: this.db.prepare(`
        SELECT * FROM user_devices
        WHERE user_id = ? AND lower(replace(replace(replace(dev_eui,':',''),'-',''),' ','')) = ?
        LIMIT 1
      `),
      udUpsert: this.db.prepare(`
        INSERT INTO user_devices (id, user_id, device_id, display_name, dev_eui, notes, app_eui, app_key, tag, product_model, lorawan_class, device_serial_hex, created_at, updated_at, assignment_permissions_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, device_id) DO UPDATE SET
          display_name = excluded.display_name,
          dev_eui = excluded.dev_eui,
          notes = excluded.notes,
          app_eui = excluded.app_eui,
          app_key = excluded.app_key,
          tag = excluded.tag,
          product_model = excluded.product_model,
          lorawan_class = excluded.lorawan_class,
          device_serial_hex = coalesce(nullif(trim(excluded.device_serial_hex), ''), user_devices.device_serial_hex),
          updated_at = excluded.updated_at,
          assignment_permissions_json = coalesce(excluded.assignment_permissions_json, user_devices.assignment_permissions_json)
      `),
      decodeGet: this.db.prepare(
        'SELECT device_id, decoder_script, channel, lorawan_class, product_model, updated_at FROM device_decode_config WHERE device_id = ?'
      ),
      decodeUpsert: this.db.prepare(`
        INSERT INTO device_decode_config (device_id, decoder_script, channel, lorawan_class, product_model, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          decoder_script = excluded.decoder_script,
          channel = excluded.channel,
          lorawan_class = excluded.lorawan_class,
          product_model = excluded.product_model,
          updated_at = excluded.updated_at
      `),
      decodeDelete: this.db.prepare('DELETE FROM device_decode_config WHERE device_id = ?'),
      dspGet: this.db.prepare('SELECT body_json, updated_at FROM device_shared_presets WHERE device_id = ?'),
      dspUpsert: this.db.prepare(`
        INSERT INTO device_shared_presets (device_id, body_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET body_json = excluded.body_json, updated_at = excluded.updated_at
      `),
      dspDelete: this.db.prepare('DELETE FROM device_shared_presets WHERE device_id = ?'),
      udDelete: this.db.prepare('DELETE FROM user_devices WHERE user_id = ? AND device_id = ?'),
      udDeleteAllForUser: this.db.prepare('DELETE FROM user_devices WHERE user_id = ?'),
      udUserIdsForDevice: this.db.prepare(
        'SELECT DISTINCT user_id FROM user_devices WHERE device_id = ?'
      ),
      udAllDistinctDeviceIds: this.db.prepare('SELECT DISTINCT device_id FROM user_devices'),
      globalMaxTsPerDevice: this.db.prepare(`
        SELECT device_id, MAX(ts) AS max_ts FROM telemetry GROUP BY device_id
      `),
      telemetryAtDeviceTs: this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM telemetry
        WHERE device_id = ? AND ts = ? ORDER BY id DESC LIMIT 1
      `),
      deviceExistsInSystem: this.db.prepare(`
        SELECT 1 AS x FROM user_devices WHERE device_id = ?
        UNION
        SELECT 1 FROM telemetry WHERE device_id = ?
        LIMIT 1
      `),
      udJoinUsers: this.db.prepare(`
        SELECT ud.device_id, ud.user_id, ud.display_name, ud.tag, ud.product_model, ud.lorawan_class, u.email, u.role
        FROM user_devices ud
        JOIN users u ON u.id = ud.user_id
      `),
      udAnyForDevice: this.db.prepare('SELECT * FROM user_devices WHERE device_id = ? LIMIT 1'),
      udAnyForDevEui: this.db.prepare(`
        SELECT * FROM user_devices
        WHERE lower(replace(replace(replace(dev_eui,':',''),'-',''),' ','')) = ?
        LIMIT 1
      `),
      labelsAll: this.db.prepare('SELECT user_id, device_id, display_name FROM device_labels'),
      labelsDeleteAllForUser: this.db.prepare('DELETE FROM device_labels WHERE user_id = ?'),
      arList: this.db.prepare('SELECT rule_id, payload_json FROM automation_rules WHERE user_id = ?'),
      arDeleteUser: this.db.prepare('DELETE FROM automation_rules WHERE user_id = ?'),
      arInsert: this.db.prepare(
        'INSERT INTO automation_rules (user_id, rule_id, payload_json) VALUES (?, ?, ?)'
      ),
      rtList: this.db.prepare(`
        SELECT template_id, name, payload_json, created_at, updated_at
        FROM report_templates WHERE user_id = ? ORDER BY updated_at DESC
      `),
      rtGet: this.db.prepare(`
        SELECT template_id, name, payload_json, created_at, updated_at
        FROM report_templates WHERE user_id = ? AND template_id = ?
      `),
      rtUpsert: this.db.prepare(`
        INSERT OR REPLACE INTO report_templates (user_id, template_id, name, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      rtDelete: this.db.prepare('DELETE FROM report_templates WHERE user_id = ? AND template_id = ?'),
      rtDeleteUser: this.db.prepare('DELETE FROM report_templates WHERE user_id = ?'),
      dlInsert: this.db.prepare(
        'INSERT INTO downlink_log (id, user_id, created_at, body_json) VALUES (?, ?, ?, ?)'
      ),
      dlList: this.db.prepare(
        'SELECT id, user_id, created_at, body_json FROM downlink_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
      ),
      dlListForDevice: this.db.prepare(
        `SELECT id, user_id, created_at, body_json FROM downlink_log
         WHERE user_id = ? AND json_extract(body_json, '$.deviceId') = ?
         ORDER BY created_at DESC LIMIT ?`
      ),
      dlDeleteAllForUser: this.db.prepare('DELETE FROM downlink_log WHERE user_id = ?'),
      ddGet: this.db.prepare(
        'SELECT widgets_json FROM device_dashboard WHERE user_id = ? AND device_id = ?'
      ),
      ddUpsert: this.db.prepare(`
        INSERT OR REPLACE INTO device_dashboard (user_id, device_id, widgets_json, updated_at)
        VALUES (?, ?, ?, ?)
      `),
      ddDeleteAllForUser: this.db.prepare('DELETE FROM device_dashboard WHERE user_id = ?'),
      telemetryDeleteByDevice: this.db.prepare('DELETE FROM telemetry WHERE device_id = ?'),
      udDeleteAllForDevice: this.db.prepare('DELETE FROM user_devices WHERE device_id = ?'),
      labelsDeleteByDevice: this.db.prepare('DELETE FROM device_labels WHERE device_id = ?'),
      labelsDeleteForUserDevice: this.db.prepare('DELETE FROM device_labels WHERE user_id = ? AND device_id = ?'),
      ddDeleteByDevice: this.db.prepare('DELETE FROM device_dashboard WHERE device_id = ?'),
      ddDeleteForUserDevice: this.db.prepare('DELETE FROM device_dashboard WHERE user_id = ? AND device_id = ?'),
      bsdPrefGet: this.db.prepare(
        'SELECT prefs_json, updated_at FROM device_bsd_preferences WHERE user_id = ? AND device_id = ?'
      ),
      bsdPrefUpsert: this.db.prepare(`
        INSERT OR REPLACE INTO device_bsd_preferences (user_id, device_id, prefs_json, updated_at)
        VALUES (?, ?, ?, ?)
      `),
      bsdPrefDeleteByDevice: this.db.prepare('DELETE FROM device_bsd_preferences WHERE device_id = ?'),
      bsdPrefDeleteUserDevice: this.db.prepare(
        'DELETE FROM device_bsd_preferences WHERE user_id = ? AND device_id = ?'
      ),
      bsdPrefDeleteAllForUser: this.db.prepare('DELETE FROM device_bsd_preferences WHERE user_id = ?'),
      bsdPrefDeleteNonSuperForDevice: this.db.prepare(`
        DELETE FROM device_bsd_preferences
        WHERE device_id = ?
        AND user_id IN (SELECT id FROM users WHERE COALESCE(role, '') != 'superadmin')
      `),
      panelBsdPrefGet: this.db.prepare(
        'SELECT prefs_json, updated_at FROM user_panel_bsd_preferences WHERE user_id = ? AND segment = ? AND panel_id = ?'
      ),
      panelBsdPrefUpsert: this.db.prepare(`
        INSERT OR REPLACE INTO user_panel_bsd_preferences (user_id, segment, panel_id, prefs_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      licGet: this.db.prepare(
        'SELECT device_id, started_at, expires_at, updated_at FROM device_license WHERE device_id = ?'
      ),
      licInsert: this.db.prepare(`
        INSERT INTO device_license (device_id, started_at, expires_at, updated_at)
        VALUES (?, ?, ?, ?)
      `),
      licUpdateExpires: this.db.prepare(
        'UPDATE device_license SET expires_at = ?, updated_at = ? WHERE device_id = ?'
      ),
      licDelete: this.db.prepare('DELETE FROM device_license WHERE device_id = ?'),
      licListAll: this.db.prepare('SELECT device_id, started_at, expires_at, updated_at FROM device_license'),
      udDeleteNonSuperForDevice: this.db.prepare(`
        DELETE FROM user_devices
        WHERE device_id = ?
        AND user_id IN (SELECT id FROM users WHERE COALESCE(role, '') != 'superadmin')
      `),
      labelsDeleteNonSuperForDevice: this.db.prepare(`
        DELETE FROM device_labels
        WHERE device_id = ?
        AND user_id IN (SELECT id FROM users WHERE COALESCE(role, '') != 'superadmin')
      `),
      ddDeleteNonSuperForDevice: this.db.prepare(`
        DELETE FROM device_dashboard
        WHERE device_id = ?
        AND user_id IN (SELECT id FROM users WHERE COALESCE(role, '') != 'superadmin')
      `),
      serverSettingGet: this.db.prepare('SELECT value FROM server_settings WHERE key = ?'),
      serverSettingUpsert: this.db.prepare(`
        INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `),
    };
  }

  dbPath() {
    return this.filePath;
  }

  /** Número de filas en `users` (para bootstrap: cero usuarios → pantalla de primer superadmin). */
  countUsers() {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users').get();
    return Number(row && row.c) || 0;
  }

  /** @param {string} key */
  getServerSetting(key) {
    const row = this.st.serverSettingGet.get(String(key));
    return row && row.value != null ? String(row.value) : '';
  }

  /** @param {string} key @param {string} value */
  setServerSetting(key, value) {
    const iso = new Date().toISOString();
    this.st.serverSettingUpsert.run(String(key), String(value != null ? value : ''), iso);
  }

  /** Catálogo de plantillas compartido (superadmin publica; resto solo lectura). */
  getDeviceTemplatesCatalog() {
    const raw = this.getServerSetting('device_templates_catalog_v1');
    if (!raw || !String(raw).trim()) {
      return { templates: [], defaultTemplateId: null, updatedAt: null };
    }
    try {
      const o = JSON.parse(String(raw));
      const templates = Array.isArray(o.templates) ? o.templates : [];
      const defaultTemplateId =
        o.defaultTemplateId != null && String(o.defaultTemplateId).trim()
          ? String(o.defaultTemplateId).trim()
          : null;
      const updatedAt = o.updatedAt != null ? String(o.updatedAt) : null;
      return { templates, defaultTemplateId, updatedAt };
    } catch {
      return { templates: [], defaultTemplateId: null, updatedAt: null };
    }
  }

  setDeviceTemplatesCatalog(doc) {
    const templates = Array.isArray(doc.templates) ? doc.templates : [];
    const defaultTemplateId =
      doc.defaultTemplateId != null && String(doc.defaultTemplateId).trim()
        ? String(doc.defaultTemplateId).trim()
        : null;
    const updatedAt = new Date().toISOString();
    this.setServerSetting('device_templates_catalog_v1', JSON.stringify({ templates, defaultTemplateId, updatedAt }));
  }

  getDeviceSharedPresetsParsed(deviceId) {
    const did = String(deviceId || '').trim();
    if (!did) return null;
    try {
      const row = this.st.dspGet.get(did);
      if (!row || row.body_json == null || String(row.body_json).trim() === '') return null;
      const o = JSON.parse(String(row.body_json));
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  }

  getDeviceSharedPresetsMap(deviceIds) {
    const out = {};
    const uniq = [...new Set((deviceIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    for (const did of uniq) {
      const o = this.getDeviceSharedPresetsParsed(did);
      if (!o) continue;
      out[did] = o;
    }
    return out;
  }

  setDeviceSharedPresetsParsed(deviceId, bodyObj) {
    const did = String(deviceId || '').trim();
    if (!did) return;
    const iso = new Date().toISOString();
    const payload = JSON.stringify(bodyObj && typeof bodyObj === 'object' ? bodyObj : {});
    this.st.dspUpsert.run(did, payload, iso);
  }

  /** `device_id` cuyos presets compartidos referencian esta plantilla del catálogo. */
  listDeviceIdsWithCatalogTemplate(templateId) {
    const tid = String(templateId || '').trim();
    if (!tid) return [];
    const needle = `"catalogTemplateId":"${tid}"`;
    let rows;
    try {
      rows = this.db
        .prepare(
          `SELECT device_id FROM device_shared_presets
           WHERE instr(body_json, ?) > 0`
        )
        .all(needle);
      return [...new Set((rows || []).map((r) => String(r.device_id || '').trim()).filter(Boolean))];
    } catch {
      try {
        rows = this.db.prepare('SELECT device_id, body_json FROM device_shared_presets').all();
      } catch {
        return [];
      }
    }
    const out = [];
    for (const r of rows || []) {
      try {
        const o = JSON.parse(String(r.body_json || '{}'));
        if (o && String(o.catalogTemplateId || '').trim() === tid) {
          out.push(String(r.device_id));
        }
      } catch {
        /* ignore */
      }
    }
    return [...new Set(out)];
  }

  /**
   * Igual que `listDeviceIdsWithCatalogTemplate` pero solo `device_id` donde el usuario tiene fila en `user_devices`.
   * Evita filtrar dispositivos ajenos al llamar la API sin permiso de módulo Dispositivos.
   */
  listAssignedDeviceIdsWithCatalogTemplate(templateId, userId) {
    const uid = String(userId || '').trim();
    if (!uid) return [];
    const all = this.listDeviceIdsWithCatalogTemplate(templateId);
    if (!all.length) return [];
    let assigned;
    try {
      assigned = new Set(
        this.db
          .prepare('SELECT device_id FROM user_devices WHERE user_id = ?')
          .all(uid)
          .map((r) => String(r.device_id))
      );
    } catch {
      return [];
    }
    return all.filter((did) => assigned.has(String(did)));
  }

  getUserByEmail(email) {
    return rowToUser(this.st.userByEmail.get(email));
  }

  getUserById(id) {
    if (id === undefined || id === null) return null;
    const sid = String(id).trim();
    if (!sid) return null;
    return rowToUser(this.st.userById.get(sid));
  }

  listUsersByCreator(createdBy) {
    const cid = String(createdBy ?? '').trim();
    if (!cid) return [];
    return this.st.usersByCreator.all(cid).map(rowToUser);
  }

  /** Todos los descendientes de `rootUserId` (hijos, nietos, …) por `created_by`. */
  listUsersInSubtree(rootUserId) {
    const root = String(rootUserId ?? '').trim();
    if (!root) return [];
    const all = this.st.allUsers.all().map(rowToUser);
    const byParent = new Map();
    for (const u of all) {
      const p = u.createdBy != null ? String(u.createdBy).trim() : '';
      if (!p) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(u);
    }
    const out = [];
    const stack = [...(byParent.get(root) || [])];
    while (stack.length) {
      const u = stack.pop();
      out.push(u);
      const kids = byParent.get(u.id) || [];
      for (const c of kids) stack.push(c);
    }
    return out;
  }

  /** `descendantId` está en la cadena de `created_by` bajo `ancestorId`. */
  isUserDescendantOf(ancestorId, descendantId) {
    const a = String(ancestorId ?? '').trim();
    const d = String(descendantId ?? '').trim();
    if (!a || !d || a === d) return false;
    let cur = this.getUserById(d);
    for (let i = 0; i < 256 && cur; i++) {
      const p = cur.createdBy != null ? String(cur.createdBy).trim() : '';
      if (!p) return false;
      if (p === a) return true;
      cur = this.getUserById(p);
    }
    return false;
  }

  lnsGetGatewayByEui(userId, gatewayEui) {
    const r = this.st.lgwGetByEui.get(userId, gatewayEui);
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      name: r.name,
      gatewayEui: r.gateway_eui,
      frequencyBand: r.frequency_band,
      createdAt: r.created_at,
    };
  }

  getGatewayByEui(userId, gatewayEui) {
    return this.lnsGetGatewayByEui(userId, gatewayEui);
  }

  allUsersSanitized() {
    return this.st.allUsers.all().map(rowToUser);
  }

  insertUser(user) {
    let navJson =
      user.navPermissionsJson != null && String(user.navPermissionsJson).trim() !== ''
        ? String(user.navPermissionsJson)
        : navPerm.navToJson(navPerm.effectiveNavForUser({ role: user.role, navPermissionsJson: null }));
    if (user.role === 'superadmin') {
      navJson = navPerm.navToJson(navPerm.allNavTrue());
    }
    this.st.insertUser.run({
      id: user.id,
      email: user.email,
      password: user.password,
      role: user.role,
      profile_name: user.profileName || '',
      created_by: user.createdBy || null,
      created_by_email: user.createdByEmail || null,
      ingest_token: user.ingestToken,
      created_at: user.createdAt || new Date().toISOString(),
      milesight_ug_json: user.milesightUgGateway ? JSON.stringify(user.milesightUgGateway) : null,
      eg71_gateway_json: user.eg71Gateway ? JSON.stringify(user.eg71Gateway) : null,
      must_change_password: user.mustChangePassword ? 1 : 0,
      nav_permissions_json: navJson,
    });
  }

  updateUserRecord(user) {
    const existing = this.getUserById(user.id);
    const role =
      user.role !== undefined && user.role != null && String(user.role).trim() !== ''
        ? String(user.role)
        : existing?.role != null
          ? String(existing.role)
          : '';
    let navOut;
    if (Object.prototype.hasOwnProperty.call(user, 'navPermissionsJson')) {
      navOut =
        user.navPermissionsJson != null && String(user.navPermissionsJson).trim() !== ''
          ? String(user.navPermissionsJson)
          : null;
    } else {
      navOut = existing?.navPermissionsJson ?? null;
    }
    if (role === 'superadmin') {
      navOut = navPerm.navToJson(navPerm.allNavTrue());
    }
    this.st.updateUserFull.run({
      id: user.id,
      email: user.email,
      password: user.password,
      role: user.role,
      profile_name: user.profileName || '',
      created_by: user.createdBy || null,
      created_by_email: user.createdByEmail || null,
      ingest_token: user.ingestToken,
      created_at: user.createdAt || null,
      milesight_ug_json: user.milesightUgGateway ? JSON.stringify(user.milesightUgGateway) : null,
      eg71_gateway_json: user.eg71Gateway ? JSON.stringify(user.eg71Gateway) : null,
      must_change_password: user.mustChangePassword ? 1 : 0,
      nav_permissions_json: navOut,
    });
  }

  deleteUserById(id) {
    const uid = String(id || '').trim();
    if (!uid) return;
    this.deleteAllDeviceScopedDataForUser(uid);
    try {
      this.st.arDeleteUser.run(uid);
    } catch {
      /* ignore */
    }
    try {
      this.st.rtDeleteUser.run(uid);
    } catch {
      /* ignore */
    }
    this.st.deleteUser.run(uid);
  }

  /** Actualiza properties_json de una fila existente (re-decode / corrección). */
  patchTelemetryPropertiesAt(userId, deviceId, ts, properties) {
    const payload = JSON.stringify(properties || {});
    const did = String(deviceId);
    const tss = Number(ts);
    const info = this.db
      .prepare(
        `UPDATE telemetry SET properties_json = ? WHERE user_id = ? AND device_id = ? AND ts = ?`
      )
      .run(payload, String(userId), did, tss);
    if (info.changes > 0) {
      const snap = this.st.getDeviceLatest.get(did);
      if (snap && Number(snap.ts) === tss) {
        this._upsertDeviceLatest(did, snap.user_id || userId, snap.device_name, payload, tss);
      }
    }
    return info.changes > 0;
  }

  /** Réplica de telemetría por usuario asignado (legado). Defecto: una sola fila de historial. */
  _telemetryMirrorEnabled() {
    const raw = process.env.SYSCOM_TELEMETRY_MIRROR;
    if (raw == null || String(raw).trim() === '') return false;
    const v = String(raw).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
  }

  _upsertDeviceLatest(deviceId, userId, deviceName, propertiesJson, ts) {
    if (!this.st || !this.st.upsertDeviceLatest) return;
    const did = String(deviceId || '').trim();
    if (!did) return;
    const tss = Number(ts);
    if (!Number.isFinite(tss)) return;
    try {
      this.st.upsertDeviceLatest.run({
        device_id: did,
        user_id: String(userId || ''),
        device_name: deviceName != null && String(deviceName).trim() !== '' ? String(deviceName) : null,
        properties_json: propertiesJson != null ? String(propertiesJson) : '{}',
        ts: tss,
      });
    } catch (e) {
      console.warn('[store] device_latest upsert:', e && e.message);
    }
  }

  /**
   * Cuenta dueña del historial (ingesta). Listado y ACL siguen por `user_devices`.
   */
  _telemetryOwnerUserId(deviceId, fallbackUserId) {
    const did = String(deviceId || '').trim();
    const fb = String(fallbackUserId || '').trim();
    if (!did) return fb;
    const snap = this.st.getDeviceLatest.get(did);
    if (snap && snap.user_id) return String(snap.user_id);
    const any = this.st.latestForDeviceAny.get(did);
    if (any && any.user_id) {
      this._upsertDeviceLatest(did, any.user_id, any.device_name, any.properties_json, any.ts);
      return String(any.user_id);
    }
    return fb;
  }

  /**
   * Rellena `device_latest` sin WINDOW sobre toda `telemetry` (índice por device_id).
   * @returns {number} filas creadas en este lote
   */
  ensureDeviceLatestBackfill(limit = 80) {
    const cap = Math.min(400, Math.max(1, Math.floor(Number(limit)) || 80));
    const ids = this.st.udAllDistinctDeviceIds.all();
    let filled = 0;
    for (const r of ids) {
      if (filled >= cap) break;
      const did = String(r.device_id || '').trim();
      if (!did) continue;
      if (this.st.getDeviceLatest.get(did)) continue;
      const row = this.st.latestForDeviceAny.get(did);
      if (!row) continue;
      this._upsertDeviceLatest(did, row.user_id, row.device_name, row.properties_json, row.ts);
      filled += 1;
    }
    return filled;
  }

  _telemetryAffectedUserIds(userId, deviceId) {
    const did = String(deviceId);
    const affected = new Set([String(userId)]);
    const peers = this.st.udUserIdsForDevice.all(did);
    for (const p of peers) {
      const uid = String(p.user_id);
      if (uid === String(userId)) continue;
      affected.add(uid);
    }
    if (this.deviceInSuperadminPool(did, userId)) {
      for (const sid of this.listSuperadminUserIds()) {
        affected.add(String(sid));
      }
    }
    return Array.from(affected);
  }

  _emitTelemetryRealtimeHooks(userId, deviceId, deviceName, properties, ts) {
    const did = String(deviceId);
    const tss = ts || Date.now();
    const userIds = this._telemetryAffectedUserIds(userId, did);
    const props = properties && typeof properties === 'object' ? properties : {};
    const deviceType = props.deviceType != null ? String(props.deviceType) : undefined;
    if (this._telemetryBroadcastHook) {
      try {
        this._telemetryBroadcastHook({
          userIds,
          deviceId: did,
          deviceName: deviceName != null ? String(deviceName) : null,
          ts: tss,
          deviceType,
          properties: { ...props },
        });
      } catch (e) {
        console.warn('[store] telemetry broadcast hook:', e.message);
      }
    }
    if (this._automationTelemetryHook) {
      try {
        this._automationTelemetryHook({
          userIds,
          deviceId: did,
          deviceName: deviceName != null ? String(deviceName) : null,
          ts: tss,
          properties: { ...props },
        });
      } catch (e) {
        console.warn('[store] automation telemetry hook:', e.message);
      }
    }
    return userIds;
  }

  /** SSE / reglas sin insertar fila (p. ej. dedup SQLite pero UI en vivo). */
  broadcastTelemetryRealtime(userId, deviceId, deviceName, properties, ts) {
    return this._emitTelemetryRealtimeHooks(userId, deviceId, deviceName, properties, ts);
  }

  appendTelemetry(userId, deviceId, deviceName, properties, ts) {
    const payload = JSON.stringify(properties || {});
    const did = String(deviceId);
    const tss = ts || Date.now();
    const row = {
      user_id: userId,
      device_id: did,
      device_name: deviceName || null,
      properties_json: payload,
      ts: tss,
    };
    this.st.insertTelemetry.run(row);
    this._upsertDeviceLatest(did, userId, deviceName, payload, tss);
    if (this._telemetryMirrorEnabled()) {
      const affected = new Set([String(userId)]);
      const peers = this.st.udUserIdsForDevice.all(did);
      for (const p of peers) {
        const uid = String(p.user_id);
        if (uid === String(userId)) continue;
        if (affected.has(uid)) continue;
        affected.add(uid);
        this.st.insertTelemetry.run({
          user_id: uid,
          device_id: did,
          device_name: deviceName || null,
          properties_json: payload,
          ts: tss,
        });
      }
      if (this.deviceInSuperadminPool(did, userId)) {
        for (const sid of this.listSuperadminUserIds()) {
          if (affected.has(sid)) continue;
          affected.add(sid);
          this.st.insertTelemetry.run({
            user_id: sid,
            device_id: did,
            device_name: deviceName || null,
            properties_json: payload,
            ts: tss,
          });
        }
      }
    }
    return this._emitTelemetryRealtimeHooks(userId, did, deviceName, properties, tss);
  }

  /**
   * Actualiza `ts` de la última fila (p. ej. join LoRaWAN duplicado: misma carga, nueva actividad en radio).
   * @returns {boolean} false si no hay fila previa.
   */
  touchLastTelemetryTimestamp(userId, deviceId, deviceName, properties, ts) {
    const uidIn = String(userId);
    const did = String(deviceId);
    const tss = ts || Date.now();
    const snap = this.st.getDeviceLatest.get(did);
    const uid = snap && snap.user_id ? String(snap.user_id) : uidIn;
    let row = this.st.latestForDevice.get(uid, did);
    if (!row) row = this.st.latestForDeviceAny.get(did);
    if (!row) return false;
    this.st.updateTelemetryTs.run({ id: row.id, ts: tss });
    const propsJson = row.properties_json;
    this._upsertDeviceLatest(did, row.user_id, deviceName || row.device_name, propsJson, tss);
    if (this._telemetryMirrorEnabled()) {
      const affected = new Set([String(row.user_id)]);
      const peers = this.st.udUserIdsForDevice.all(did);
      for (const p of peers) {
        const peerUid = String(p.user_id);
        if (affected.has(peerUid)) continue;
        const peerRow = this.st.latestForDevice.get(peerUid, did);
        if (peerRow) {
          this.st.updateTelemetryTs.run({ id: peerRow.id, ts: tss });
          affected.add(peerUid);
        }
      }
      if (this.deviceInSuperadminPool(did, row.user_id)) {
        for (const sid of this.listSuperadminUserIds()) {
          if (affected.has(sid)) continue;
          const peerRow = this.st.latestForDevice.get(sid, did);
          if (peerRow) {
            this.st.updateTelemetryTs.run({ id: peerRow.id, ts: tss });
            affected.add(sid);
          }
        }
      }
    }
    this._emitTelemetryRealtimeHooks(uidIn, did, deviceName, properties, tss);
    return true;
  }

  setRetentionMs(ms) {
    this.retentionMs = ms;
  }

  getLatestMap(userId) {
    const ids = this.listUserDevices(userId)
      .map((r) => String(r.deviceId || '').trim())
      .filter(Boolean);
    return this.getLatestMapForDevices(userId, ids);
  }

  /**
   * Última fila por dispositivo vía `device_latest` (1 fila/nodo). Fallback a telemetry indexada.
   */
  getLatestMapForDevices(userId, deviceIds) {
    const uid = String(userId || '').trim();
    const map = {};
    const ids = Array.isArray(deviceIds) ? deviceIds : [];
    for (const raw of ids) {
      const did = String(raw || '').trim();
      if (!did) continue;
      const snap = this.st.getDeviceLatest.get(did);
      if (snap) {
        map[did] = rowToTelemetryRow({
          id: snap.device_id,
          user_id: snap.user_id,
          device_id: snap.device_id,
          device_name: snap.device_name,
          properties_json: snap.properties_json,
          ts: snap.ts,
        });
        continue;
      }
      const row = this.st.latestForDeviceAny.get(did) || (uid ? this.st.latestForDevice.get(uid, did) : null);
      if (row) {
        map[did] = rowToTelemetryRow(row);
        this._upsertDeviceLatest(did, row.user_id, row.device_name, row.properties_json, row.ts);
      }
    }
    return map;
  }

  getTelemetryForGatewayScan(userId, limit) {
    const since = Date.now() - (parseInt(process.env.GW_STATUS_LOOKBACK_MS, 10) || 7 * 24 * 60 * 60 * 1000);
    const lim = Math.min(limit || 50000, 200000);
    return this.st.telemetryRecentForUser.all(userId, since, lim).map(rowToTelemetryRow);
  }

  /** Última fila en BD sin fusionar historial (evita recursión con getMergedLatestTelemetryForDevice). */
  _getLatestRowDirect(userId, deviceId) {
    const did = String(deviceId);
    const snap = this.st.getDeviceLatest.get(did);
    if (snap) {
      return rowToTelemetryRow({
        id: snap.device_id,
        user_id: snap.user_id,
        device_id: snap.device_id,
        device_name: snap.device_name,
        properties_json: snap.properties_json,
        ts: snap.ts,
      });
    }
    const owner = this._telemetryOwnerUserId(did, userId);
    const row =
      (owner ? this.st.latestForDevice.get(String(owner), did) : null) || this.st.latestForDeviceAny.get(did);
    return row ? rowToTelemetryRow(row) : null;
  }

  getLatestForDevice(userId, deviceId) {
    const did = String(deviceId);
    const merged = this.getMergedLatestTelemetryForDevice(userId, did, { historyRowLimit: 12 });
    if (merged) return merged;
    return this._getLatestRowDirect(userId, did);
  }

  /**
   * Última telemetría por dispositivo fusionando hasta N filas recientes (más nueva primero):
   * cada clave escalar toma el valor del uplink más reciente que la incluya.
   * Así los widgets muestran el último dato persistido aunque el último paquete no traiga todos los campos (p. ej. salidas esporádicas).
   * @param {string} userId
   * @param {string} deviceId
   * @param {{ historyRowLimit?: number }} [opts]
   * @returns {object | null} Misma forma que `getLatestForDevice` (`properties`, `timestamp`, …).
   */
  /** Uplink de aplicación (con payload); excluye solo eventos join del LNS sin conteo. */
  _isJoinOnlyTelemetryProperties(properties) {
    if (!properties || typeof properties !== 'object') return false;
    const ev = properties.lorawan_event != null ? String(properties.lorawan_event).trim() : '';
    if (!ev || !/join/i.test(ev)) return false;
    const hex = properties.payload_hex != null ? String(properties.payload_hex).trim() : '';
    return hex.length === 0;
  }

  /**
   * Fusiona filas de historial (más reciente primero) en un único objeto `properties`.
   * @param {object[]} rows Filas SQLite de telemetría del mismo dispositivo.
   * @returns {{ top: object, mergedFlat: Record<string, unknown>, timestamp: number } | null}
   */
  _mergeTelemetryHistoryRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;

    const appRows = [];
    for (const row of rows) {
      try {
        const p = JSON.parse(row.properties_json || '{}');
        if (!this._isJoinOnlyTelemetryProperties(p)) appRows.push(row);
      } catch {
        /* ignore */
      }
    }
    const rowsForMerge = appRows.length ? appRows : rows;

    const mergedFlat = {};
    for (const row of rowsForMerge) {
      let properties = {};
      try {
        properties = JSON.parse(row.properties_json || '{}');
      } catch {
        continue;
      }
      const expanded = expandNestedGatewayTelemetry(properties);
      const flat = flattenTelemetryProps(expanded);
      for (const [k, v] of Object.entries(flat)) {
        if (k === 'lastUpdateTime') continue;
        if (!isMeaningfulTelemetryMergeValue(v)) continue;
        if (!Object.prototype.hasOwnProperty.call(mergedFlat, k)) mergedFlat[k] = v;
      }
    }

    const top = rowsForMerge[0];
    let ts = Number(top.ts);
    let lastAppUplinkMs = null;
    for (const row of rows) {
      const t = Number(row.ts);
      if (Number.isFinite(t) && (!Number.isFinite(ts) || t > ts)) ts = t;
      let p = {};
      try {
        p = JSON.parse(row.properties_json || '{}');
      } catch {
        /* ignore */
      }
      if (!this._isJoinOnlyTelemetryProperties(p)) {
        const at = Number(row.ts);
        if (Number.isFinite(at) && (!Number.isFinite(lastAppUplinkMs) || at > lastAppUplinkMs)) {
          lastAppUplinkMs = at;
        }
      }
    }
    mergedFlat.lastUpdateTime = ts;
    if (Number.isFinite(lastAppUplinkMs) && lastAppUplinkMs > 0) {
      mergedFlat.lastAppUplinkMs = lastAppUplinkMs;
    }
    if (hasDecodedPeopleCountTelemetry(mergedFlat)) {
      delete mergedFlat.ingestStatus;
    } else if (!appRows.length && rows.length) {
      mergedFlat.ingestStatus =
        'Solo join LoRaWAN (sin uplink de aplicación con payload). Revise intervalo de reporte y sesión OTAA en el equipo.';
    }

    return { top, mergedFlat, timestamp: ts, lastAppUplinkMs };
  }

  getMergedLatestTelemetryForDevice(userId, deviceId, opts = {}) {
    const did = String(deviceId);
    const uid = this._telemetryOwnerUserId(did, userId);
    const rowLimit = Math.min(
      500,
      Math.max(1, Number.isFinite(Number(opts.historyRowLimit)) ? Math.floor(Number(opts.historyRowLimit)) : 500)
    );
    const endMs = Date.now();
    const rows = this.st.telemetryHistory.all(uid, did, 0, endMs, rowLimit);
    if (!rows.length) return this._getLatestRowDirect(uid, did);

    const merged = this._mergeTelemetryHistoryRows(rows);
    if (!merged) return this._getLatestRowDirect(uid, did);

    const { top, mergedFlat, timestamp } = merged;
    return {
      id: String(top.id),
      userId: top.user_id,
      deviceId: top.device_id,
      deviceName: top.device_name || top.device_id,
      properties: mergedFlat,
      timestamp,
    };
  }

  /**
   * Mapa deviceId → última telemetría fusionada (varios uplinks recientes por equipo).
   * @param {string} userId
   * @param {string[]|null} [deviceIds] Si se indica, solo esos dispositivos.
   * @param {{ historyRowLimit?: number }} [opts]
   */
  /**
   * Telemetría para listado: última fila por defecto; fusiona historial solo si hace falta (VS133 parcial / solo join).
   * @param {string} userId
   * @param {string[]} deviceIds
   * @param {Record<string, { productModel?: string }>} [decodeMap]
   * @param {{ historyRowLimit?: number }} [opts]
   */
  getDeviceListTelemetryMap(userId, deviceIds, decodeMap = {}, opts = {}) {
    const uid = String(userId || '').trim();
    const ids = Array.isArray(deviceIds) ? deviceIds.map((d) => String(d).trim()).filter(Boolean) : [];
    if (!ids.length) return {};

    const latestMap = this.getLatestMapForDevices(uid, ids);
    const out = {};
    for (const did of ids) {
      if (latestMap[did]) out[did] = latestMap[did];
    }
    return out;
  }

  getMergedLatestMap(userId, deviceIds = null, opts = {}) {
    const uid = String(userId || '').trim();
    if (!uid) return {};
    const rowLimit = Math.min(
      64,
      Math.max(1, Number.isFinite(Number(opts.historyRowLimit)) ? Math.floor(Number(opts.historyRowLimit)) : 8)
    );
    const endMs = Date.now();
    const filterSet =
      Array.isArray(deviceIds) && deviceIds.length
        ? new Set(deviceIds.map((d) => String(d).trim()).filter(Boolean))
        : null;

    const map = {};
    const mergeRows = (did, rows) => {
      const merged = this._mergeTelemetryHistoryRows(rows);
      if (!merged) return;
      const { top, mergedFlat, timestamp } = merged;
      map[did] = {
        id: String(top.id),
        userId: top.user_id,
        deviceId: did,
        deviceName: top.device_name || did,
        properties: mergedFlat,
        timestamp,
      };
    };

    /** Siempre por dispositivo (índice). El WINDOW sobre toda la tabla del usuario provoca 504. */
    if (!filterSet || filterSet.size === 0) return map;
    for (const did of filterSet) {
      const owner = this._telemetryOwnerUserId(did, uid);
      const rows = this.st.telemetryHistory.all(owner, did, 0, endMs, rowLimit);
      if (rows.length) mergeRows(did, rows);
    }
    return map;
  }

  /**
   * Historial de telemetría por dispositivo (más recientes primero).
   * @param {string} userId
   * @param {string} deviceId
   * @param {{ startMs?: number, endMs?: number, limit?: number }} [opts]
   */
  getTelemetryHistory(userId, deviceId, opts = {}) {
    const startMs = opts.startMs != null && Number.isFinite(Number(opts.startMs)) ? Number(opts.startMs) : 0;
    const endMs =
      opts.endMs != null && Number.isFinite(Number(opts.endMs)) ? Number(opts.endMs) : Date.now();
    const limit = Math.min(4000, Math.max(1, Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 50));
    const did = String(deviceId);
    const uid = this._telemetryOwnerUserId(did, userId);
    return this.st.telemetryHistory
      .all(uid, did, startMs, endMs, limit)
      .map(rowToTelemetryRow);
  }

  getTelemetryRowsForResolve(userId, limit) {
    return this.st.telemetryForResolve.all(userId, limit || 8000).map((row) => {
      let properties = {};
      try {
        properties = JSON.parse(row.properties_json || '{}');
      } catch {
        properties = {};
      }
      return {
        deviceId: row.device_id,
        deviceName: row.device_name,
        properties,
        timestamp: row.ts,
      };
    });
  }

  /**
   * Serie temporal acotada para gráficos / historial.
   * Antes: `telemetryRange` sin LIMIT leía **todas** las filas del intervalo (mes = cientos de MB JSON) → muy lento.
   * Ahora: `telemetryHistory` con LIMIT (más recientes en el rango), orden cronológico ASC para el cliente.
   * Con `bucketMs`, una fila por cubo de tiempo (cubre todo el periodo; evita que Día arranque a media mañana).
   */
  getTelemetrySeries(userId, deviceId, startMs, endMs, propKey, maxRows, bucketMs) {
    const did = String(deviceId);
    const uid = this._telemetryOwnerUserId(did, userId);
    const s = parseInt(startMs, 10) || 0;
    const e = parseInt(endMs, 10) || Date.now();
    const cap = Math.min(maxRows || 500, 4000);
    const pk = propKey != null && String(propKey).trim() !== '' ? String(propKey).trim() : '';
    const bucket = clampTelemetrySampleBucketMs(bucketMs);
    const cacheTtl = Math.max(
      1000,
      parseInt(String(process.env.SYSCOM_TELEMETRY_SERIES_CACHE_MS || '4000').trim(), 10) || 4000
    );
    const cacheKey = `${uid}|${did}|${s}|${e}|${pk}|${cap}|${bucket}`;
    const hit = this._telemetrySeriesCache.get(cacheKey);
    if (hit && Date.now() - hit.at < cacheTtl) return hit.data;

    /** Con filtro por clave, pedir más filas porque muchas no traen la propiedad (mismo tope duro 4000). */
    const fetchLimit = pk ? Math.min(4000, Math.max(cap * 3, cap, 120)) : cap;

    let list;
    if (bucket > 0) {
      const needle = pk ? `"${pk.replace(/"/g, '')}"` : '';
      const rows = this._telemetryHistorySampledStmt(bucket).all(
        needle,
        needle,
        uid,
        did,
        s,
        e,
        fetchLimit
      );
      list = rows.map(rowToTelemetryRow);
    } else {
      const rows = this.st.telemetryHistory.all(uid, did, s, e, fetchLimit);
      const chron = rows.slice().reverse();
      list = chron.map(rowToTelemetryRow);
    }
    if (pk) {
      list = list.filter((t) => t.properties && telemetryRowHasPropertyKey(t.properties, pk));
      if (list.length > cap) list = list.slice(-cap);
    }
    this._telemetrySeriesCache.set(cacheKey, { at: Date.now(), data: list });
    if (this._telemetrySeriesCache.size > 300) {
      const cutoff = Date.now() - cacheTtl * 4;
      for (const [k, v] of this._telemetrySeriesCache) {
        if (v.at < cutoff) this._telemetrySeriesCache.delete(k);
      }
    }
    return list;
  }

  _telemetryHistorySampledStmt(bucketMs) {
    const b = clampTelemetrySampleBucketMs(bucketMs);
    if (!this._telemetrySampledStmt) this._telemetrySampledStmt = new Map();
    let stmt = this._telemetrySampledStmt.get(b);
    if (!stmt) {
      stmt = this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM (
          SELECT id, user_id, device_id, device_name, properties_json, ts,
            ROW_NUMBER() OVER (
              PARTITION BY (ts / ${b})
              ORDER BY CASE WHEN ? = '' THEN 0 WHEN instr(properties_json, ?) > 0 THEN 0 ELSE 1 END ASC,
                CASE WHEN instr(properties_json, '"lorawan_event"') > 0 THEN 1 ELSE 0 END ASC,
                ts DESC, id DESC
            ) AS rn
          FROM telemetry
          WHERE user_id = ? AND device_id = ? AND ts >= ? AND ts <= ?
        ) WHERE rn = 1
        ORDER BY ts ASC
        LIMIT ?
      `);
      this._telemetrySampledStmt.set(b, stmt);
    }
    return stmt;
  }

  getLastTelemetryRow(userId, deviceId) {
    const did = String(deviceId);
    const snap = this.st.getDeviceLatest.get(did);
    if (snap) {
      return { properties_json: snap.properties_json, ts: snap.ts, user_id: snap.user_id };
    }
    const owner = this._telemetryOwnerUserId(did, userId);
    return this.st.lastTelemetrySameProps.get(owner, did) || this.st.lastTelemetrySameProps.get(userId, did);
  }

  lastPropertiesJsonEqual(userId, deviceId, properties) {
    const row = this.getLastTelemetryRow(userId, deviceId);
    if (!row) return false;
    const next = JSON.stringify(properties || {});
    if (row.properties_json !== next) return false;
    /** Misma carga repetida (p. ej. UC300 cada 1 min sin cambio de GPIO): antes se omitía el INSERT y `lastUpdateTime` quedaba congelado. Solo deduplicar ráfagas cercanas en el tiempo. */
    const dedupMs = Math.min(
      300000,
      Math.max(500, parseInt(String(process.env.SYSCOM_TELEMETRY_DEDUP_MS || '').trim(), 10) || 8000)
    );
    const prevTs = Number(row.ts);
    if (!Number.isFinite(prevTs)) return false;
    return Date.now() - prevTs < dedupMs;
  }

  getDeviceLabels(userId) {
    return this.st.labelsForUser.all(userId).map((r) => ({
      userId: r.user_id,
      deviceId: r.device_id,
      displayName: r.display_name,
    }));
  }

  upsertDeviceLabel(userId, deviceId, displayName) {
    this.st.upsertLabel.run(userId, String(deviceId), displayName);
  }

  listLorawanGateways(userId) {
    return this.st.lgwList.all(userId).map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      gatewayEui: r.gateway_eui,
      frequencyBand: r.frequency_band,
      createdAt: r.created_at,
    }));
  }

  lorawanGatewayExists(userId, euiLower) {
    return Boolean(this.st.lgwExists.get(userId, euiLower));
  }

  /** True si cualquier usuario ya dio de alta este Gateway EUI (16 hex normalizado). */
  lorawanGatewayEuiExistsGlobally(eui16Norm) {
    const h = String(eui16Norm || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (h.length !== 16) return false;
    return Boolean(this.st.lgwExistsGlobally.get(h));
  }

  lorawanGatewayEuiExistsGloballyExceptId(eui16Norm, exceptId) {
    const h = String(eui16Norm || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    const eid = String(exceptId || '').trim();
    if (h.length !== 16 || !eid) return false;
    return Boolean(this.st.lgwExistsGloballyExceptId.get(h, eid));
  }

  getLorawanGatewayById(id) {
    const r = this.st.lgwGetById.get(String(id || '').trim());
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      name: r.name,
      gatewayEui: r.gateway_eui,
      frequencyBand: r.frequency_band,
      createdAt: r.created_at,
    };
  }

  updateLorawanGateway(id, { name, gatewayEui, frequencyBand }) {
    const info = this.st.lgwUpdate.run(
      name,
      gatewayEui,
      frequencyBand,
      String(id || '').trim()
    );
    return Number(info.changes || 0) > 0;
  }

  insertLorawanGateway(row) {
    this.st.lgwInsert.run(
      row.id,
      row.userId,
      row.name,
      row.gatewayEui,
      row.frequencyBand,
      row.createdAt
    );
  }

  /** Solo borra la fila del gateway del usuario indicado (`id` + `user_id`); no modifica gateways de otras cuentas. */
  deleteLorawanGateway(userId, id) {
    const info = this.st.lgwDelete.run(id, userId);
    return Number(info.changes || 0) > 0;
  }

  /**
   * Usuarios que tienen registrado un gateway con este EUI (8 B del paquete Semtech, ambos órdenes hex).
   * @param {Buffer} mac8
   * @returns {string[]}
   */
  findUserIdsBySemtechGatewayMac8(mac8) {
    if (!Buffer.isBuffer(mac8) || mac8.length !== 8) return [];
    const h1 = mac8.toString('hex').toLowerCase();
    const h2 = Buffer.from(mac8).reverse().toString('hex').toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT user_id FROM lorawan_gateways
         WHERE lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) IN (?, ?)`
      )
      .all(h1, h2);
    return rows.map((r) => r.user_id);
  }

  /**
   * Cuentas que procesan PUSH_DATA: dueños del EUI en `lorawan_gateways` (varios GW por cuenta OK).
   * Sin replicar entre cuentas salvo SYSCOM_SUPERADMIN_POOL_MIRROR=1.
   * @param {Buffer} mac8
   * @returns {string[]}
   */
  findUserIdsForSemtechPush(mac8) {
    const owners = this.findUserIdsBySemtechGatewayMac8(mac8).map((id) => String(id));
    if (owners.length > 0) {
      let list = owners;
      if (String(process.env.SYSCOM_LNS_PUSH_INCLUDE_SUPERADMIN || '0').trim() === '1') {
        const out = new Set(owners);
        for (const sid of this.listSuperadminUserIds()) out.add(sid);
        list = Array.from(out);
      }
      if (list.length > 1 && String(process.env.SYSCOM_LNS_MULTI_OWNER_PUSH || '0').trim() !== '1') {
        const primary = process.env.SYSCOM_LNS_GATEWAY_PRIMARY_USER_ID;
        if (primary != null && String(primary).trim()) {
          const p = String(primary).trim();
          if (list.includes(p)) return [p];
        }
        const eui16 = this.lnsResolveGatewayEuiNorm(mac8);
        if (eui16 && eui16.length === 16) {
          const gwLike = `%${eui16.slice(-12)}%`;
          try {
            const best = this.db
              .prepare(
                `SELECT user_id, COUNT(*) AS c FROM lorawan_lns_sessions
                 WHERE lower(replace(replace(replace(ifnull(last_gateway_eui,''),':',''),'-',''),' ','')) LIKE ?
                 GROUP BY user_id ORDER BY c DESC LIMIT 1`
              )
              .get(gwLike);
            if (best && best.user_id && list.includes(String(best.user_id))) {
              return [String(best.user_id)];
            }
          } catch {
            /* ignore */
          }
        }
        return [list[0]];
      }
      return list;
    }
    const out = new Set();
    for (const sid of this.listSuperadminUserIds()) out.add(sid);
    const defUid = process.env.SYSCOM_LNS_DEFAULT_USER_ID;
    if (defUid != null && String(defUid).trim()) out.add(String(defUid).trim());
    return Array.from(out);
  }

  lnsGwForceClassCImme(gatewayEuiNorm16) {
    const gwKey = normalizeLnsGatewayEuiKey(gatewayEuiNorm16);
    return this._gwForceClassCImme.has(gwKey);
  }

  lnsMarkGwForceClassCImme(gatewayEuiNorm16) {
    const gwKey = normalizeLnsGatewayEuiKey(gatewayEuiNorm16);
    this._gwForceClassCImme.add(gwKey);
    if (this._gwForceClassCImme.size > 200) {
      const arr = Array.from(this._gwForceClassCImme);
      this._gwForceClassCImme = new Set(arr.slice(-100));
    }
  }

  lnsHasPendingPullRespForDev(userId, devEuiNorm16) {
    const h = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (h.length !== 16) return false;
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM lorawan_lns_downlink
         WHERE user_id = ? AND lower(replace(replace(replace(ifnull(tx_dev_eui,''),':',''),'-',''),' ','')) = ?
           AND status IN ('pending','await_tx_ack') LIMIT 1`
      )
      .get(String(userId), h);
    return Boolean(row);
  }

  /**
   * Cuentas que tienen dado de alta un gateway con este EUI 16 hex (para hooks TX_ACK sin `user_id` en fila).
   * @param {string} eui16
   * @returns {string[]}
   */
  findUserIdsByLorawanGatewayEuiNorm16(eui16) {
    const h = String(eui16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (h.length !== 16) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT user_id FROM lorawan_gateways
         WHERE lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) = ?`
      )
      .all(h);
    return rows.map((r) => String(r.user_id));
  }

  /** EUI 16 hex sin separadores para cola PULL_RESP (primer match en BD o hex wire). */
  lnsResolveGatewayEuiNorm(mac8) {
    if (!Buffer.isBuffer(mac8) || mac8.length !== 8) return null;
    const h1 = mac8.toString('hex').toLowerCase();
    const h2 = Buffer.from(mac8).reverse().toString('hex').toLowerCase();
    const r = this.db
      .prepare(
        `SELECT gateway_eui FROM lorawan_gateways
         WHERE lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) IN (?, ?) LIMIT 1`
      )
      .get(h1, h2);
    if (r) return String(r.gateway_eui || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    return h1;
  }

  getLorawanGatewayEuiNormForUser(userId, mac8) {
    if (!Buffer.isBuffer(mac8) || mac8.length !== 8) return null;
    const h1 = mac8.toString('hex').toLowerCase();
    const h2 = Buffer.from(mac8).reverse().toString('hex').toLowerCase();
    const r = this.st.lgwEuiForMac.get(userId, h1, h2);
    if (!r) return null;
    return String(r.gateway_eui || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  }

  lnsFindOtaaDeviceRow(userId, joinEuiHex16, devEuiHex16) {
    const j = String(joinEuiHex16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    const d = String(devEuiHex16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (d.length !== 16) return null;
    let r = this.st.lnsOtaaDevice.get(userId, d, j);
    if (r) return r;
    r = this.st.lnsOtaaDeviceByDevEuiOnly.get(userId, d);
    if (r) return r;
    r = this.st.lnsOtaaDeviceByDeviceIdAsDevEui.get(userId, d);
    return r || null;
  }

  /**
   * Dispositivo OTAA en cualquier cuenta (p. ej. gateway dado de alta en otra cuenta que la del sensor).
   * @returns {{ userId: string, row: object } | null}
   */
  lnsFindOtaaDeviceRowGlobal(joinEuiHex16, devEuiHex16) {
    const j = String(joinEuiHex16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    const d = String(devEuiHex16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (d.length !== 16) return null;
    let r = j.length === 16 ? this.st.lnsOtaaDeviceGlobal.get(d, j) : null;
    if (!r) r = this.st.lnsOtaaDeviceGlobalByDevEuiOnly.get(d);
    if (!r) r = this.st.lnsOtaaDeviceGlobalByDeviceIdAsDevEui.get(d);
    if (!r || !r.user_id) return null;
    return { userId: String(r.user_id), row: r };
  }

  /**
   * OTAA en cualquier cuenta superadmin (pool unificado).
   * @returns {{ userId: string, row: object } | null}
   */
  lnsFindOtaaDeviceRowInSuperadminPool(joinEuiHex16, devEuiHex16) {
    for (const uid of this.listSuperadminUserIds()) {
      const row = this.lnsFindOtaaDeviceRow(uid, joinEuiHex16, devEuiHex16);
      if (row) return { userId: uid, row };
    }
    return null;
  }

  /** @returns {{ userId: string, session: object } | null} */
  lnsGetSessionByDevAddrInSuperadminPool(devAddrHex8) {
    const h = String(devAddrHex8 || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (h.length !== 8) return null;
    for (const uid of this.listSuperadminUserIds()) {
      const session = this.lnsGetSessionByDevAddr(uid, h);
      if (session) return { userId: uid, session };
    }
    return null;
  }

  /** IDs de cuentas con rol superadmin. */
  listSuperadminUserIds() {
    return this.st.usersSuperadminIds.all().map((r) => String(r.id));
  }

  isSuperadminUserId(userId) {
    const u = this.getUserById(userId);
    return u != null && String(u.role || '').trim().toLowerCase() === 'superadmin';
  }

  /** Dispositivo dado de alta o asignado a al menos una cuenta superadmin. */
  deviceInSuperadminPool(deviceId, ingestUserId) {
    const did = String(deviceId || '').trim();
    if (!did) return false;
    if (ingestUserId && this.isSuperadminUserId(ingestUserId)) return true;
    for (const uid of this.listUserIdsAssignedToDevice(did)) {
      if (this.isSuperadminUserId(uid)) return true;
    }
    return false;
  }

  /**
   * user_id dueño del historial (ingesta). Asignados y superadmin leen la misma fila vía ACL.
   */
  resolveTelemetryUserId(requesterUserId, deviceId, opts = {}) {
    const role = opts.role != null ? String(opts.role).trim().toLowerCase() : '';
    const req = String(requesterUserId || '').trim();
    const did = String(deviceId || '').trim();
    if (!did) return req;
    const owner = this._telemetryOwnerUserId(did, '');
    if (owner) return owner;
    if (role !== 'superadmin') return req;
    if (this.st.latestForDevice.get(req, did)) return req;
    for (const sid of this.listSuperadminUserIds()) {
      if (sid === req) continue;
      if (this.st.latestForDevice.get(sid, did)) return sid;
    }
    for (const uid of this.listUserIdsAssignedToDevice(did)) {
      if (this.st.latestForDevice.get(uid, did)) return uid;
    }
    return req;
  }

  /**
   * Fila `user_devices` visible para el actor (superadmin: cualquier alta del pool).
   */
  getUserDeviceForActor(actorUserId, actorRole, deviceId) {
    const did = String(deviceId || '').trim();
    if (!did) return null;
    const own = this.getUserDevice(actorUserId, did);
    if (own) return own;
    if (String(actorRole || '').trim().toLowerCase() !== 'superadmin') return null;
    const any = this.getAnyUserDeviceForDeviceId(did);
    if (any) return any;
    for (const sid of this.listSuperadminUserIds()) {
      const ud = this.getUserDevice(sid, did);
      if (ud) return ud;
    }
    return null;
  }

  /** Gateways de todas las cuentas superadmin (deduplicado por EUI). */
  listLorawanGatewaysUnifiedForSuperadmin() {
    const byEui = new Map();
    for (const uid of this.listSuperadminUserIds()) {
      for (const g of this.listLorawanGateways(uid)) {
        const eui = String(g.gatewayEui || '')
          .replace(/[^0-9a-fA-F]/g, '')
          .toLowerCase();
        if (eui.length !== 16) continue;
        if (!byEui.has(eui)) byEui.set(eui, { ...g, ownerUserIds: [uid] });
        else {
          const prev = byEui.get(eui);
          if (!prev.ownerUserIds.includes(uid)) prev.ownerUserIds.push(uid);
        }
      }
    }
    return Array.from(byEui.values());
  }

  /**
   * Replica / actualiza un dispositivo en todas las cuentas superadmin (pool unificado).
   * Si ya existía la fila en otra cuenta, se actualizan DevEUI, AppKey, clase, etc.
   */
  syncUserDeviceToSuperadminPool(sourceRow) {
    if (!this._superadminPoolMirrorEnabled()) return;
    if (!sourceRow || !sourceRow.deviceId) return;
    const srcUid = String(sourceRow.userId || '').trim();
    if (!this.isSuperadminUserId(srcUid)) return;
    const nowIso = new Date().toISOString();
    const did = String(sourceRow.deviceId).trim();
    for (const sid of this.listSuperadminUserIds()) {
      if (sid === srcUid) continue;
      const prev = this.getUserDevice(sid, did);
      const merged = {
        ...(prev || {}),
        ...sourceRow,
        id: prev ? prev.id : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        userId: sid,
        deviceId: did,
        displayName: sourceRow.displayName || prev?.displayName || did,
        devEUI: sourceRow.devEUI || prev?.devEUI || '',
        appEui: sourceRow.appEui || prev?.appEui || '',
        appKey: sourceRow.appKey || prev?.appKey || '',
        productModel: sourceRow.productModel || prev?.productModel || '',
        lorawanClass: sourceRow.lorawanClass || prev?.lorawanClass || '',
        deviceSerialHex: sourceRow.deviceSerialHex || prev?.deviceSerialHex || '',
        notes: sourceRow.notes != null ? sourceRow.notes : prev?.notes || '',
        tag: sourceRow.tag != null ? sourceRow.tag : prev?.tag || '',
        createdAt: prev ? prev.createdAt : nowIso,
        updatedAt: nowIso,
      };
      this.upsertUserDevice(merged);
      this.upsertDeviceLabel(sid, did, merged.displayName || did);
    }
  }

  /** Replica un gateway dado de alta por un superadmin al resto del pool (mismo EUI). */
  _superadminPoolMirrorEnabled() {
    const raw = process.env.SYSCOM_SUPERADMIN_POOL_MIRROR;
    if (raw == null || String(raw).trim() === '') return false;
    const v = String(raw).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
  }

  mirrorLorawanGatewayToSuperadminPool(sourceRow) {
    if (!this._superadminPoolMirrorEnabled()) return;
    if (!sourceRow || !sourceRow.gatewayEui) return;
    const srcUid = String(sourceRow.userId || '').trim();
    if (!this.isSuperadminUserId(srcUid)) return;
    const eui = String(sourceRow.gatewayEui).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (eui.length !== 16) return;
    const nowIso = sourceRow.createdAt || new Date().toISOString();
    for (const sid of this.listSuperadminUserIds()) {
      if (sid === srcUid) continue;
      if (this.lorawanGatewayExists(sid, eui)) continue;
      this.insertLorawanGateway({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        userId: sid,
        name: sourceRow.name,
        gatewayEui: eui,
        frequencyBand: sourceRow.frequencyBand,
        createdAt: nowIso,
      });
    }
  }

  /** Actualiza copias del pool superadmin al editar nombre/EUI/banda (incluye cambio de EUI). */
  syncLorawanGatewayEditToSuperadminPool(prevEui, sourceRow) {
    if (!this._superadminPoolMirrorEnabled()) return;
    if (!sourceRow || !sourceRow.gatewayEui) return;
    const srcUid = String(sourceRow.userId || '').trim();
    if (!this.isSuperadminUserId(srcUid)) return;
    const newEui = String(sourceRow.gatewayEui).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (newEui.length !== 16) return;
    const oldEui = String(prevEui || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    for (const sid of this.listSuperadminUserIds()) {
      if (sid === srcUid) continue;
      const byOld = oldEui.length === 16 ? this.lnsGetGatewayByEui(sid, oldEui) : null;
      const byNew = this.lnsGetGatewayByEui(sid, newEui);
      const target = byOld || byNew;
      if (target) {
        this.updateLorawanGateway(target.id, {
          name: sourceRow.name,
          gatewayEui: newEui,
          frequencyBand: sourceRow.frequencyBand,
        });
      } else {
        this.insertLorawanGateway({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          userId: sid,
          name: sourceRow.name,
          gatewayEui: newEui,
          frequencyBand: sourceRow.frequencyBand,
          createdAt: sourceRow.createdAt || new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Sincroniza dispositivos y gateways existentes entre cuentas superadmin (arranque / migración ligera).
   */
  reconcileSuperadminPool() {
    if (!this._superadminPoolMirrorEnabled()) return { devicesMirrored: 0, gatewaysMirrored: 0 };
    const supers = this.listSuperadminUserIds();
    if (supers.length < 2) return { devicesMirrored: 0, gatewaysMirrored: 0 };
    let devicesMirrored = 0;
    let gatewaysMirrored = 0;
    const seenDev = new Set();
    for (const uid of supers) {
      for (const ud of this.listUserDevices(uid)) {
        const key = String(ud.deviceId);
        if (seenDev.has(key)) continue;
        seenDev.add(key);
        const before = supers.filter((s) => this.getUserDevice(s, key)).length;
        this.syncUserDeviceToSuperadminPool(ud);
        const after = supers.filter((s) => this.getUserDevice(s, key)).length;
        if (after > before) devicesMirrored += after - before;
      }
    }
    const seenGw = new Set();
    for (const uid of supers) {
      for (const g of this.listLorawanGateways(uid)) {
        const eui = String(g.gatewayEui).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
        if (seenGw.has(eui)) continue;
        seenGw.add(eui);
        const before = supers.filter((s) => this.lorawanGatewayExists(s, eui)).length;
        this.mirrorLorawanGatewayToSuperadminPool(g);
        const after = supers.filter((s) => this.lorawanGatewayExists(s, eui)).length;
        if (after > before) gatewaysMirrored += after - before;
      }
    }
    return { devicesMirrored, gatewaysMirrored };
  }

  lnsGetSessionByDevAddrGlobal(devAddrHex8) {
    const h = String(devAddrHex8 || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (h.length !== 8) return null;
    const r = this.st.lnsSessionByDevAddrGlobal.get(h);
    const session = this._rowToLnsSession(r);
    if (!session) return null;
    return { userId: session.userId, session };
  }

  lnsGetGatewayByEuiAnyUser(gatewayEuiNorm16) {
    const h = String(gatewayEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (h.length !== 16) return null;
    const r = this.st.lgwGetByEuiGlobal.get(h);
    if (!r) return null;
    return {
      gatewayEui: r.gateway_eui,
      frequencyBand: r.frequency_band,
      name: r.name,
    };
  }

  lnsAllocateDevAddrBuf(userId) {
    for (let i = 0; i < 64; i += 1) {
      const b = crypto.randomBytes(4);
      if (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff && b[3] === 0xff) continue;
      const h = b.toString('hex').toUpperCase();
      if (!this.st.lnsDevAddrTaken.get(userId, h)) return b;
    }
    throw new Error('No se pudo asignar DevAddr');
  }

  _rowToLnsSession(r) {
    if (!r) return null;
    const dc = String(r.device_class || 'A')
      .trim()
      .toUpperCase();
    const deviceClass = dc === 'B' || dc === 'C' ? dc : 'A';
    return {
      userId: r.user_id,
      devEui: r.dev_eui,
      devAddr: r.dev_addr,
      nwkSKey: Buffer.from(r.nwk_s_key, 'hex'),
      appSKey: Buffer.from(r.app_s_key, 'hex'),
      fcntUp: Number(r.fcnt_up),
      fcntDown: Number(r.fcnt_down),
      lastGatewayEui: r.last_gateway_eui || '',
      lastRxTmst: r.last_rx_tmst != null ? Number(r.last_rx_tmst) : null,
      lastRxFreq: r.last_rx_freq != null ? Number(r.last_rx_freq) : null,
      lastRxDatr: r.last_rx_datr || '',
      lastRxCodr: r.last_rx_codr || '',
      lastRxRfch: r.last_rx_rfch != null ? Number(r.last_rx_rfch) : null,
      deviceClass,
      lastUplinkWallMs: r.last_uplink_wall_ms != null ? Number(r.last_uplink_wall_ms) : null,
      classBPingPeriodicity:
        r.class_b_ping_periodicity != null ? Number(r.class_b_ping_periodicity) : -1,
      classBDataRate: r.class_b_data_rate != null ? Number(r.class_b_data_rate) : null,
      rxDelaySec: r.rx_delay_sec != null ? Math.max(1, Math.min(15, Number(r.rx_delay_sec))) : 1,
      pendingMacAck: Number(r.pending_mac_ack || 0) === 1,
      awaitingConfirmedDlAck: Number(r.awaiting_confirmed_dl_ack || 0) === 1,
    };
  }

  lnsGetSessionByDevEui(userId, devEuiNorm16) {
    return this._rowToLnsSession(this.st.lnsSessionByDevEui.get(userId, devEuiNorm16));
  }

  lnsGetSessionByDevAddr(userId, devAddrHex8) {
    const h = String(devAddrHex8 || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    return this._rowToLnsSession(this.st.lnsSessionByDevAddr.get(userId, h));
  }

  /**
   * Fila `user_devices` para operaciones LNS cuando el solicitante no está vinculado (p. ej. superadmin global):
   * primero el propio usuario; si no, la primera cuenta asignada al mismo `device_id`.
   * @param {{ allowUnassignedCross?: boolean }} [opts] si true y no hay fila propia, reutiliza datos de otro asignado (mismo DevEUI/AppKey en BD).
   */
  getUserDeviceForLnsDownlink(requesterUserId, deviceId, opts = {}) {
    const did = String(deviceId || '').trim();
    if (!did) return null;
    const own = this.getUserDevice(requesterUserId, did);
    if (own) return own;
    if (!opts.allowUnassignedCross) return null;
    if (this.isSuperadminUserId(requesterUserId)) {
      const pool = this.getAnyUserDeviceForDeviceId(did);
      if (pool) return pool;
      for (const sid of this.listSuperadminUserIds()) {
        const ud = this.getUserDevice(sid, did);
        if (ud) return ud;
      }
    }
    const uids = this.listUserIdsAssignedToDevice(did);
    for (const uid of uids) {
      const u = String(uid).trim();
      if (u === String(requesterUserId).trim()) continue;
      const ud = this.getUserDevice(u, did);
      if (ud) return ud;
    }
    return null;
  }

  /**
   * `user_id` de la fila `lorawan_lns_sessions` a usar para cifrar/FCnt (puede ser otro asignado si el gateway
   * registró el join bajo esa cuenta).
   * @param {{ allowGlobalSessionFallback?: boolean }} [opts] solo superadmin: última sesión con este DevEUI en el servidor.
   */
  lnsResolveSessionUserIdForDevice(deviceId, requestingUserId, devEuiNorm16, opts = {}) {
    const d = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    const req = String(requestingUserId || '').trim();
    if (d.length !== 16) return req;
    if (this.lnsGetSessionByDevEui(req, d)) return req;
    const did = String(deviceId || '').trim();
    if (opts.allowGlobalSessionFallback && this.isSuperadminUserId(req)) {
      for (const sid of this.listSuperadminUserIds()) {
        if (sid === req) continue;
        if (this.lnsGetSessionByDevEui(sid, d)) return sid;
      }
    }
    for (const uid of this.listUserIdsAssignedToDevice(did)) {
      const u = String(uid).trim();
      if (u === req) continue;
      if (this.lnsGetSessionByDevEui(u, d)) return u;
    }
    if (opts.allowGlobalSessionFallback) {
      try {
        const row = this.db
          .prepare(
            `SELECT user_id FROM lorawan_lns_sessions WHERE dev_eui = ? ORDER BY datetime(updated_at) DESC LIMIT 1`
          )
          .get(d);
        if (row && row.user_id) return String(row.user_id);
      } catch {
        /* ignore */
      }
    }
    return req;
  }

  /**
   * Borra sesión MAC LoRaWAN (NwkSKey/AppSKey/DevAddr) para forzar un nuevo OTAA tras MIC inválido o claves desalineadas.
   * @param {string} userId
   * @param {string} devEuiNorm16 hex 16 chars lower
   * @returns {{ removed: number, devEui: string }}
   */
  lnsDeleteSessionForUserDev(userId, devEuiNorm16) {
    const h = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (h.length !== 16) return { removed: 0, devEui: h };
    try {
      this.lnsDeleteAllDeferredAppDownlinksForDev(String(userId), h);
    } catch {
      /* ignore */
    }
    const info = this.st.lnsSessionDeleteByDevEui.run(String(userId), h);
    return { removed: Number(info.changes || 0), devEui: h };
  }

  lnsUpsertSessionJoin(row) {
    const now = new Date().toISOString();
    const cls = String(row.deviceClass || 'A')
      .trim()
      .toUpperCase();
    const deviceClass = cls === 'B' || cls === 'C' ? cls : 'A';
    const rxDelaySec =
      row.rxDelaySec != null ? Math.max(1, Math.min(15, Number(row.rxDelaySec))) : 1;
    this.st.lnsUpsertSession.run(
      row.userId,
      row.devEui,
      row.devAddr,
      row.nwkSKeyHex,
      row.appSKeyHex,
      -1,
      -1,
      row.lastGatewayEui || null,
      row.lastRxTmst ?? null,
      row.lastRxFreq ?? null,
      row.lastRxDatr || null,
      row.lastRxCodr || null,
      row.lastRxRfch ?? null,
      deviceClass,
      row.lastUplinkWallMs ?? null,
      row.classBPingPeriodicity != null ? row.classBPingPeriodicity : -1,
      row.classBDataRate ?? null,
      rxDelaySec,
      0,
      now
    );
  }

  lnsUpdateSessionAfterUplink(devEuiNorm16, row) {
    const now = new Date().toISOString();
    const pendingMac = row.pendingMacAck ? 1 : 0;
    this.st.lnsUpdateSessionRx.run(
      row.fcntUp,
      row.lastGatewayEui,
      row.lastRxTmst,
      row.lastRxFreq,
      row.lastRxDatr,
      row.lastRxCodr,
      row.lastRxRfch,
      row.lastUplinkWallMs ?? Date.now(),
      pendingMac,
      now,
      row.userId,
      devEuiNorm16
    );
  }

  lnsClearPendingMacAck(userId, devEuiNorm16) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE lorawan_lns_sessions SET pending_mac_ack = 0, updated_at = ? WHERE user_id = ? AND dev_eui = ?'
      )
      .run(now, userId, devEuiNorm16);
  }

  lnsPatchClassBFromMac(userId, devEuiNorm16, periodicity, dataRate) {
    const now = new Date().toISOString();
    this.st.lnsPatchClassBMac.run(periodicity, dataRate, now, userId, devEuiNorm16);
  }

  lnsSyncSessionDeviceClass(userId, devEuiNorm16, lorawanClass) {
    if (lorawanClass == null || String(lorawanClass).trim() === '') return false;
    const cls = String(lorawanClass).trim().toUpperCase();
    const deviceClass = cls === 'B' || cls === 'C' ? cls : 'A';
    const now = new Date().toISOString();
    const n = this.st.lnsSetDeviceClass.run(deviceClass, now, userId, devEuiNorm16);
    return Number(n.changes || 0) > 0;
  }

  /** Fuerza `last_gateway_eui` (p. ej. downlink con `gatewayEui` explícito alineado al GW que hace PULL). */
  lnsPatchSessionLastGateway(userId, devEuiNorm16, gatewayEuiNorm16) {
    const gw = String(gatewayEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    const d = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (gw.length !== 16 || d.length !== 16) return false;
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        'UPDATE lorawan_lns_sessions SET last_gateway_eui = ?, updated_at = ? WHERE user_id = ? AND dev_eui = ?'
      )
      .run(gw, now, String(userId), d);
    return Number(info.changes || 0) > 0;
  }

  lnsSetFcntDown(userId, devEuiNorm16, fcntDown) {
    const now = new Date().toISOString();
    this.st.lnsUpdateFcntDown.run(fcntDown, now, userId, devEuiNorm16);
  }

  /** Tras importar sesión por API: fijar FCnt subido conocido (p. ej. desde otro NS). */
  lnsSetFcntUp(userId, devEuiNorm16, fcntUp) {
    const n = Number(fcntUp);
    if (!Number.isFinite(n) || n < 0) return false;
    const now = new Date().toISOString();
    const h = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (h.length !== 16) return false;
    const info = this.db
      .prepare('UPDATE lorawan_lns_sessions SET fcnt_up = ?, updated_at = ? WHERE user_id = ? AND dev_eui = ?')
      .run(Math.floor(n), now, String(userId), h);
    return Number(info.changes || 0) > 0;
  }

  /**
   * @param {object | null} [txMeta] Si está definido (downlink de aplicación con SYSCOM_LNS_TX_ACK), no confirmar FCnt hasta TX_ACK.
   * @param {{ devEui: string, newFcnt: number, prevFcnt: number, retriesLeft?: number }} txMeta
   */
  /** Descarta Join-Accept pendientes del mismo DevEUI (rejoin con claves nuevas; evita TX de JA obsoleto). */
  lnsCancelPendingJoinAcceptsForDev(userId, devEuiNorm16) {
    const deui = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (deui.length !== 16) return 0;
    const info = this.st.lnsDlCancelPendingJoinForDev.run(String(userId), deui);
    return Number(info.changes || 0);
  }

  lnsEnqueuePullResp(userId, gatewayEuiNorm16, pullRespObj, notBeforeMs, priority, txMeta) {
    const gwKey = normalizeLnsGatewayEuiKey(gatewayEuiNorm16);
    const nb = notBeforeMs != null ? Number(notBeforeMs) : 0;
    const pr = priority != null ? Math.max(0, Math.min(255, Math.floor(Number(priority)))) : 0;
    const ts = Date.now();
    const joinCommit = txMeta && txMeta.joinSessionCommit ? txMeta.joinSessionCommit : null;
    const joinJson = joinCommit ? JSON.stringify(joinCommit) : null;
    /** Solo join o downlink app con seguimiento explícito (`newFcnt`); `devEui` en fila siempre si viene en meta. */
    const track =
      txMeta && (joinCommit || (txMeta.devEui && txMeta.newFcnt != null)) ? 1 : 0;
    let deui = null;
    let nfc = null;
    let pfc = null;
    let retr = null;
    let isConf = 0;
    if (txMeta && txMeta.devEui) {
      deui = String(txMeta.devEui || (joinCommit && joinCommit.upsert && joinCommit.upsert.devEui) || '');
    }
    if (track) {
      nfc = joinCommit ? null : txMeta.newFcnt != null ? Number(txMeta.newFcnt) : null;
      pfc = joinCommit ? null : txMeta.prevFcnt != null ? Number(txMeta.prevFcnt) : null;
      retr =
        txMeta.retriesLeft != null
          ? Math.max(0, Math.floor(Number(txMeta.retriesLeft)))
          : Math.max(0, parseInt(process.env.SYSCOM_LNS_TX_ACK_MAX_RETRIES || '3', 10) || 3);
      isConf = joinCommit ? 0 : txMeta.confirmedDown ? 1 : 0;
    }
    this.st.lnsDlInsert.run(
      userId,
      gwKey,
      JSON.stringify(pullRespObj),
      ts,
      nb,
      pr,
      track,
      deui,
      nfc,
      pfc,
      retr,
      isConf,
      joinJson
    );
  }

  lnsDequeuePullResp(gatewayEuiNorm16) {
    const now = Date.now();
    const gwKey = normalizeLnsGatewayEuiKey(gatewayEuiNorm16);
    const r = this.st.lnsDlDequeue.get(gwKey, now);
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      json: r.pull_resp_json,
      trackTxAck: Number(r.track_tx_ack) === 1,
      joinSessionJson: r.join_session_json || null,
      txDevEui: r.tx_dev_eui || null,
      txNewFcnt: r.tx_new_fcnt != null ? Number(r.tx_new_fcnt) : null,
      txPrevFcnt: r.tx_prev_fcnt != null ? Number(r.tx_prev_fcnt) : null,
      txRetriesLeft: r.tx_retries_left != null ? Number(r.tx_retries_left) : null,
      priority: r.priority != null ? Number(r.priority) : 0,
      notBeforeMs: r.not_before_ms != null ? Number(r.not_before_ms) : 0,
    };
  }

  lnsMarkPullRespSent(id) {
    this.st.lnsDlSent.run('sent', id);
  }

  lnsPullRespEnterAwaitTxAck(downlinkId, gatewayEuiNorm16, tokenH, tokenL) {
    const gwKey = normalizeLnsGatewayEuiKey(gatewayEuiNorm16);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.st.lnsDlAwaitTxAck.run(downlinkId);
      this.st.lnsTxInflightInsert.run(gwKey, tokenH, tokenL, downlinkId, Date.now());
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  /**
   * GW_TX_ACK huérfano (p. ej. SYSCOM_LNS_TX_ACK=0): reencola el último PULL_RESP enviado tras TOO_EARLY/TOO_LATE.
   * @param {string} gatewayEuiNorm16
   * @param {string} error
   */
  lnsRetryOrphanTxAck(gatewayEuiNorm16, error) {
    if (String(process.env.SYSCOM_LNS_ORPHAN_TX_ACK_RETRY || '1').trim() === '0') return;
    const errUp = String(error || '').toUpperCase();
    if (!errUp.includes('TOO_EARLY') && !errUp.includes('TOO_LATE')) return;
    const gwKey = normalizeLnsGatewayEuiKey(gatewayEuiNorm16);
    this.lnsMarkGwForceClassCImme(gwKey);
    const now = Date.now();
    const minGap = Math.max(
      2000,
      parseInt(String(process.env.SYSCOM_LNS_ORPHAN_ACK_RETRY_GAP_MS || '2800').trim(), 10) || 2800
    );
    const gapKey = `orph:${gwKey}`;
    if ((this._orphanAckRetryAt.get(gapKey) || 0) + minGap > now) return;
    this._orphanAckRetryAt.set(gapKey, now);

    const pending = this.db
      .prepare(
        `SELECT 1 AS x FROM lorawan_lns_downlink
         WHERE lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) = ?
           AND status IN ('pending','await_tx_ack') LIMIT 1`
      )
      .get(gwKey);
    if (pending) return;

    const lookbackMs = Math.max(
      5000,
      parseInt(String(process.env.SYSCOM_LNS_ORPHAN_ACK_LOOKBACK_MS || '25000').trim(), 10) || 25000
    );
    const row = this.db
      .prepare(
        `SELECT id, user_id, gateway_eui, pull_resp_json, tx_dev_eui, priority
         FROM lorawan_lns_downlink
         WHERE lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) = ?
           AND status = 'sent' AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(gwKey, now - lookbackMs);
    if (!row || !row.pull_resp_json) return;

    let pullJson = String(row.pull_resp_json);
    try {
      const pullObj = JSON.parse(pullJson);
      const tx = pullObj && pullObj.txpk;
      if (tx && typeof tx === 'object') {
        tx.imme = true;
        delete tx.tmst;
        pullJson = JSON.stringify(pullObj);
      }
    } catch {
      /* keep original */
    }

    const deui = String(row.tx_dev_eui || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    const maxRetries = Math.max(
      0,
      parseInt(String(process.env.SYSCOM_LNS_ORPHAN_ACK_MAX_RETRIES || '3').trim(), 10) || 3
    );
    const retryKey = `${gwKey}:${deui.length === 16 ? deui : 'any'}`;
    const used = this._orphanAckRetryCount.get(retryKey) || 0;
    if (used >= maxRetries) return;
    this._orphanAckRetryCount.set(retryKey, used + 1);

    const rawClassGap = parseInt(String(process.env.SYSCOM_LNS_CLASS_C_TX_GAP_MS || '2800').trim(), 10);
    const classCGapMs = Number.isFinite(rawClassGap) ? Math.max(0, rawClassGap) : 2800;
    const timingExtra = errUp.includes('TOO_EARLY')
      ? parseInt(String(process.env.SYSCOM_LNS_TX_ACK_TOO_EARLY_EXTRA_MS || '1200').trim(), 10) || 1200
      : parseInt(String(process.env.SYSCOM_LNS_TX_ACK_TOO_LATE_EXTRA_MS || '900').trim(), 10) || 900;
    const delayMs = classCGapMs + Math.max(0, timingExtra);
    const pr = row.priority != null ? Math.max(0, Math.min(255, Math.floor(Number(row.priority)))) : 0;
    this.st.lnsDlInsert.run(
      row.user_id,
      gwKey,
      pullJson,
      now,
      now + delayMs,
      pr,
      0,
      deui.length === 16 ? deui : null,
      null,
      null,
      null,
      0,
      null
    );
    console.warn(
      '[LNS] GW_TX_ACK huérfano',
      error,
      '→ reencolado DL',
      deui.length === 16 ? deui : '(join/mac)',
      'en',
      delayMs,
      'ms (intento',
      used + 1,
      '/',
      maxRetries,
      ')'
    );
  }

  _lnsTxAckIsSuccess(txpkAck) {
    if (txpkAck == null || typeof txpkAck !== 'object') return true;
    const e = txpkAck.error;
    if (e == null || e === '') return true;
    return String(e).toUpperCase() === 'NONE';
  }

  /**
   * Compatibilidad con ejemplos que parsean `txpk_ack` como JSON suelto.
   * En **Semtech GWMP** el ACK va en el paquete UDP **0x05** (GW_TX_ACK) con token de correlación → `lnsHandleGatewayTxAck`.
   * @param {string} gatewayEuiNorm
   * @param {string} error
   * @param {object} [ack]
   */
  lnsHandleTxAck(gatewayEuiNorm, error, ack) {
    console.warn(
      '[LNS-STORE] lnsHandleTxAck: sin token GWMP no hay correlación fiable. gateway=',
      normalizeLnsGatewayEuiKey(gatewayEuiNorm),
      'error=',
      error,
      'ack=',
      ack != null && typeof ack === 'object' ? JSON.stringify(ack) : ack,
      '— El UG65 envía `txpk_ack` dentro del paquete UDP **0x05** (GW_TX_ACK); no como JSON raíz del datagrama. Si el token no cuadra con la BD, pruebe SYSCOM_LNS_TX_ACK_MATCH_LATEST_INFLIGHT=1 (un solo downlink pendiente por GW).'
    );
  }

  /**
   * GW_TX_ACK del packet forwarder Semtech (mismo token que el PULL_RESP).
   * @param {string|null} gwNorm
   * @param {Buffer} tokenBuf 2 bytes
   * @param {object} json
   */
  /** Por defecto activo: UG65 a veces ACK con token distinto; correlaciona el último inflight del GW. `=0` para desactivar. */
  _lnsTxAckMatchLatestInflightEnabled() {
    const raw = process.env.SYSCOM_LNS_TX_ACK_MATCH_LATEST_INFLIGHT;
    if (raw != null && String(raw).trim() !== '') {
      const v = String(raw).trim().toLowerCase();
      return v !== '0' && v !== 'false' && v !== 'off';
    }
    return true;
  }

  lnsHandleGatewayTxAck(gwNorm, tokenBuf, json) {
    if (!gwNorm || !tokenBuf || tokenBuf.length < 2) return;
    const nGw = normalizeLnsGatewayEuiKey(gwNorm);
    const th = tokenBuf[0];
    const tl = tokenBuf[1];
    const txpkAck = json && json.txpk_ack;
    const errRaw = txpkAck && txpkAck.error != null ? String(txpkAck.error) : '';
    const hasRejection = errRaw !== '' && errRaw.toUpperCase() !== 'NONE';

    let row = this.st.lnsTxInflightSelectJoin.get(nGw, th, tl);
    let ackMatchMode = 'token';
    if (!row && this._lnsTxAckMatchLatestInflightEnabled()) {
      row = this.st.lnsTxInflightSelectLatestAwaitAppByGw.get(nGw);
      if (row) {
        ackMatchMode = 'latest_inflight';
        console.warn(
          '[LNS-UDP] GW_TX_ACK correlacionado por último inflight (SYSCOM_LNS_TX_ACK_MATCH_LATEST_INFLIGHT=1); token GW no coincidió con BD. tok=',
          th,
          tl,
          'gw=',
          nGw
        );
      }
    }
    if (!row) {
      const hasTxpk = json && json.txpk_ack != null;
      if (hasRejection || hasTxpk || (json && Object.keys(json).length > 0)) {
        console.warn(
          '[LNS-UDP] GW_TX_ACK sin fila inflight:',
          'err=',
          errRaw || '(vacío/NONE)',
          'body=',
          JSON.stringify(json || {}),
          'gw=',
          nGw,
          'token=',
          th,
          tl,
          '— Revise EUI del gateway, SYSCOM_LNS_PULL_BURST=1, o SYSCOM_LNS_TX_ACK_MATCH_LATEST_INFLIGHT=1 (un downlink pendiente por GW).'
        );
      }
      if (hasRejection) {
        try {
          this.lnsRetryOrphanTxAck(nGw, errRaw);
        } catch (eOrph) {
          console.warn('[store] lnsRetryOrphanTxAck:', eOrph.message);
        }
        if (typeof this._lnsGatewayTxFailHook === 'function') {
          try {
            this._lnsGatewayTxFailHook({
              gatewayEui: nGw,
              error: errRaw,
              devEui: null,
              userId: null,
              orphan: true,
            });
          } catch (e) {
            console.warn('[store] _lnsGatewayTxFailHook:', e.message);
          }
        }
      }
      return;
    }
    if (ackMatchMode !== 'token' && String(process.env.SYSCOM_LNS_LOG_TX_ACK || '').trim() === '1') {
      console.log('[LNS-UDP] GW_TX_ACK modo correlación:', ackMatchMode);
    }

    const ok = this._lnsTxAckIsSuccess(txpkAck);
    const inflightId = row.inflight_id;
    const baseRetryMs = Math.max(0, parseInt(process.env.SYSCOM_LNS_TX_ACK_RETRY_MS || '750', 10) || 750);
    const errUp = errRaw.toUpperCase();
    const isTooLate = errUp.includes('TOO_LATE');
    const isTooEarly = errUp.includes('TOO_EARLY');
    const timingExtraMs = Math.max(
      0,
      isTooLate ? parseInt(process.env.SYSCOM_LNS_TX_ACK_TOO_LATE_EXTRA_MS || '900', 10) || 900 : 0,
      isTooEarly ? parseInt(process.env.SYSCOM_LNS_TX_ACK_TOO_EARLY_EXTRA_MS || '900', 10) || 900 : 0
    );
    const rawClassGap = parseInt(String(process.env.SYSCOM_LNS_CLASS_C_TX_GAP_MS || '2200').trim(), 10);
    const classCGapMs = Number.isFinite(rawClassGap) ? Math.max(0, rawClassGap) : 2200;
    let delayMs = baseRetryMs + timingExtraMs;
    const joinSessionRaw = row.join_session_json != null ? String(row.join_session_json).trim() : '';
    let isJoinAcceptDl = Boolean(joinSessionRaw);
    if (!isJoinAcceptDl && row.pull_resp_json) {
      try {
        isJoinAcceptDl = pullRespJsonIsJoinAccept(row.pull_resp_json);
      } catch {
        /* ignore */
      }
    }
    if (!isJoinAcceptDl && Number(row.priority) === 255 && row.tx_new_fcnt == null) {
      isJoinAcceptDl = true;
    }
    /**
     * TOO_LATE / TOO_EARLY en downlinks app: hueco clase C.
     * Join-Accept OTAA: reintento corto (tmst se recalcula al enviar; no aplicar cola clase C).
     */
    if (!ok && (isTooLate || isTooEarly) && !isJoinAcceptDl) {
      delayMs = Math.max(delayMs, classCGapMs + baseRetryMs);
    }

    /** @type {null | { userId: string, devEui: string, ok: boolean, error?: string|null, fCnt?: number|null, gatewayEui?: string|null, timeout?: boolean }} */
    let txAckOutcome = null;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.st.lnsTxInflightDelete.run(inflightId);
      if (ok) {
        const joinJson = row.join_session_json != null ? String(row.join_session_json).trim() : '';
        if (joinJson) {
          try {
            const jp = JSON.parse(joinJson);
            if (jp.upsert) this.lnsUpsertSessionJoin(jp.upsert);
            if (jp.telemetry) {
              const t = jp.telemetry;
              this.appendTelemetry(
                row.user_id,
                String(t.deviceId || ''),
                t.deviceName != null ? String(t.deviceName) : null,
                t.properties && typeof t.properties === 'object' ? t.properties : {},
                t.ts != null ? Number(t.ts) : Date.now()
              );
            }
          } catch (e) {
            console.warn('[LNS] join_session_json tras TX_ACK:', e.message);
          }
        } else if (Number(row.track_tx_ack) === 1 && row.tx_dev_eui && row.tx_new_fcnt != null) {
          this.lnsSetFcntDown(row.user_id, row.tx_dev_eui, Number(row.tx_new_fcnt));
          if (Number(row.is_confirmed_down) === 1) {
            this.lnsMarkAwaitingConfirmedDeviceAck(row.user_id, row.tx_dev_eui);
          }
        }
        this.st.lnsDlDeleteById.run(row.downlink_id);
        if (!joinJson && Number(row.track_tx_ack) === 1 && row.tx_dev_eui) {
          const deui = String(row.tx_dev_eui)
            .replace(/[^0-9a-fA-F]/g, '')
            .toLowerCase();
          if (deui.length === 16) {
            txAckOutcome = {
              userId: String(row.user_id),
              devEui: deui,
              ok: true,
              error: null,
              fCnt: row.tx_new_fcnt != null ? Number(row.tx_new_fcnt) : null,
              gatewayEui: String(row.gateway_eui || nGw || ''),
              timeout: false,
            };
          }
        }
      } else {
        const errName = txpkAck && txpkAck.error != null ? String(txpkAck.error) : 'UNKNOWN';
        const errN = errName.toUpperCase();
        const timingHint =
          errN.includes('TOO_LATE') || errN.includes('TOO_EARLY')
            ? '→ Clase C / imme: suba SYSCOM_LNS_CLASS_C_TX_GAP_MS (p. ej. 1500–2000), opc. SYSCOM_LNS_CLASS_C_USE_GATEWAY_TMST=1, o SYSCOM_LNS_TX_RFCH_IMME_US915=0|1.'
            : '';
        console.warn(
          '[LNS-UDP] TX_ACK rechazado:',
          errName,
          'txpk_ack=',
          JSON.stringify(txpkAck || {}),
          'gw=',
          nGw,
          'dev=',
          row.tx_dev_eui,
          timingHint
        );
        if (errN.includes('TOO_EARLY') || errN.includes('TOO_LATE')) {
          this.lnsMarkGwForceClassCImme(nGw);
        }
        if (typeof this._lnsGatewayTxFailHook === 'function') {
          try {
            this._lnsGatewayTxFailHook({
              gatewayEui: nGw,
              error: errName,
              devEui: row.tx_dev_eui || null,
              userId: row.user_id || null,
              orphan: false,
            });
          } catch (e) {
            console.warn('[store] _lnsGatewayTxFailHook:', e.message);
          }
        }
        const retries = (row.tx_retries_left != null ? Number(row.tx_retries_left) : 0) - 1;
        this.st.lnsDlDeleteById.run(row.downlink_id);
        const willRequeue = Number(row.track_tx_ack) === 1 && retries > 0;
        if (willRequeue) {
          const pr = row.priority != null ? Math.max(0, Math.min(255, Math.floor(Number(row.priority)))) : 0;
          const now = Date.now();
          const ic = Number(row.is_confirmed_down) === 1 ? 1 : 0;
          this.st.lnsDlInsert.run(
            row.user_id,
            row.gateway_eui,
            row.pull_resp_json,
            now,
            now + delayMs,
            pr,
            1,
            row.tx_dev_eui,
            row.tx_new_fcnt,
            row.tx_prev_fcnt,
            retries,
            ic,
            row.join_session_json || null
          );
        }
        /** Fallo definitivo: ya se notifica vía `gateway_tx_rejected` (hook); no duplicar con `downlink_gateway_ack`. */
      }
      this.db.exec('COMMIT');
      if (txAckOutcome) this._emitLnsTxAckOutcome(txAckOutcome);
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      console.error('[LNS-UDP] TX_ACK DB:', e.message);
    }
  }

  /**
   * Gateways que no envían GW_TX_ACK dejan `await_tx_ack` + `lorawan_lns_tx_inflight` sin correlación.
   * Borra esas filas tras `SYSCOM_LNS_TX_ACK_TIMEOUT_MS` o `SYSCOM_LNS_TX_ACK_SILENCE_MS` (defecto **5 s**), sin avanzar FCnt.
   * @returns {Array<{ userId: string, devEui: string, gatewayEui: string, fCnt: number|null }>}
   */
  lnsPruneStaleAppDownlinkTxAckInflight() {
    const silenceMs = readLnsTxAckPruneSilenceMs();
    const cutoff = Date.now() - silenceMs;
    const rows = this.db
      .prepare(
        `SELECT d.id AS downlink_id, d.user_id, d.tx_dev_eui, d.gateway_eui, d.tx_new_fcnt
         FROM lorawan_lns_downlink d
         INNER JOIN lorawan_lns_tx_inflight i ON i.downlink_id = d.id
         WHERE d.track_tx_ack = 1
           AND d.status = 'await_tx_ack'
           AND (d.join_session_json IS NULL OR trim(d.join_session_json) = '')
           AND i.created_at < ?`
      )
      .all(cutoff);
    if (!rows.length) return [];
    const out = [];
    for (const r of rows) {
      const downlinkId = Number(r.downlink_id);
      if (!Number.isFinite(downlinkId) || downlinkId <= 0) continue;
      const deui = String(r.tx_dev_eui || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toLowerCase();
      if (deui.length !== 16) continue;
      try {
        this.db.exec('BEGIN IMMEDIATE');
        const still = this.db
          .prepare(
            `SELECT 1 FROM lorawan_lns_downlink d
             INNER JOIN lorawan_lns_tx_inflight i ON i.downlink_id = d.id
             WHERE d.id = ? AND d.status = 'await_tx_ack' AND i.created_at < ?`
          )
          .get(downlinkId, cutoff);
        if (!still) {
          this.db.exec('ROLLBACK');
          continue;
        }
        this.db.prepare('DELETE FROM lorawan_lns_tx_inflight WHERE downlink_id = ?').run(downlinkId);
        this.db.prepare("DELETE FROM lorawan_lns_downlink WHERE id = ? AND status = 'await_tx_ack'").run(downlinkId);
        this.db.exec('COMMIT');
        out.push({
          userId: String(r.user_id),
          devEui: deui,
          gatewayEui: String(r.gateway_eui || ''),
          fCnt: r.tx_new_fcnt != null ? Number(r.tx_new_fcnt) : null,
        });
      } catch (e) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        console.warn('[LNS] prune stale TX_ACK inflight:', e.message);
      }
    }
    if (out.length) {
      console.warn(
        '[LNS] Liberados',
        out.length,
        'downlink(s) en await_tx_ack sin GW_TX_ACK en',
        silenceMs,
        'ms (SYSCOM_LNS_TX_ACK_TIMEOUT_MS o SYSCOM_LNS_TX_ACK_SILENCE_MS). Si el GW sí transmite, use SYSCOM_LNS_APP_DOWNLINK_TX_ACK=0.'
      );
      for (const o of out) {
        this._emitLnsTxAckOutcome({
          userId: o.userId,
          devEui: o.devEui,
          ok: false,
          error: 'TIMEOUT_NO_GW_TX_ACK',
          fCnt: o.fCnt,
          gatewayEui: o.gatewayEui,
          timeout: true,
        });
      }
    }
    return out;
  }

  /** Evita dos downlinks de aplicación con el mismo FCnt mientras uno espera TX_ACK. */
  lnsHasTrackedDownlinkPendingForDev(userId, devEuiNorm16) {
    const d = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (d.length !== 16) return false;
    const r = this.st.lnsHasTrackedDlForDev.get(String(userId || '').trim(), d);
    return Boolean(r);
  }

  /**
   * Elimina colas `track_tx_ack` de **aplicación** huérfanas (sin join_session_json) para este DevEUI.
   * - `pending`: aún no salieron en PULL_RESP.
   * - `await_tx_ack` **fantasma**: sin fila en `lorawan_lns_tx_inflight` (reinicio del proceso, ACK nunca correlacionado) → libera el bloqueo en el **primer** intento.
   * - `await_tx_ack` antiguo: supera `SYSCOM_LNS_PRUNE_AWAIT_TX_ACK_MS` (ms; defecto **3 min**).
   * @returns {number} filas borradas en lorawan_lns_downlink
   */
  lnsPruneAbandonedTrackedAppDownlinksForDev(userId, devEuiNorm16) {
    const d = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (d.length !== 16) return 0;
    const uid = String(userId || '').trim();
    const staleAwaitMs = Math.max(
      60_000,
      parseInt(process.env.SYSCOM_LNS_PRUNE_AWAIT_TX_ACK_MS || '180000', 10) || 180000
    );
    const cutoff = Date.now() - staleAwaitMs;
    const rows = this.db
      .prepare(
        `SELECT d.id FROM lorawan_lns_downlink d
         WHERE d.user_id = ? AND lower(replace(replace(replace(ifnull(d.tx_dev_eui,''),':',''),'-',''),' ','')) = ?
           AND d.track_tx_ack = 1
           AND (d.join_session_json IS NULL OR trim(d.join_session_json) = '')
           AND (
             d.status = 'pending'
             OR (d.status = 'await_tx_ack' AND d.created_at < ?)
             OR (
               d.status = 'await_tx_ack'
               AND NOT EXISTS (SELECT 1 FROM lorawan_lns_tx_inflight i WHERE i.downlink_id = d.id)
             )
           )`
      )
      .all(uid, d, cutoff);
    const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return 0;
    const ph = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM lorawan_lns_tx_inflight WHERE downlink_id IN (${ph})`).run(...ids);
    const info = this.db.prepare(`DELETE FROM lorawan_lns_downlink WHERE id IN (${ph})`).run(...ids);
    return Number(info.changes || 0);
  }

  lnsDeferAppDownlinkTtlMs() {
    const n = parseInt(process.env.SYSCOM_LNS_DEFER_APP_DOWNLINK_TTL_MS || '', 10);
    return Number.isFinite(n) && n > 60_000 ? n : 7 * 24 * 60 * 60 * 1000;
  }

  lnsDeferAppDownlinkMaxPerDev() {
    const n = parseInt(process.env.SYSCOM_LNS_DEFER_APP_DOWNLINK_MAX || '', 10);
    return Number.isFinite(n) && n > 0 ? Math.min(256, n) : 32;
  }

  /**
   * Encola un downlink de aplicación en SQLite hasta el próximo uplink (ventana clase A / tmst / GW).
   * @returns {{ ok: true, id: number, queueLength: number } | { ok: false, reason: string, queueLength?: number }}
   */
  lnsInsertDeferredAppDownlink(userId, devEuiNorm16, fPort, payloadHexLower, opts) {
    const uid = String(userId || '').trim();
    const deui = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (!uid || deui.length !== 16) return { ok: false, reason: 'BAD_ARGS' };
    const hex = String(payloadHexLower || '')
      .replace(/\s/g, '')
      .toLowerCase();
    if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return { ok: false, reason: 'BAD_HEX' };
    const fp = Math.floor(Number(fPort));
    if (!Number.isFinite(fp) || fp < 1 || fp > 223) return { ok: false, reason: 'BAD_FPORT' };
    const o = opts || {};
    const cut = Date.now() - this.lnsDeferAppDownlinkTtlMs();
    this.st.lnsDefDlPruneOldForDev.run(uid, deui, cut);
    const cRow = this.st.lnsDefDlCount.get(uid, deui);
    const count = cRow && cRow.n != null ? Number(cRow.n) : 0;
    const max = this.lnsDeferAppDownlinkMaxPerDev();
    if (count >= max) return { ok: false, reason: 'QUEUE_FULL', queueLength: count };
    const conf = o.confirmed ? 1 : 0;
    const pri = o.priority != null ? Math.max(0, Math.min(255, Math.floor(Number(o.priority)))) : 0;
    const dly = o.delayMs != null ? Math.max(0, Math.floor(Number(o.delayMs))) : 0;
    let gw = String(o.gatewayEui || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (gw.length !== 16) gw = '';
    let dc = String(o.deviceClass || 'A')
      .trim()
      .toUpperCase();
    if (dc !== 'B' && dc !== 'C') dc = 'A';
    const now = Date.now();
    const info = this.st.lnsDefDlInsert.run(uid, deui, fp, hex, conf, pri, dly, gw, dc, now);
    const id = Number(info.lastInsertRowid);
    return { ok: true, id, queueLength: count + 1 };
  }

  lnsPeekOldestDeferredAppDownlink(userId, devEuiNorm16) {
    const uid = String(userId || '').trim();
    const deui = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (!uid || deui.length !== 16) return null;
    const r = this.st.lnsDefDlPeekOldest.get(uid, deui);
    if (!r) return null;
    return {
      id: Number(r.id),
      userId: r.user_id,
      devEui: r.dev_eui,
      fPort: Number(r.f_port),
      payloadHex: String(r.payload_hex || '').toLowerCase(),
      confirmed: Number(r.confirmed) === 1,
      priority: r.priority != null ? Number(r.priority) : 0,
      delayMs: r.delay_ms != null ? Number(r.delay_ms) : 0,
      gatewayEui: String(r.gateway_eui || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toLowerCase(),
      deviceClass: String(r.device_class || 'A').toUpperCase(),
      createdAt: r.created_at != null ? Number(r.created_at) : 0,
    };
  }

  lnsDeleteDeferredAppDownlinkById(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const info = this.st.lnsDefDlDeleteById.run(n);
    return Number(info.changes || 0);
  }

  lnsDeleteAllDeferredAppDownlinksForDev(userId, devEuiNorm16) {
    const uid = String(userId || '').trim();
    const deui = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (!uid || deui.length !== 16) return 0;
    const info = this.st.lnsDefDlDeleteForDev.run(uid, deui);
    return Number(info.changes || 0);
  }

  /**
   * Borra downlinks de aplicación pendientes (PULL_RESP aún no confirmados) para este DevEUI.
   * Útil antes de reajustar `fcnt_down` si la cola quedó bloqueada o desincronizada.
   * @returns {number} filas borradas en lorawan_lns_downlink
   */
  lnsDeletePendingAppDownlinksForDev(userId, devEuiNorm16) {
    const d = String(devEuiNorm16 || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (d.length !== 16) return 0;
    const uid = String(userId || '').trim();
    const rows = this.db
      .prepare(
        `SELECT id FROM lorawan_lns_downlink
         WHERE user_id = ? AND lower(replace(replace(replace(tx_dev_eui,':',''),'-',''),' ','')) = ?
           AND status IN ('pending','await_tx_ack')
           AND (join_session_json IS NULL OR trim(join_session_json) = '')`
      )
      .all(uid, d);
    const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return 0;
    const ph = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM lorawan_lns_tx_inflight WHERE downlink_id IN (${ph})`).run(...ids);
    const info = this.db.prepare(`DELETE FROM lorawan_lns_downlink WHERE id IN (${ph})`).run(...ids);
    return Number(info.changes || 0);
  }

  lnsInsertUiEvent(userId, devEuiNorm16, eventType, metaJson) {
    const now = Date.now();
    const info = this.st.lnsUiEventInsert.run(
      userId,
      String(devEuiNorm16 || '').toLowerCase(),
      String(eventType),
      metaJson != null ? String(metaJson) : null,
      now
    );
    return Number(info?.lastInsertRowid) || 0;
  }

  lnsListUiEventsSince(userId, sinceMs) {
    const t = sinceMs != null ? Number(sinceMs) : 0;
    return this.st.lnsUiEventListSince.all(userId, t).map((r) => ({
      id: r.id,
      devEui: r.dev_eui,
      eventType: r.event_type,
      meta: r.meta_json ? JSON.parse(r.meta_json) : null,
      createdAt: r.created_at,
    }));
  }

  lnsListUiEventsAfterId(userId, afterId) {
    const id = afterId != null ? Math.max(0, Math.floor(Number(afterId))) : 0;
    return this.st.lnsUiEventListAfterId.all(userId, id).map((r) => ({
      id: r.id,
      devEui: r.dev_eui,
      eventType: r.event_type,
      meta: r.meta_json ? JSON.parse(r.meta_json) : null,
      createdAt: r.created_at,
    }));
  }

  lnsMarkAwaitingConfirmedDeviceAck(userId, devEuiNorm16) {
    const now = new Date().toISOString();
    this.st.lnsSetAwaitingConfirmedDl.run(now, userId, devEuiNorm16);
  }

  lnsClearAwaitingConfirmedDeviceAck(userId, devEuiNorm16) {
    const now = new Date().toISOString();
    this.st.lnsClearAwaitingConfirmedDl.run(now, userId, devEuiNorm16);
  }

  /** Usuarios con fila en `user_devices` para este `device_id` (propagar clase/decoder). */
  listUserIdsAssignedToDevice(deviceId) {
    const did = String(deviceId || '').trim();
    if (!did) return [];
    return this.st.udUserIdsForDevice.all(did).map((row) => String(row.user_id));
  }

  getUserDevice(userId, deviceId) {
    const r = this.st.udGet.get(userId, String(deviceId));
    if (!r) return null;
    return this._rowToUserDeviceRecord(r);
  }

  /** Misma cuenta: buscar fila por DevEUI normalizado (16 hex), p. ej. uplink LNS con deviceId = DevEUI. */
  getUserDeviceByDevEuiNorm(userId, eui16Lower) {
    const h = String(eui16Lower || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (h.length !== 16) return null;
    const r = this.st.udGetByUserDevEuiNorm.get(userId, h);
    if (!r) return null;
    return this._rowToUserDeviceRecord(r);
  }

  listUserDevices(userId) {
    if (userId === undefined || userId === null) return [];
    const uid = String(userId).trim();
    if (!uid) return [];
    return this.st.udList.all(uid).map((r) => this._rowToUserDeviceRecord(r));
  }

  /**
   * Actualiza Join EUI / AppKey del dispositivo (OTAA en el LNS integrado).
   * @param {{ appEui?: string, appKey?: string }} patch Use cadenas vacías para borrar un campo.
   * @returns {{ ok: boolean, error?: string }}
   */
  patchUserDeviceLoraCredentials(userId, deviceId, patch) {
    const did = String(deviceId || '').trim();
    const uid = String(userId || '').trim();
    if (!did || !uid) return { ok: false, error: 'missing_ids' };
    const ud = this.getUserDevice(uid, did);
    if (!ud) return { ok: false, error: 'not_found' };
    const p = patch && typeof patch === 'object' ? patch : {};
    let nextAppEui = ud.appEui || '';
    let nextAppKey = ud.appKey || '';
    if (p.appEui !== undefined) {
      const ae = String(p.appEui || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toUpperCase();
      if (ae.length > 0 && ae.length !== 16) return { ok: false, error: 'app_eui_invalid' };
      nextAppEui = ae;
    }
    if (p.appKey !== undefined) {
      const ak = String(p.appKey || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toLowerCase();
      if (ak.length > 0 && ak.length !== 32) return { ok: false, error: 'app_key_invalid' };
      nextAppKey = ak;
    }
    const nowIso = new Date().toISOString();
    this.upsertUserDevice({
      ...ud,
      appEui: nextAppEui,
      appKey: nextAppKey,
      updatedAt: nowIso,
    });
    return { ok: true };
  }

  upsertUserDevice(row) {
    let lorawanClass = null;
    if (row.lorawanClass != null && String(row.lorawanClass).trim() !== '') {
      const u = String(row.lorawanClass).trim().toUpperCase();
      lorawanClass = u === 'B' || u === 'C' ? u : 'A';
    }
    const serialHex =
      row.deviceSerialHex != null && String(row.deviceSerialHex).trim() !== ''
        ? String(row.deviceSerialHex).replace(/[^0-9a-fA-F]/gi, '')
        : null;

    const productModel =
      row.productModel != null && String(row.productModel).trim() !== ''
        ? String(row.productModel).trim().slice(0, 200)
        : '';
    let permJson = null;
    if (row.replaceAssignmentPermissions) {
      permJson = deviceAssignPerm.toJson(row.assignmentPermissions);
    }
    this.st.udUpsert.run(
      row.id,
      row.userId,
      row.deviceId,
      row.displayName,
      row.devEUI || '',
      row.notes || '',
      row.appEui || '',
      row.appKey || '',
      row.tag || '',
      productModel,
      lorawanClass || null,
      serialHex,
      row.createdAt,
      row.updatedAt,
      permJson
    );
  }

  _emptyDeviceDecodeConfig(deviceId) {
    return {
      deviceId: String(deviceId),
      decoderScript: '',
      channel: '',
      lorawanClass: '',
      productModel: '',
      updatedAt: null,
    };
  }

  _rowToDeviceDecodeConfig(r) {
    return {
      deviceId: r.device_id,
      decoderScript: r.decoder_script || '',
      channel: r.channel || '',
      lorawanClass: r.lorawan_class || '',
      productModel: r.product_model != null ? String(r.product_model) : '',
      updatedAt: r.updated_at,
    };
  }

  getDeviceDecodeConfig(deviceId) {
    const r = this.st.decodeGet.get(String(deviceId));
    if (!r) return this._emptyDeviceDecodeConfig(deviceId);
    return this._rowToDeviceDecodeConfig(r);
  }

  /** Mapa deviceId → decode config (una consulta por lote; evita N+1 en listado). */
  getDeviceDecodeConfigMap(deviceIds) {
    const ids = [...new Set((deviceIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
    const map = {};
    for (const id of ids) {
      map[id] = this._emptyDeviceDecodeConfig(id);
    }
    if (!ids.length) return map;
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT device_id, decoder_script, channel, lorawan_class, product_model, updated_at FROM device_decode_config WHERE device_id IN (${placeholders})`
        )
        .all(...chunk);
      for (const r of rows) {
        map[r.device_id] = this._rowToDeviceDecodeConfig(r);
      }
    }
    return map;
  }

  _licenseMetaFromRow(r) {
    const now = Date.now();
    const expMs = parseIsoOrEpochMsToMs(r.expires_at);
    if (!Number.isFinite(expMs)) {
      return {
        startedAt: r.started_at,
        expiresAt: r.expires_at,
        updatedAt: r.updated_at,
        purgeAt: null,
        expiredForUsers: false,
        inSuperadminGrace: false,
      };
    }
    const graceEndMs = expMs + LICENSE_SUPERADMIN_GRACE_MS;
    return {
      startedAt: r.started_at,
      expiresAt: r.expires_at,
      updatedAt: r.updated_at,
      purgeAt: new Date(graceEndMs).toISOString(),
      expiredForUsers: now >= expMs,
      inSuperadminGrace: now >= expMs && now < graceEndMs,
    };
  }

  /** Mapa deviceId → metadatos de licencia (solo lectura; sin INSERT en listados). */
  getDeviceLicenseMetaMap(deviceIds) {
    const ids = [...new Set((deviceIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
    const map = {};
    if (!ids.length) return map;
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT device_id, started_at, expires_at, updated_at FROM device_license WHERE device_id IN (${placeholders})`
        )
        .all(...chunk);
      for (const r of rows) {
        map[r.device_id] = this._licenseMetaFromRow(r);
      }
    }
    return map;
  }

  /**
   * @param {string} [lorawanClass] A/B/C; si es `undefined`, se conserva el valor ya guardado (solo cambian script/canal).
   * @param {string} [productModel] Texto corto (p. ej. marca · modelo de plantilla); `undefined` = no modificar el guardado.
   */
  setDeviceDecodeConfig(deviceId, decoderScript, channel, lorawanClass, productModel) {
    const did = String(deviceId);
    const now = new Date().toISOString();
    const existing = this.st.decodeGet.get(did);
    const script = decoderScript != null ? String(decoderScript) : existing?.decoder_script != null ? String(existing.decoder_script) : '';
    const ch = channel != null ? String(channel) : existing?.channel != null ? String(existing.channel) : '';
    let lcNorm = 'A';
    if (lorawanClass !== undefined) {
      const u = String(lorawanClass || 'A')
        .trim()
        .toUpperCase();
      lcNorm = u === 'B' || u === 'C' ? u : 'A';
    } else if (existing && existing.lorawan_class != null && String(existing.lorawan_class).trim() !== '') {
      const u = String(existing.lorawan_class)
        .trim()
        .toUpperCase();
      lcNorm = u === 'B' || u === 'C' ? u : 'A';
    }
    let pmStored =
      existing && existing.product_model != null ? String(existing.product_model).trim().slice(0, 200) : '';
    if (productModel !== undefined) {
      pmStored = String(productModel || '').trim().slice(0, 200);
    }
    this.st.decodeUpsert.run(did, script, ch, lcNorm, pmStored, now);
  }

  deleteUserDevice(userId, deviceId) {
    const uid = String(userId);
    const did = String(deviceId);
    this.st.udDelete.run(uid, did);
    try {
      this.st.labelsDeleteForUserDevice.run(uid, did);
    } catch {
      /* ignore */
    }
    try {
      this.st.ddDeleteForUserDevice.run(uid, did);
    } catch {
      /* ignore */
    }
    try {
      this.st.bsdPrefDeleteUserDevice.run(uid, did);
    } catch {
      /* tabla puede no existir en DB muy antigua */
    }
  }

  /**
   * Quita filas de dispositivo/tablas asociadas al usuario sin tocar otros usuarios ni datos globales del equipo
   * (decode-config, presets compartidos, licencia, telemetría de otros).
   * Útil antes de borrar la cuenta de usuario para no dejar `user_devices` huérfanos.
   */
  deleteAllDeviceScopedDataForUser(userId) {
    const uid = String(userId || '').trim();
    if (!uid) return;
    try {
      this.st.udDeleteAllForUser.run(uid);
    } catch {
      /* ignore */
    }
    try {
      this.st.labelsDeleteAllForUser.run(uid);
    } catch {
      /* ignore */
    }
    try {
      this.st.ddDeleteAllForUser.run(uid);
    } catch {
      /* ignore */
    }
    try {
      this.st.bsdPrefDeleteAllForUser.run(uid);
    } catch {
      /* ignore */
    }
    try {
      this.st.lgwDeleteAllForUser.run(uid);
    } catch {
      /* ignore */
    }
    try {
      this.st.dlDeleteAllForUser.run(uid);
    } catch {
      /* ignore */
    }
  }

  /** Elimina el dispositivo de toda la base (telemetría, asignaciones de todos los usuarios, etiquetas, dashboards, decode, licencia). */
  purgeDeviceGlobally(deviceId) {
    const did = String(deviceId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.st.telemetryDeleteByDevice.run(did);
      try {
        this.st.deleteDeviceLatest.run(did);
      } catch {
        /* ignore */
      }
      this.st.udDeleteAllForDevice.run(did);
      this.st.labelsDeleteByDevice.run(did);
      this.st.ddDeleteByDevice.run(did);
      try {
        this.st.bsdPrefDeleteByDevice.run(did);
      } catch {
        /* ignore */
      }
      this.st.decodeDelete.run(did);
      try {
        this.st.dspDelete.run(did);
      } catch {
        /* tabla puede no existir en DB muy antigua */
      }
      this.st.licDelete.run(did);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  deviceExistsInSystem(deviceId) {
    const did = String(deviceId);
    const r = this.st.deviceExistsInSystem.get(did, did);
    return Boolean(r);
  }

  /** Crea fila de licencia si falta, usando la primera fecha de alta del dispositivo en user_devices. */
  ensureDeviceLicenseIfMissing(deviceId) {
    const did = String(deviceId);
    const existing = this.st.licGet.get(did);
    if (existing) {
      const expMs = parseIsoOrEpochMsToMs(existing.expires_at);
      if (Number.isFinite(expMs)) return;
      this.st.licDelete.run(did);
    }
    const row = this.db
      .prepare('SELECT MIN(created_at) AS m FROM user_devices WHERE device_id = ?')
      .get(did);
    const minStr = row && row.m != null ? String(row.m).trim() : '';
    let startMs = parseIsoOrEpochMsToMs(minStr);
    if (!Number.isFinite(startMs)) startMs = Date.now();
    const twentyYearsMs = 20 * 365 * 24 * 60 * 60 * 1000;
    if (startMs < Date.now() - twentyYearsMs) startMs = Date.now();
    let expMs = startMs + LICENSE_DURATION_MS;
    if (expMs <= Date.now()) {
      startMs = Date.now();
      expMs = startMs + LICENSE_DURATION_MS;
    }
    const startIso = new Date(startMs).toISOString();
    const expIso = new Date(expMs).toISOString();
    const nowIso = new Date().toISOString();
    this.st.licInsert.run(did, startIso, expIso, nowIso);
  }

  getDeviceLicenseMeta(deviceId) {
    const r = this.st.licGet.get(String(deviceId));
    if (!r) return null;
    const now = Date.now();
    const expMs = parseIsoOrEpochMsToMs(r.expires_at);
    if (!Number.isFinite(expMs)) {
      return {
        startedAt: r.started_at,
        expiresAt: r.expires_at,
        updatedAt: r.updated_at,
        purgeAt: null,
        expiredForUsers: false,
        inSuperadminGrace: false,
      };
    }
    const graceEndMs = expMs + LICENSE_SUPERADMIN_GRACE_MS;
    return {
      startedAt: r.started_at,
      expiresAt: r.expires_at,
      updatedAt: r.updated_at,
      purgeAt: new Date(graceEndMs).toISOString(),
      expiredForUsers: now >= expMs,
      inSuperadminGrace: now >= expMs && now < graceEndMs,
    };
  }

  /** Sin fila de licencia se considera activa (telemetría huérfana / legado). */
  isLicenseActiveForEndUser(deviceId, atMs = Date.now()) {
    const r = this.st.licGet.get(String(deviceId));
    if (!r) return true;
    const expMs = parseIsoOrEpochMsToMs(r.expires_at);
    if (!Number.isFinite(expMs)) return true;
    return atMs < expMs;
  }

  renewDeviceLicense(deviceId) {
    const did = String(deviceId);
    const r = this.st.licGet.get(did);
    if (!r) return { ok: false, error: 'Este dispositivo no tiene registro de licencia' };
    const now = Date.now();
    const curExp = parseIsoOrEpochMsToMs(r.expires_at);
    const base = Number.isFinite(curExp) ? Math.max(now, curExp) : now;
    const newExp = new Date(base + LICENSE_DURATION_MS).toISOString();
    const nowIso = new Date().toISOString();
    this.st.licUpdateExpires.run(newExp, nowIso, did);
    return { ok: true, license: this.getDeviceLicenseMeta(did) };
  }

  /** Quita asignaciones, etiquetas y tableros de admin/usuario; conserva superadmin. */
  stripNonSuperadminAccessForExpiredDevice(deviceId) {
    const did = String(deviceId);
    this.st.labelsDeleteNonSuperForDevice.run(did);
    this.st.ddDeleteNonSuperForDevice.run(did);
    try {
      this.st.bsdPrefDeleteNonSuperForDevice.run(did);
    } catch {
      /* ignore */
    }
    this.st.udDeleteNonSuperForDevice.run(did);
  }

  /**
   * Por defecto no hace nada: no se desasignan ni borran datos por vencimiento de licencia.
   * Solo si `SYSCOM_LICENSE_AUTO_ENFORCE=1` se aplica el comportamiento anterior (strip + purge tras gracia).
   */
  runLicenseMaintenance() {
    if (String(process.env.SYSCOM_LICENSE_AUTO_ENFORCE || '').trim() !== '1') {
      return;
    }
    const now = Date.now();
    const rows = this.st.licListAll.all();
    for (const lic of rows) {
      const expMs = parseIsoOrEpochMsToMs(lic.expires_at);
      if (!Number.isFinite(expMs)) continue;
      if (now >= expMs) {
        this.stripNonSuperadminAccessForExpiredDevice(lic.device_id);
      }
      if (now >= expMs + LICENSE_SUPERADMIN_GRACE_MS) {
        this.purgeDeviceGlobally(lic.device_id);
      }
    }
  }

  /** Dispositivos asignados al usuario que vencen en ≤7 días (aún activos para admin/usuario). */
  listLicenseExpiringSoonForUser(userId) {
    const now = Date.now();
    const horizon = now + LICENSE_WARNING_BEFORE_EXPIRY_MS;
    const out = [];
    for (const ud of this.listUserDevices(userId)) {
      this.ensureDeviceLicenseIfMissing(ud.deviceId);
      const r = this.st.licGet.get(ud.deviceId);
      if (!r) continue;
      const expMs = parseIsoOrEpochMsToMs(r.expires_at);
      if (!Number.isFinite(expMs) || now >= expMs) continue;
      if (expMs <= horizon) {
        const daysRemaining = Math.max(0, Math.ceil((expMs - now) / (24 * 60 * 60 * 1000)));
        out.push({
          deviceId: ud.deviceId,
          displayName: ud.displayName || ud.deviceId,
          expiresAt: r.expires_at,
          startedAt: r.started_at,
          daysRemaining,
        });
      }
    }
    return out;
  }

  getGlobalLatestMap() {
    const map = {};
    const pairs = this.st.globalMaxTsPerDevice.all();
    for (const { device_id, max_ts } of pairs) {
      const row = this.st.telemetryAtDeviceTs.get(device_id, max_ts);
      if (row) {
        const t = rowToTelemetryRow(row);
        map[t.deviceId] = t;
      }
    }
    return map;
  }

  /**
   * Última telemetría solo de equipos asignados al actor (evita GROUP BY global en superadmin).
   * @param {string} userId
   * @param {string} [role]
   * @returns {Array<{ deviceId: string, properties: object, timestamp: number, … }>}
   */
  getLatestTelemetryListForActor(userId, role = '') {
    const uid = String(userId || '').trim();
    if (!uid) return [];

    const collectMap = (tuid, deviceIds, decodeMap, rowLimit) => {
      const ids = deviceIds.filter((did) => did && !/^gateway-/i.test(did));
      if (!ids.length) return {};
      return this.getDeviceListTelemetryMap(tuid, ids, decodeMap, { historyRowLimit: rowLimit });
    };

    const rowLimit = 6;

    if (role !== 'superadmin') {
      const regIds = this.listUserDevices(uid).map((r) => String(r.deviceId).trim()).filter(Boolean);
      const decodeMap = this.getDeviceDecodeConfigMap(regIds);
      return Object.values(collectMap(uid, regIds, decodeMap, rowLimit));
    }

    const udList = this.listUserDevicesWithAccounts();
    const deviceIds = new Set(udList.map((u) => u.deviceId));
    for (const licDid of this.listLicensedDeviceIds()) deviceIds.add(licDid);

    const deviceIdList = [...deviceIds];
    const decodeMap = this.getDeviceDecodeConfigMap(deviceIdList);
    return Object.values(collectMap(uid, deviceIdList, decodeMap, rowLimit));
  }

  /** [{ deviceId, userId, email, role, displayName, tag, productModel }] */
  listUserDevicesWithAccounts() {
    return this.st.udJoinUsers.all().map((r) => ({
      deviceId: r.device_id,
      userId: r.user_id,
      email: r.email,
      role: r.role,
      displayName: r.display_name,
      tag: r.tag != null ? String(r.tag) : '',
      productModel: r.product_model != null ? String(r.product_model) : '',
      lorawanClass: r.lorawan_class != null ? String(r.lorawan_class) : '',
    }));
  }

  /** Todos los `device_id` con fila en `device_license` (p. ej. vista superadmin en periodo de gracia sin asignaciones). */
  listLicensedDeviceIds() {
    return this.st.licListAll.all().map((r) => r.device_id);
  }

  getAllLabelsGroupedByDevice() {
    const byDev = {};
    for (const r of this.st.labelsAll.all()) {
      const d = r.device_id;
      if (!byDev[d]) byDev[d] = [];
      byDev[d].push({ userId: r.user_id, displayName: r.display_name });
    }
    return byDev;
  }

  getAnyUserDeviceForDeviceId(deviceId) {
    const r = this.st.udAnyForDevice.get(String(deviceId));
    if (!r) return null;
    return this._rowToUserDeviceRecord(r);
  }

  /** DevEUI normalizado 16 hex (sin separadores). */
  getAnyUserDeviceByDevEuiNorm(eui16Lower) {
    const h = String(eui16Lower || '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase();
    if (h.length !== 16) return null;
    const r = this.st.udAnyForDevEui.get(h);
    if (!r) return null;
    return this._rowToUserDeviceRecord(r);
  }

  _rowToUserDeviceRecord(r) {
    const assignmentPermissions = deviceAssignPerm.parsePermissionsJson(r.assignment_permissions_json);
    return {
      id: r.id,
      userId: r.user_id,
      deviceId: r.device_id,
      displayName: r.display_name,
      devEUI: r.dev_eui || '',
      notes: r.notes || '',
      appEui: r.app_eui || '',
      appKey: r.app_key || '',
      tag: r.tag || '',
      productModel: r.product_model != null ? String(r.product_model) : '',
      lorawanClass: r.lorawan_class || '',
      deviceSerialHex: r.device_serial_hex || '',
      assignmentPermissions,
      assignmentPermissionsJson: r.assignment_permissions_json != null ? String(r.assignment_permissions_json) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listAutomationRules(userId) {
    return this.st.arList.all(userId).map((r) => {
      try {
        const rule = JSON.parse(r.payload_json || '{}');
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return {};
        return { ...rule, active: rule.active !== false };
      } catch {
        return {};
      }
    });
  }

  replaceAutomationRules(userId, rules) {
    const owner = this.getUserById(userId);
    if (owner && navPerm.isDemoRole(owner.role)) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.st.arDeleteUser.run(userId);
      for (const rule of rules) {
        const rid = rule.id != null ? String(rule.id) : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const payload = { ...rule, id: rule.id != null ? rule.id : rid };
        this.st.arInsert.run(userId, String(payload.id), JSON.stringify(payload));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  listReportTemplates(userId) {
    return this.st.rtList.all(String(userId)).map((r) => {
      let payload = {};
      try {
        payload = JSON.parse(r.payload_json || '{}');
      } catch {
        payload = {};
      }
      return {
        id: r.template_id,
        name: r.name,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        dateFrom: payload.dateFrom || '',
        dateTo: payload.dateTo || '',
        devices: Array.isArray(payload.devices) ? payload.devices : [],
      };
    });
  }

  upsertReportTemplate(userId, template) {
    const uid = String(userId);
    const tid =
      template.id != null && String(template.id).trim()
        ? String(template.id).trim()
        : `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const name = String(template.name || '').trim();
    if (!name) throw new Error('Nombre de plantilla requerido');
    const now = new Date().toISOString();
    const existing = this.st.rtGet.get(uid, tid);
    const createdAt = existing ? existing.created_at : now;
    const payload = {
      dateFrom: template.dateFrom || '',
      dateTo: template.dateTo || '',
      devices: Array.isArray(template.devices) ? template.devices : [],
    };
    this.st.rtUpsert.run(uid, tid, name.slice(0, 200), JSON.stringify(payload), createdAt, now);
    return this.listReportTemplates(uid).find((t) => t.id === tid) || { id: tid, name, ...payload };
  }

  deleteReportTemplate(userId, templateId) {
    this.st.rtDelete.run(String(userId), String(templateId));
  }

  appendDownlinkLog(userId, fields) {
    const id = fields.id || `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const createdAt = fields.createdAt || new Date().toISOString();
    const body = { ...fields, id, userId, createdAt };
    this.st.dlInsert.run(id, userId, createdAt, JSON.stringify(body));
    const cap = parseInt(process.env.SYSCOM_DOWNLINK_LOG_CAP, 10) || 8000;
    this.db
      .prepare(
        `DELETE FROM downlink_log WHERE user_id = ? AND id NOT IN (
        SELECT id FROM (
          SELECT id FROM downlink_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
        )
      )`
      )
      .run(userId, userId, cap);
  }

  listDownlinks(userId, limit) {
    const lim = Math.min(limit || 100, 500);
    const rows = this.st.dlList.all(userId, lim);
    return this._mapDownlinkLogRows(rows);
  }

  listDownlinksForDevice(userId, deviceId, limit) {
    const lim = Math.min(limit || 100, 500);
    const did = String(deviceId || '').trim();
    if (!did) return [];
    const rows = this.st.dlListForDevice.all(userId, did, lim);
    return this._mapDownlinkLogRows(rows);
  }

  _mapDownlinkLogRows(rows) {
    return rows.map((r) => {
      let body = {};
      try {
        body = JSON.parse(r.body_json || '{}');
      } catch {
        body = {};
      }
      return {
        id: r.id,
        userId: r.user_id,
        createdAt: r.created_at,
        ...body,
      };
    });
  }

  getDeviceDashboardWidgets(userId, deviceId) {
    const row = this.st.ddGet.get(userId, String(deviceId));
    if (!row || !row.widgets_json) return [];
    try {
      const w = JSON.parse(row.widgets_json);
      return Array.isArray(w) ? w : [];
    } catch {
      return [];
    }
  }

  setDeviceDashboardWidgets(userId, deviceId, widgets) {
    const now = new Date().toISOString();
    const json = JSON.stringify(Array.isArray(widgets) ? widgets : []);
    this.st.ddUpsert.run(userId, String(deviceId), json, now);
  }

  /** Tras asignar equipo: copia `widgets_json` del origen al destino si hay tablero no vacío. */
  copyDeviceDashboardWidgetsOnAssign(fromUserId, toUserId, deviceId) {
    const from = String(fromUserId);
    const to = String(toUserId);
    const did = String(deviceId);
    if (!from || !to || !did) return false;
    const row = this.st.ddGet.get(from, did);
    if (!row || row.widgets_json == null) return false;
    const raw = String(row.widgets_json).trim();
    if (!raw || raw === '[]') return false;
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const now = new Date().toISOString();
    this.st.ddUpsert.run(to, did, raw, now);
    return true;
  }

  /**
   * Copia tablero (widgets JSON clásico) al asignatario: primero desde el actor, luego desde cualquier
   * otra cuenta con el mismo `device_id` (p. ej. superadmin asigna sin fila propia).
   */
  propagateDeviceDashboardWidgetsToUser(actorUserId, assigneeUserId, deviceId) {
    const to = String(assigneeUserId);
    const did = String(deviceId);
    const tried = new Set();
    const tryFrom = (from) => {
      const f = String(from);
      if (!f || tried.has(f)) return false;
      tried.add(f);
      return this.copyDeviceDashboardWidgetsOnAssign(f, to, did);
    };
    if (tryFrom(actorUserId)) return true;
    const others = this.listUserIdsAssignedToDevice(did).filter((id) => String(id) !== to);
    for (const uid of others) {
      if (tryFrom(uid)) return true;
    }
    return false;
  }

  /**
   * GET perezoso: si no hay fila o está vacía, intenta copiar desde otra cuenta con el mismo equipo.
   */
  getDeviceDashboardWidgetsWithPeerFallback(userId, deviceId) {
    const uid = String(userId);
    const did = String(deviceId);
    let w = this.getDeviceDashboardWidgets(uid, did);
    if (Array.isArray(w) && w.length > 0) return w;
    this.propagateDeviceDashboardWidgetsToUser('', uid, did);
    return this.getDeviceDashboardWidgets(uid, did);
  }

  /**
   * Misma definición de tablero para todas las cuentas que tienen el dispositivo (admin/superadmin).
   * @param {string | null | undefined} fallbackUserId Si no hay asignaciones, persiste solo en esta cuenta.
   */
  setDeviceDashboardWidgetsForAllAssignees(deviceId, widgets, fallbackUserId = null) {
    const did = String(deviceId || '').trim();
    if (!did) return 0;
    const json = JSON.stringify(Array.isArray(widgets) ? widgets : []);
    const now = new Date().toISOString();
    let uids = this.listUserIdsAssignedToDevice(did);
    if (!uids.length && fallbackUserId != null && String(fallbackUserId).trim()) {
      uids = [String(fallbackUserId).trim()];
    }
    for (const uid of uids) {
      this.st.ddUpsert.run(uid, did, json, now);
    }
    return uids.length;
  }

  /**
   * Preferencias BSD (tablero por dispositivo, downlinks, etc.) por usuario y equipo.
   * @returns {{ prefs: Record<string, unknown>, updatedAt: string } | null}
   */
  getDeviceBsdPreferences(userId, deviceId) {
    try {
      const row = this.st.bsdPrefGet.get(String(userId), String(deviceId));
      if (!row || !row.prefs_json) return { prefs: {}, updatedAt: '' };
      let prefs = {};
      try {
        prefs = JSON.parse(row.prefs_json) || {};
      } catch {
        prefs = {};
      }
      if (!prefs || typeof prefs !== 'object') prefs = {};
      return { prefs, updatedAt: String(row.updated_at || '') };
    } catch {
      return { prefs: {}, updatedAt: '' };
    }
  }

  /** Misma heurística que `deviceBsdBundleIsEmpty` en el cliente (widgets, rejilla, downlinks HEX, visibilidad). */
  deviceBsdPrefsBundleIsEmpty(prefs) {
    if (!prefs || typeof prefs !== 'object') return true;
    const vw = prefs.valueWidgets;
    const nVw = vw && typeof vw === 'object' ? Object.keys(vw).length : 0;
    const gl = prefs.gridLayout;
    const nGl = Array.isArray(gl) ? gl.length : 0;
    const dl = prefs.downlinks;
    const nDl = Array.isArray(dl) ? dl.filter((r) => r && String(r.hex || '').trim()).length : 0;
    const vis = prefs.visibility;
    const visKeys =
      vis && typeof vis === 'object' ? Object.keys(vis).filter((k) => vis[k] === false) : [];
    return nVw === 0 && nGl === 0 && nDl === 0 && visKeys.length === 0;
  }

  /**
   * GET perezoso: si este usuario aún no tiene BSD persistido para el equipo, copia desde
   * cualquier otro asignado con JSON no vacío (p. ej. falló el PUT antes de `/assign`).
   */
  getDeviceBsdPreferencesWithPeerFallback(userId, deviceId) {
    const uid = String(userId);
    const did = String(deviceId);
    let cur = this.getDeviceBsdPreferences(uid, did);
    if (!this.deviceBsdPrefsBundleIsEmpty(cur.prefs)) return cur;
    this.propagateDeviceBsdPreferencesToUser('', uid, did);
    cur = this.getDeviceBsdPreferences(uid, did);
    return cur;
  }

  setDeviceBsdPreferences(userId, deviceId, prefsObj) {
    const now = new Date().toISOString();
    const o = prefsObj && typeof prefsObj === 'object' ? prefsObj : {};
    const json = JSON.stringify(o);
    if (json.length > 900000) {
      throw new Error('Preferencias demasiado grandes');
    }
    this.st.bsdPrefUpsert.run(String(userId), String(deviceId), json, now);
  }

  /**
   * Preferencias BSD del panel de control (por usuario, segmento de cuenta y pestaña de panel).
   * @returns {{ prefs: Record<string, unknown>, updatedAt: string }}
   */
  getUserPanelBsdPreferences(userId, segment, panelId) {
    try {
      const uid = String(userId || '').trim();
      const seg = segment != null ? String(segment) : '';
      const pid = panelId != null && String(panelId).trim() ? String(panelId).trim() : 'main';
      if (!uid) return { prefs: {}, updatedAt: '' };
      const row = this.st.panelBsdPrefGet.get(uid, seg, pid);
      if (!row || !row.prefs_json) return { prefs: {}, updatedAt: String(row?.updated_at || '') };
      let prefs = {};
      try {
        prefs = JSON.parse(row.prefs_json) || {};
      } catch {
        prefs = {};
      }
      if (!prefs || typeof prefs !== 'object') prefs = {};
      return { prefs, updatedAt: String(row.updated_at || '') };
    } catch {
      return { prefs: {}, updatedAt: '' };
    }
  }

  setUserPanelBsdPreferences(userId, segment, panelId, prefsObj) {
    const uid = String(userId || '').trim();
    const seg = segment != null ? String(segment) : '';
    const pid = panelId != null && String(panelId).trim() ? String(panelId).trim() : 'main';
    if (!uid) throw new Error('Usuario inválido');
    const now = new Date().toISOString();
    const o = prefsObj && typeof prefsObj === 'object' ? prefsObj : {};
    const json = JSON.stringify(o);
    if (json.length > 900000) {
      throw new Error('Preferencias demasiado grandes');
    }
    this.st.panelBsdPrefUpsert.run(uid, seg, pid, json, now);
  }

  /**
   * Mismas preferencias BSD (widgets valor, rejilla, visibilidad, downlinks) para todas las cuentas con el equipo.
   * @param {string | null | undefined} fallbackUserId Si no hay asignaciones, persiste solo en esta cuenta.
   */
  setDeviceBsdPreferencesForAllAssignees(deviceId, prefsObj, fallbackUserId = null) {
    const did = String(deviceId || '').trim();
    if (!did) return 0;
    const o = prefsObj && typeof prefsObj === 'object' ? prefsObj : {};
    const json = JSON.stringify(o);
    if (json.length > 900000) {
      throw new Error('Preferencias demasiado grandes');
    }
    const now = new Date().toISOString();
    let uids = this.listUserIdsAssignedToDevice(did);
    if (!uids.length && fallbackUserId != null && String(fallbackUserId).trim()) {
      uids = [String(fallbackUserId).trim()];
    }
    for (const uid of uids) {
      this.st.bsdPrefUpsert.run(uid, did, json, now);
    }
    return uids.length;
  }

  /** Tras asignar el equipo a otro usuario: copia el JSON del actor al asignatario (primera asignación). */
  copyDeviceBsdPreferencesOnAssign(fromUserId, toUserId, deviceId) {
    const from = String(fromUserId);
    const to = String(toUserId);
    const did = String(deviceId);
    const row = this.st.bsdPrefGet.get(from, did);
    if (!row || !row.prefs_json) return false;
    const raw = String(row.prefs_json).trim();
    if (!raw || raw === '{}') return false;
    const now = new Date().toISOString();
    this.st.bsdPrefUpsert.run(to, did, raw, now);
    return true;
  }

  /**
   * Copia preferencias BSD al asignatario: primero desde `actorUserId`, si no hay datos en servidor
   * intenta cualquier otro usuario que aún tenga el dispositivo asignado (p. ej. superadmin asigna sin tablero propio).
   * Si `actorUserId` es cadena vacía, solo se consideran otros asignados (útil en GET perezoso).
   */
  propagateDeviceBsdPreferencesToUser(actorUserId, assigneeUserId, deviceId) {
    const to = String(assigneeUserId);
    const did = String(deviceId);
    const tried = new Set();
    const tryFrom = (from) => {
      const f = String(from);
      if (!f || tried.has(f)) return false;
      tried.add(f);
      return this.copyDeviceBsdPreferencesOnAssign(f, to, did);
    };
    if (tryFrom(actorUserId)) return true;
    const others = this.listUserIdsAssignedToDevice(did).filter((id) => String(id) !== to);
    for (const uid of others) {
      if (tryFrom(uid)) return true;
    }
    return false;
  }

  /**
   * @param {{ vacuum?: boolean }} [opts] VACUUM compacta el archivo .db tras borrar muchas filas (lento; usar en mantenimiento).
   * @returns {{ deleted: number, cutoff: number, retentionMs: number, vacuumed: boolean }}
   */
  /**
   * Los pseudo-dispositivos `gateway-*` y heartbeats UDP generan cientos de miles de filas repetidas.
   * Conserva solo las últimas `keepMs` (defecto 48 h).
   */
  pruneGatewayTelemetryHistory(opts = {}) {
    const keepMs = Math.max(
      3600000,
      Number.isFinite(Number(opts.keepMs)) ? Number(opts.keepMs) : 48 * 60 * 60 * 1000
    );
    const cutoff = Date.now() - keepMs;
    const maxChunks = Math.min(
      80,
      Math.max(1, Number.isFinite(Number(opts.maxChunks)) ? Math.floor(Number(opts.maxChunks)) : 20)
    );
    let deleted = 0;
    for (let i = 0; i < maxChunks; i += 1) {
      const info = this.st.pruneGatewayTelemetryChunk.run(cutoff);
      const n = Number(info.changes || 0);
      deleted += n;
      if (n < 1500) break;
    }
    if (deleted > 0) {
      console.log(
        `[Syscom] Telemetría gateway antigua podada: ${deleted} filas (conservando ${Math.round(keepMs / 3600000)} h)`
      );
    }
    return { deleted, cutoff, keepMs };
  }

  runRetentionPruneNow(opts = {}) {
    const cutoff = Date.now() - this.retentionMs;
    const maxChunks = Math.min(
      400,
      Math.max(
        1,
        Number.isFinite(Number(opts.maxChunks))
          ? Math.floor(Number(opts.maxChunks))
          : opts.vacuum === true
            ? 200
            : 20
      )
    );
    let deleted = 0;
    for (let i = 0; i < maxChunks; i += 1) {
      const info = this.st.pruneTelemetryChunk.run(cutoff);
      const n = Number(info.changes || 0);
      deleted += n;
      if (n < 1500) break;
    }
    let vacuumed = false;
    /** Nunca VACUUM por umbral de filas: bloquea el proceso minutos → 504 Cloudflare. */
    if (opts.vacuum === true && deleted > 0) {
      try {
        this.db.exec('VACUUM');
        vacuumed = true;
      } catch (e) {
        console.warn('[Syscom] VACUUM tras poda:', e.message || e);
      }
    }
    if (deleted > 0) {
      console.log(
        `[Syscom] Telemetría podada: ${deleted} filas anteriores a ${new Date(cutoff).toISOString()}${vacuumed ? ' (VACUUM)' : ''}`
      );
    }
    return { deleted, cutoff, retentionMs: this.retentionMs, vacuumed };
  }

  /**
   * Mantenimiento automático: retención global + basura de gateways (no borra sensores/VS133 recientes).
   * @param {{ vacuum?: boolean, skipGateways?: boolean }} [opts]
   */
  runStorageMaintenance(opts = {}) {
    const retention = this.runRetentionPruneNow({ vacuum: false });
    let gateways = { deleted: 0, keepMs: 0 };
    const autoGateway = !['0', 'false', 'no', 'off'].includes(
      String(process.env.SYSCOM_AUTO_PRUNE_GATEWAY_TELEMETRY || '1').trim().toLowerCase()
    );
    if (autoGateway && !opts.skipGateways) {
      const keepMs = Math.max(
        3600000,
        parseInt(String(process.env.SYSCOM_GATEWAY_TELEMETRY_KEEP_MS || '').trim(), 10) ||
          48 * 60 * 60 * 1000
      );
      gateways = this.pruneGatewayTelemetryHistory({ keepMs });
      gateways.keepMs = keepMs;
    }
    let vacuumed = false;
    const totalDeleted = retention.deleted + (gateways.deleted || 0);
    /** wal_checkpoint(TRUNCATE) reescribe el .db y bloquea igual que VACUUM. */
    if (opts.vacuum === true && totalDeleted > 0) {
      try {
        this.db.exec('VACUUM');
        vacuumed = true;
      } catch (e) {
        console.warn('[Syscom] VACUUM mantenimiento:', e.message || e);
      }
    }
    return { retention, gateways, vacuumed, totalDeleted };
  }

  /** Estadísticas de almacenamiento (diagnóstico de lentitud por BD grande). */
  getTelemetryStorageStats() {
    const totalRow = this.db.prepare('SELECT COUNT(*) AS n FROM telemetry').get();
    const rangeRow = this.db
      .prepare('SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM telemetry')
      .get();
    const usersRow = this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM telemetry').get();
    const devicesRow = this.db.prepare('SELECT COUNT(DISTINCT device_id) AS n FROM telemetry').get();
    const joinRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM telemetry WHERE properties_json LIKE '%"lorawan_event"%' AND properties_json LIKE '%join%'`
      )
      .get();
    const topDevices = this.db
      .prepare(
        `SELECT device_id, COUNT(*) AS n FROM telemetry GROUP BY device_id ORDER BY n DESC LIMIT 15`
      )
      .all();
    const topUsers = this.db
      .prepare(
        `SELECT user_id, COUNT(*) AS n FROM telemetry GROUP BY user_id ORDER BY n DESC LIMIT 10`
      )
      .all();
    const dbPath = this.filePath || DEFAULT_SQLITE;
    let fileBytes = 0;
    try {
      fileBytes = fs.statSync(dbPath).size;
    } catch {
      fileBytes = 0;
    }
    const walBytes = (() => {
      try {
        return fs.statSync(`${dbPath}-wal`).size;
      } catch {
        return 0;
      }
    })();
    return {
      sqlitePath: dbPath,
      fileBytes,
      walBytes,
      totalRows: Number(totalRow?.n || 0),
      distinctUsers: Number(usersRow?.n || 0),
      distinctDevices: Number(devicesRow?.n || 0),
      joinEventRows: Number(joinRow?.n || 0),
      oldestTs: rangeRow?.min_ts != null ? Number(rangeRow.min_ts) : null,
      newestTs: rangeRow?.max_ts != null ? Number(rangeRow.max_ts) : null,
      retentionMs: this.retentionMs,
      retentionDays: Math.round(this.retentionMs / 86400000),
      topDevicesByRows: topDevices.map((r) => ({
        deviceId: r.device_id,
        rows: Number(r.n || 0),
      })),
      topUsersByRows: topUsers.map((r) => ({
        userId: r.user_id,
        rows: Number(r.n || 0),
      })),
    };
  }

  /** Registro del `jti` incluido en JWT de integración LNS (revocable). */
  lnsIntegrationTokenRecord(jti, userId, label) {
    const j = String(jti || '').trim();
    const u = String(userId || '').trim();
    if (!j || !u) return false;
    try {
      this.st.lnsIntTokInsert.run(j, u, String(label || '').trim().slice(0, 200), Date.now());
      return true;
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) return false;
      throw e;
    }
  }

  lnsIntegrationTokenRevoke(userId, jti) {
    const info = this.st.lnsIntTokRevoke.run(String(userId).trim(), String(jti || '').trim());
    return Number(info.changes || 0) > 0;
  }

  lnsIntegrationTokenIsActive(userId, jti) {
    const row = this.st.lnsIntTokIsActive.get(String(userId).trim(), String(jti || '').trim());
    return Boolean(row);
  }

  lnsIntegrationTokenList(userId) {
    return this.st.lnsIntTokList.all(String(userId).trim()).map((r) => ({
      jti: r.jti,
      label: r.label || '',
      createdAt: r.created_at,
      revoked: Boolean(r.revoked),
    }));
  }

  /**
   * Copia consistente del SQLite principal (usuarios, asignaciones, gateways, telemetría,
   * reglas, dashboards, plantillas/decode, licencias, colas LNS, historiales, etc.).
   */
  exportDatabaseSnapshotToPath(destPath) {
    ensureDir(path.dirname(destPath));
    try {
      this.db.exec('PRAGMA wal_checkpoint(FULL)');
    } catch (e) {
      console.warn('[store] wal_checkpoint antes de respaldo:', e && e.message);
    }
    fs.copyFileSync(this.filePath, destPath);
  }

  /**
   * Sustituye el archivo principal por un volcado SQLite válido. Cierra la conexión,
   * elimina WAL/SHM y reabre aplicando migraciones sobre el archivo importado.
   */
  replaceMainDatabaseFromBuffer(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!buf || buf.length < 512) {
      throw new Error('Archivo demasiado pequeño o vacío.');
    }
    const magic = buf.subarray(0, 15).toString('utf8');
    if (magic !== 'SQLite format 3') {
      throw new Error('El archivo no es una base SQLite válida (use un .db exportado desde este servidor).');
    }

    const bak = `${this.filePath}.antes-import-${Date.now()}.bak`;
    try {
      this.db.exec('PRAGMA wal_checkpoint(FULL)');
    } catch (e) {
      /* ignore */
    }
    try {
      fs.copyFileSync(this.filePath, bak);
    } catch (e) {
      /* ignore */
    }

    this.db.close();

    try {
      fs.unlinkSync(`${this.filePath}-wal`);
    } catch (e) {
      /* no wal */
    }
    try {
      fs.unlinkSync(`${this.filePath}-shm`);
    } catch (e) {
      /* no shm */
    }

    fs.writeFileSync(this.filePath, buf);

    this.db = openDb(this.filePath);
    this._migrateUserMustChangePassword();
    this._migrateDeviceSchema();
    this._migrateLnsSchema();
    this._migrateServerSettings();
    this._prepareStatements();
    this._migrateRoles();
  }

  close() {
    this.db.close();
  }
}

const sqlitePath = process.env.SYSCOM_SQLITE_PATH || DEFAULT_SQLITE;
const store = new Store(sqlitePath);
store.setRetentionMs(parseInt(process.env.SYSCOM_TELEMETRY_RETENTION_MS, 10) || 365 * 24 * 60 * 60 * 1000);

module.exports = {
  store,
  Store,
  LICENSE_SUPERADMIN_GRACE_MS,
  LICENSE_WARNING_BEFORE_EXPIRY_MS,
  readLnsTxAckPruneSilenceMs,
};
