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
