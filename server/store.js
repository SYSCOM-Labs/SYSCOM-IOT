/**
 * Persistencia SQLite para carga masiva (miles de sensores, muchos usuarios).
 * - Índices por usuario/dispositivo/tiempo
 * - WAL + synchronous NORMAL
 * - Poda de telemetría por antigüedad sin reescribir todo el archivo
 * Migración automática desde server/db.json la primera vez.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DatabaseSync } = require('node:sqlite');
const { runMigrations } = require('./migrations/runMigrations');
const {
  isEnsuredSuperadminEmail,
  ENSURED_SUPERADMIN_EMAIL,
  ENSURED_SUPERADMIN_EMAILS,
} = require('./migrations/bootstrap-admins');

const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_SQLITE = path.join(DATA_DIR, 'syscom.db');
const LEGACY_JSON = path.join(__dirname, 'db.json');
const MIGRATE_MARKER = path.join(DATA_DIR, '.migrated-from-json');

/** Vigencia estándar: 1 año desde la fecha de alta (primera fila user_devices). */
const LICENSE_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
/** Tras vencer para admin/usuario, el super admin conserva el dispositivo 30 días más antes del borrado total. */
const LICENSE_SUPERADMIN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** Aviso diario en la app durante los últimos 7 días antes del vencimiento. */
const LICENSE_WARNING_BEFORE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

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

