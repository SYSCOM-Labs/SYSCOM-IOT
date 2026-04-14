-- Ejecutado solo si users.password sigue NOT NULL (ver migrationHooks).
BEGIN IMMEDIATE;
ALTER TABLE users RENAME TO _users_backup;
CREATE TABLE users (
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
  must_change_password INTEGER NOT NULL DEFAULT 0
);
INSERT INTO users SELECT * FROM _users_backup;
DROP TABLE _users_backup;
COMMIT;
