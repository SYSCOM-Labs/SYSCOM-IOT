CREATE TABLE IF NOT EXISTS lns_ui_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  dev_eui TEXT NOT NULL,
  event_type TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lns_ui_ev_user_time ON lns_ui_events(user_id, created_at);
