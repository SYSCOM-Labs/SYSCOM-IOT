CREATE TABLE IF NOT EXISTS lorawan_lns_tx_inflight (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_eui TEXT NOT NULL,
  token_h INTEGER NOT NULL,
  token_l INTEGER NOT NULL,
  downlink_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lns_tx_inflight_gw_tok ON lorawan_lns_tx_inflight(gateway_eui, token_h, token_l, id);
