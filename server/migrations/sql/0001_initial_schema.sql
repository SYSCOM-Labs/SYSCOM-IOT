-- Esquema base (SQLite). Instalaciones nuevas y base para migraciones posteriores.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password TEXT,
  role TEXT,
  profile_name TEXT,
  created_by TEXT,
  created_by_email TEXT,
  ingest_token TEXT NOT NULL,
  created_at TEXT,
  milesight_ug_json TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  picture_url TEXT
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
