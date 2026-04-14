-- @CHUNK decode
CREATE TABLE IF NOT EXISTS device_decode_config (
  device_id TEXT PRIMARY KEY,
  decoder_script TEXT,
  channel TEXT,
  updated_at TEXT NOT NULL
);

-- @CHUNK license
CREATE TABLE IF NOT EXISTS device_license (
  device_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- @CHUNK backfill
INSERT OR IGNORE INTO device_license (device_id, started_at, expires_at, updated_at)
SELECT
  device_id,
  MIN(created_at),
  datetime(MIN(created_at), '+365 days'),
  datetime('now')
FROM user_devices
GROUP BY device_id;