function migrateFromJson(db, jsonPath) {
  if (!fs.existsSync(jsonPath)) return;
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const insertUser = prepareBare(db, `
    INSERT OR REPLACE INTO users (id, email, password, role, profile_name, created_by, created_by_email, ingest_token, created_at, milesight_ug_json, must_change_password, picture_url)
    VALUES (@id, @email, @password, @role, @profile_name, @created_by, @created_by_email, @ingest_token, @created_at, @milesight_ug_json, @must_change_password, @picture_url)
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
        picture_url: u.pictureUrl || null,
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
    mustChangePassword: Number(row.must_change_password) === 1,
    pictureUrl: row.picture_url || null,
  };
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
    runMigrations(this.db);
    if (!fs.existsSync(MIGRATE_MARKER) && fs.existsSync(LEGACY_JSON)) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM users').get();
      const n = Number(row && row.c);
      if (n === 0) migrateFromJson(this.db, LEGACY_JSON);
    }
    this._prepareStatements();
    this._pruneCounter = 0;
    this.retentionMs = 365 * 24 * 60 * 60 * 1000;
  }

  _prepareStatements() {
    this.st = {
      userByEmail: this.db.prepare('SELECT * FROM users WHERE email = ?'),
      userById: this.db.prepare('SELECT * FROM users WHERE id = ?'),
      usersByCreator: this.db.prepare('SELECT * FROM users WHERE created_by = ?'),
      allUsers: this.db.prepare('SELECT * FROM users'),
      insertUser: prepareBare(this.db, `
        INSERT INTO users (id, email, password, role, profile_name, created_by, created_by_email, ingest_token, created_at, milesight_ug_json, must_change_password, picture_url)
        VALUES (@id, @email, @password, @role, @profile_name, @created_by, @created_by_email, @ingest_token, @created_at, @milesight_ug_json, @must_change_password, @picture_url)
      `),
      updateUserFull: prepareBare(this.db, `
        UPDATE users SET email=@email, password=@password, role=@role, profile_name=@profile_name,
          created_by=@created_by, created_by_email=@created_by_email, ingest_token=@ingest_token, created_at=@created_at, milesight_ug_json=@milesight_ug_json,
          must_change_password=@must_change_password, picture_url=@picture_url
        WHERE id=@id
      `),
      deleteUser: this.db.prepare('DELETE FROM users WHERE id = ?'),
      insertTelemetry: prepareBare(this.db, `
        INSERT INTO telemetry (user_id, device_id, device_name, properties_json, ts)
        VALUES (@user_id, @device_id, @device_name, @properties_json, @ts)
      `),
      pruneTelemetry: this.db.prepare('DELETE FROM telemetry WHERE ts < ?'),
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
      telemetryHistory: this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM telemetry
        WHERE user_id = ? AND device_id = ? AND ts >= ? AND ts <= ?
        ORDER BY ts DESC
        LIMIT ?
      `),
      telemetryRange: this.db.prepare(`
        SELECT id, user_id, device_id, device_name, properties_json, ts FROM telemetry
        WHERE user_id = ? AND device_id = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
      `),
      lastTelemetrySameProps: this.db.prepare(`
        SELECT properties_json FROM telemetry
        WHERE user_id = ? AND device_id = ?
        ORDER BY ts DESC, id DESC LIMIT 1
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
      lgwExists: this.db.prepare(
        'SELECT 1 FROM lorawan_gateways WHERE user_id = ? AND lower(gateway_eui) = lower(?)'
      ),
      lgwEuiForMac: this.db.prepare(`
        SELECT gateway_eui FROM lorawan_gateways WHERE user_id = ?
        AND lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) IN (?, ?) LIMIT 1
      `),
      lnsOtaaDevice: this.db.prepare(`
        SELECT * FROM user_devices WHERE user_id = ?
        AND lower(replace(replace(replace(dev_eui,':',''),'-',''),' ','')) = ?
        AND lower(replace(replace(replace(app_eui,':',''),'-',''),' ','')) = ?
        AND app_key IS NOT NULL AND length(trim(app_key)) = 32
        LIMIT 1
      `),
      lnsSessionByDevEui: this.db.prepare('SELECT * FROM lorawan_lns_sessions WHERE user_id = ? AND dev_eui = ?'),
      lnsSessionByDevAddr: this.db.prepare('SELECT * FROM lorawan_lns_sessions WHERE user_id = ? AND dev_addr = ?'),
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
      lnsDlInsert: this.db.prepare(`
        INSERT INTO lorawan_lns_downlink (
          user_id, gateway_eui, pull_resp_json, status, created_at, not_before_ms, priority,
          track_tx_ack, tx_dev_eui, tx_new_fcnt, tx_prev_fcnt, tx_retries_left, is_confirmed_down
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      lnsDlDequeue: this.db.prepare(`
        SELECT id, user_id, gateway_eui, pull_resp_json, track_tx_ack, tx_dev_eui, tx_new_fcnt, tx_prev_fcnt, tx_retries_left, priority, not_before_ms
        FROM lorawan_lns_downlink
        WHERE gateway_eui = ? AND status = 'pending' AND not_before_ms <= ?
        ORDER BY priority DESC, created_at ASC LIMIT 1
      `),
      lnsDlSent: this.db.prepare('UPDATE lorawan_lns_downlink SET status = ? WHERE id = ?'),
      lnsDlAwaitTxAck: this.db.prepare(`UPDATE lorawan_lns_downlink SET status = 'await_tx_ack' WHERE id = ?`),
      lnsDlDeleteById: this.db.prepare('DELETE FROM lorawan_lns_downlink WHERE id = ?'),
      lnsTxInflightInsert: this.db.prepare(`
        INSERT INTO lorawan_lns_tx_inflight (gateway_eui, token_h, token_l, downlink_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      lnsTxInflightSelectJoin: this.db.prepare(`
        SELECT i.id AS inflight_id, d.id AS downlink_id, d.user_id, d.gateway_eui, d.pull_resp_json,
          d.tx_dev_eui, d.tx_new_fcnt, d.tx_prev_fcnt, d.tx_retries_left, d.priority, d.track_tx_ack,
          d.is_confirmed_down
        FROM lorawan_lns_tx_inflight i
        INNER JOIN lorawan_lns_downlink d ON d.id = i.downlink_id
        WHERE i.gateway_eui = ? AND i.token_h = ? AND i.token_l = ?
        ORDER BY i.id ASC LIMIT 1
      `),
      lnsTxInflightDelete: this.db.prepare('DELETE FROM lorawan_lns_tx_inflight WHERE id = ?'),
      lnsHasTrackedDlForDev: this.db.prepare(`
        SELECT 1 FROM lorawan_lns_downlink
        WHERE user_id = ? AND tx_dev_eui = ? AND track_tx_ack = 1 AND status IN ('pending', 'await_tx_ack')
        LIMIT 1
      `),
      udList: this.db.prepare('SELECT * FROM user_devices WHERE user_id = ?'),
      udGet: this.db.prepare('SELECT * FROM user_devices WHERE user_id = ? AND device_id = ?'),
      udUpsert: this.db.prepare(`
        INSERT INTO user_devices (id, user_id, device_id, display_name, dev_eui, notes, app_eui, app_key, tag, lorawan_class, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, device_id) DO UPDATE SET
          display_name = excluded.display_name,
          dev_eui = excluded.dev_eui,
          notes = excluded.notes,
          app_eui = excluded.app_eui,
          app_key = excluded.app_key,
          tag = excluded.tag,
          lorawan_class = excluded.lorawan_class,
          updated_at = excluded.updated_at
      `),
      decodeGet: this.db.prepare('SELECT device_id, decoder_script, channel, updated_at FROM device_decode_config WHERE device_id = ?'),
      decodeUpsert: this.db.prepare(`
        INSERT INTO device_decode_config (device_id, decoder_script, channel, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          decoder_script = excluded.decoder_script,
          channel = excluded.channel,
          updated_at = excluded.updated_at
      `),
      decodeDelete: this.db.prepare('DELETE FROM device_decode_config WHERE device_id = ?'),
      udDelete: this.db.prepare('DELETE FROM user_devices WHERE user_id = ? AND device_id = ?'),
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
        SELECT ud.device_id, ud.user_id, ud.display_name, u.email, u.role
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
      arList: this.db.prepare('SELECT rule_id, payload_json FROM automation_rules WHERE user_id = ?'),
      arDeleteUser: this.db.prepare('DELETE FROM automation_rules WHERE user_id = ?'),
      arInsert: this.db.prepare(
        'INSERT INTO automation_rules (user_id, rule_id, payload_json) VALUES (?, ?, ?)'
      ),
      dlInsert: this.db.prepare(
        'INSERT INTO downlink_log (id, user_id, created_at, body_json) VALUES (?, ?, ?, ?)'
      ),
      dlList: this.db.prepare(
        'SELECT id, user_id, created_at, body_json FROM downlink_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
      ),
      ddGet: this.db.prepare(
        'SELECT widgets_json FROM device_dashboard WHERE user_id = ? AND device_id = ?'
      ),
      ddUpsert: this.db.prepare(`
        INSERT OR REPLACE INTO device_dashboard (user_id, device_id, widgets_json, updated_at)
        VALUES (?, ?, ?, ?)
      `),
      telemetryDeleteByDevice: this.db.prepare('DELETE FROM telemetry WHERE device_id = ?'),
      udDeleteAllForDevice: this.db.prepare('DELETE FROM user_devices WHERE device_id = ?'),
      labelsDeleteByDevice: this.db.prepare('DELETE FROM device_labels WHERE device_id = ?'),
      ddDeleteByDevice: this.db.prepare('DELETE FROM device_dashboard WHERE device_id = ?'),
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
    };
  }

  dbPath() {
    return this.filePath;
  }

  getUserByEmail(email) {
    return rowToUser(this.st.userByEmail.get(email));
  }

  getUserById(id) {
    return rowToUser(this.st.userById.get(id));
  }

  listUsersByCreator(createdBy) {
    return this.st.usersByCreator.all(createdBy).map(rowToUser);
  }

  allUsersSanitized() {
    return this.st.allUsers.all().map(rowToUser);
  }

  insertUser(user) {
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
      must_change_password: user.mustChangePassword ? 1 : 0,
      picture_url: user.pictureUrl || null,
    });
  }

  updateUserRecord(user) {
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
      must_change_password: user.mustChangePassword ? 1 : 0,
      picture_url: user.pictureUrl || null,
    });
  }

  deleteUserById(id) {
    this.st.deleteUser.run(id);
  }

  /**
   * @returns {string[]} userIds que recibieron fila de telemetría (propietario + cuentas con el mismo dispositivo asignado).
   */
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
    this._pruneCounter += 1;
    if (this._pruneCounter >= 50) {
      this._pruneCounter = 0;
      const cutoff = Date.now() - this.retentionMs;
      this.st.pruneTelemetry.run(cutoff);
    }
    return Array.from(affected);
  }

  setRetentionMs(ms) {
    this.retentionMs = ms;
  }

  getLatestMap(userId) {
    const rows = this.st.latestByUser.all(userId);
    const map = {};
    for (const row of rows) {
      const t = rowToTelemetryRow(row);
      map[t.deviceId] = t;
    }
    return map;
  }

  getTelemetryForGatewayScan(userId, limit) {
    const since = Date.now() - (parseInt(process.env.GW_STATUS_LOOKBACK_MS, 10) || 7 * 24 * 60 * 60 * 1000);
    const lim = Math.min(limit || 50000, 200000);
    return this.st.telemetryRecentForUser.all(userId, since, lim).map(rowToTelemetryRow);
  }

  getLatestForDevice(userId, deviceId) {
    const row = this.st.latestForDevice.get(userId, String(deviceId));
    return row ? rowToTelemetryRow(row) : null;
  }

  /** Para resolver alias devEUI → deviceId canónico */
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

  getTelemetryHistory(userId, deviceId, startTime, endTime, pageSize) {
    const st = parseInt(startTime, 10) || 0;
    const en = parseInt(endTime, 10) || Number.MAX_SAFE_INTEGER;
    const lim = Math.min(parseInt(pageSize, 10) || 100, 500);
    return this.st.telemetryHistory.all(userId, String(deviceId), st, en, lim).map(rowToTelemetryRow);
  }

  getTelemetrySeries(userId, deviceId, startMs, endMs, propKey, maxRows) {
    const rows = this.st.telemetryRange.all(
      userId,
      String(deviceId),
      parseInt(startMs, 10) || 0,
      parseInt(endMs, 10) || Date.now()
    );
    let list = rows.map(rowToTelemetryRow);
    if (propKey) {
      list = list.filter((t) => t.properties && t.properties[propKey] !== undefined);
    }
    const cap = Math.min(maxRows || 500, 2000);
    if (list.length > cap) list = list.slice(-cap);
    return list;
  }

  lastPropertiesJsonEqual(userId, deviceId, properties) {
    const row = this.st.lastTelemetrySameProps.get(userId, String(deviceId));
    if (!row) return false;
    return row.properties_json === JSON.stringify(properties || {});
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
    return this.st.lnsOtaaDevice.get(userId, devEuiHex16, joinEuiHex16) || null;
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

  lnsSetFcntDown(userId, devEuiNorm16, fcntDown) {
    const now = new Date().toISOString();
    this.st.lnsUpdateFcntDown.run(fcntDown, now, userId, devEuiNorm16);
  }

  /**
   * @param {object | null} [txMeta] Si está definido (downlink de aplicación con SYSCOM_LNS_TX_ACK), no confirmar FCnt hasta TX_ACK.
   * @param {{ devEui: string, newFcnt: number, prevFcnt: number, retriesLeft?: number }} txMeta
   */
  lnsEnqueuePullResp(userId, gatewayEuiNorm16, pullRespObj, notBeforeMs, priority, txMeta) {
    const nb = notBeforeMs != null ? Number(notBeforeMs) : 0;
    const pr = priority != null ? Math.max(0, Math.min(255, Math.floor(Number(priority)))) : 0;
    const ts = Date.now();
    const track = txMeta && txMeta.devEui ? 1 : 0;
    let deui = null;
    let nfc = null;
    let pfc = null;
    let retr = null;
    let isConf = 0;
    if (track) {
      deui = String(txMeta.devEui);
      nfc = txMeta.newFcnt != null ? Number(txMeta.newFcnt) : null;
      pfc = txMeta.prevFcnt != null ? Number(txMeta.prevFcnt) : null;
      retr =
        txMeta.retriesLeft != null
          ? Math.max(0, Math.floor(Number(txMeta.retriesLeft)))
          : Math.max(0, parseInt(process.env.SYSCOM_LNS_TX_ACK_MAX_RETRIES || '3', 10) || 3);
      isConf = txMeta.confirmedDown ? 1 : 0;
    }
    this.st.lnsDlInsert.run(
      userId,
      gatewayEuiNorm16,
      JSON.stringify(pullRespObj),
      ts,
      nb,
      pr,
      track,
      deui,
      nfc,
      pfc,
      retr,
      isConf
    );
  }

  lnsDequeuePullResp(gatewayEuiNorm16) {
    const now = Date.now();
    const r = this.st.lnsDlDequeue.get(gatewayEuiNorm16, now);
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      json: r.pull_resp_json,
      trackTxAck: Number(r.track_tx_ack) === 1,
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.st.lnsDlAwaitTxAck.run(downlinkId);
      this.st.lnsTxInflightInsert.run(gatewayEuiNorm16, tokenH, tokenL, downlinkId, Date.now());
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

  _lnsTxAckIsSuccess(txpkAck) {
    if (txpkAck == null || typeof txpkAck !== 'object') return true;
    const e = txpkAck.error;
    if (e == null || e === '') return true;
    return String(e).toUpperCase() === 'NONE';
  }

  /**
   * GW_TX_ACK del packet forwarder Semtech (mismo token que el PULL_RESP).
   * @param {string|null} gwNorm
   * @param {Buffer} tokenBuf 2 bytes
   * @param {object} json
   */
  lnsHandleGatewayTxAck(gwNorm, tokenBuf, json) {
    if (!gwNorm || !tokenBuf || tokenBuf.length < 2) return;
    const th = tokenBuf[0];
    const tl = tokenBuf[1];
    const row = this.st.lnsTxInflightSelectJoin.get(gwNorm, th, tl);
    if (!row) return;

    const txpkAck = json && json.txpk_ack;
    const ok = this._lnsTxAckIsSuccess(txpkAck);
    const inflightId = row.inflight_id;
    const delayMs = Math.max(
      0,
      parseInt(process.env.SYSCOM_LNS_TX_ACK_RETRY_MS || '750', 10) || 750
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.st.lnsTxInflightDelete.run(inflightId);
      if (ok) {
        if (Number(row.track_tx_ack) === 1 && row.tx_dev_eui && row.tx_new_fcnt != null) {
          this.lnsSetFcntDown(row.user_id, row.tx_dev_eui, Number(row.tx_new_fcnt));
          if (Number(row.is_confirmed_down) === 1) {
            this.lnsMarkAwaitingConfirmedDeviceAck(row.user_id, row.tx_dev_eui);
          }
        }
        this.st.lnsDlDeleteById.run(row.downlink_id);
      } else {
        const errName = txpkAck && txpkAck.error != null ? String(txpkAck.error) : 'UNKNOWN';
        console.warn('[LNS-UDP] TX_ACK rechazado:', errName, 'gw=', gwNorm, 'dev=', row.tx_dev_eui);
        const retries = (row.tx_retries_left != null ? Number(row.tx_retries_left) : 0) - 1;
        this.st.lnsDlDeleteById.run(row.downlink_id);
        if (Number(row.track_tx_ack) === 1 && retries > 0) {
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
            ic
          );
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      console.error('[LNS-UDP] TX_ACK DB:', e.message);
    }
  }

  /** Evita dos downlinks con el mismo FCnt mientras uno espera TX_ACK. */
  lnsHasTrackedDownlinkPendingForDev(userId, devEuiNorm16) {
    const r = this.st.lnsHasTrackedDlForDev.get(userId, devEuiNorm16);
    return Boolean(r);
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

  getUserDevice(userId, deviceId) {
    const r = this.st.udGet.get(userId, String(deviceId));
    if (!r) return null;
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
      lorawanClass: r.lorawan_class || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listUserDevices(userId) {
    return this.st.udList.all(userId).map((r) => ({
      id: r.id,
      userId: r.user_id,
      deviceId: r.device_id,
      displayName: r.display_name,
      devEUI: r.dev_eui || '',
      notes: r.notes || '',
      appEui: r.app_eui || '',
      appKey: r.app_key || '',
      tag: r.tag || '',
      lorawanClass: r.lorawan_class || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  upsertUserDevice(row) {
    let lorawanClass = null;
    if (row.lorawanClass != null && String(row.lorawanClass).trim() !== '') {
      const u = String(row.lorawanClass).trim().toUpperCase();
      lorawanClass = u === 'B' || u === 'C' ? u : 'A';
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
      lorawanClass || null,
      row.createdAt,
      row.updatedAt
    );
  }

  getDeviceDecodeConfig(deviceId) {
    const r = this.st.decodeGet.get(String(deviceId));
    if (!r) return { deviceId: String(deviceId), decoderScript: '', channel: '', updatedAt: null };
    return {
      deviceId: r.device_id,
      decoderScript: r.decoder_script || '',
      channel: r.channel || '',
      updatedAt: r.updated_at,
    };
  }

  setDeviceDecodeConfig(deviceId, decoderScript, channel) {
    const did = String(deviceId);
    const now = new Date().toISOString();
    this.st.decodeUpsert.run(did, decoderScript != null ? String(decoderScript) : '', channel != null ? String(channel) : '', now);
  }

  deleteUserDevice(userId, deviceId) {
    this.st.udDelete.run(userId, String(deviceId));
  }

  /** Elimina el dispositivo de toda la base (telemetría, asignaciones, etiquetas, dashboards). */
  purgeDeviceGlobally(deviceId) {
    const did = String(deviceId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.st.telemetryDeleteByDevice.run(did);
      this.st.udDeleteAllForDevice.run(did);
      this.st.labelsDeleteByDevice.run(did);
      this.st.ddDeleteByDevice.run(did);
      this.st.decodeDelete.run(did);
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
    if (this.st.licGet.get(did)) return;
    const row = this.db
      .prepare('SELECT MIN(created_at) AS m FROM user_devices WHERE device_id = ?')
      .get(did);
    const start = (row && row.m) || new Date().toISOString();
    const startMs = new Date(start).getTime();
    const exp = new Date(startMs + LICENSE_DURATION_MS).toISOString();
    const nowIso = new Date().toISOString();
    this.st.licInsert.run(did, start, exp, nowIso);
  }

  getDeviceLicenseMeta(deviceId) {
    const r = this.st.licGet.get(String(deviceId));
    if (!r) return null;
    const now = Date.now();
    const expMs = new Date(r.expires_at).getTime();
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
    return atMs < new Date(r.expires_at).getTime();
  }

  renewDeviceLicense(deviceId) {
    const did = String(deviceId);
    const r = this.st.licGet.get(did);
    if (!r) return { ok: false, error: 'Este dispositivo no tiene registro de licencia' };
    const now = Date.now();
    const curExp = new Date(r.expires_at).getTime();
    const base = Math.max(now, curExp);
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
    this.st.udDeleteNonSuperForDevice.run(did);
  }

  runLicenseMaintenance() {
    const now = Date.now();
    const rows = this.st.licListAll.all();
    for (const lic of rows) {
      const expMs = new Date(lic.expires_at).getTime();
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
      const expMs = new Date(r.expires_at).getTime();
      if (now >= expMs) continue;
      if (expMs <= horizon) {
        out.push({
          deviceId: ud.deviceId,
          displayName: ud.displayName || ud.deviceId,
          expiresAt: r.expires_at,
          startedAt: r.started_at,
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

  /** [{ deviceId, userId, email, role, displayName }] */
  listUserDevicesWithAccounts() {
    return this.st.udJoinUsers.all().map((r) => ({
      deviceId: r.device_id,
      userId: r.user_id,
      email: r.email,
      role: r.role,
      displayName: r.display_name,
    }));
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
      lorawanClass: r.lorawan_class || '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listAutomationRules(userId) {
    return this.st.arList.all(userId).map((r) => {
      try {
        return JSON.parse(r.payload_json || '{}');
      } catch {
        return {};
      }
    });
  }

  replaceAutomationRules(userId, rules) {
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

  runRetentionPruneNow() {
    const cutoff = Date.now() - this.retentionMs;
    const info = this.st.pruneTelemetry.run(cutoff);
    const n = Number(info.changes || 0);
    if (n > 0) console.log(`[Syscom] Telemetría podada al arranque: ${n} filas (> retención)`);
  }

  close() {
    this.db.close();
  }
}

const sqlitePath = process.env.SYSCOM_SQLITE_PATH || DEFAULT_SQLITE;
const store = new Store(sqlitePath);
store.setRetentionMs(parseInt(process.env.SYSCOM_TELEMETRY_RETENTION_MS, 10) || 365 * 24 * 60 * 60 * 1000);
try {
  store.runRetentionPruneNow();
} catch (e) {
  console.warn('[Syscom] Poda inicial:', e.message);
}

module.exports = {
  store,
  Store,
  isEnsuredSuperadminEmail,
  ENSURED_SUPERADMIN_EMAIL,
  ENSURED_SUPERADMIN_EMAILS,
  LICENSE_SUPERADMIN_GRACE_MS,
  LICENSE_WARNING_BEFORE_EXPIRY_MS,
};
