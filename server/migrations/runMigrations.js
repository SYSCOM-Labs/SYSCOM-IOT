'use strict';

const fs = require('fs');
const path = require('path');
const migrationHooks = require('./migrationHooks');

const SQL_DIR = path.join(__dirname, 'sql');

/** IDs antiguos (NNN_) → nuevos (NNNN_) para BDs ya migradas. */
const LEGACY_ID_TO_NEW = {
  '001_initial_schema': '0001_initial_schema',
  '002_user_password_nullable': '0002_user_password_nullable',
  '003_user_legacy_columns': '0003_user_legacy_columns',
  '004_device_schema': '0004_device_schema',
  '005_lns_core': '0005_lns_core',
  '006_lns_extra_columns': '0006_lns_extra_columns',
  '007_lns_tx_inflight': '0007_lns_tx_inflight',
  '008_lns_ui_events': '0008_lns_ui_events',
  '009_roles_normalize': '0009_roles_normalize',
  '010_seed_bootstrap_superadmins': '0010_seed_bootstrap_superadmins',
};

const IGNORE_DUP_STATEMENTS = new Set([
  '0003_user_legacy_columns',
  '0006_lns_extra_columns',
]);

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function hasMigration(db, id) {
  const row = db.prepare('SELECT 1 AS x FROM schema_migrations WHERE id = ?').get(id);
  return Boolean(row);
}

function migrationIdPrefix4(id) {
  const m = String(id).match(/^(\d{4})_/);
  return m ? m[1] : '0';
}

function compareMigrationId(a, b) {
  const na = parseInt(migrationIdPrefix4(a), 10);
  const nb = parseInt(migrationIdPrefix4(b), 10);
  if (na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

function listMigrationIds() {
  let fromSql = [];
  try {
    fromSql = fs
      .readdirSync(SQL_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => path.basename(f, '.sql'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const fromHooks = Object.keys(migrationHooks);
  return [...new Set([...fromSql, ...fromHooks])].sort(compareMigrationId);
}

/**
 * Copia filas schema_migrations de IDs legacy a los nuevos NNNN_ sin re-ejecutar.
 */
function syncLegacySchemaMigrationIds(db) {
  const selOld = db.prepare('SELECT applied_at FROM schema_migrations WHERE id = ?');
  const ins = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  for (const [oldId, newId] of Object.entries(LEGACY_ID_TO_NEW)) {
    if (hasMigration(db, newId)) continue;
    const row = selOld.get(oldId);
    if (row) ins.run(newId, row.applied_at);
  }
}

function execStatementsIgnoreDuplicateColumn(db, sql) {
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));
  for (const st of statements) {
    try {
      db.exec(st + ';');
    } catch (e) {
      const msg = String(e.message || '');
      if (!msg.includes('duplicate column')) throw e;
    }
  }
}

function applySqlFile(db, id) {
  const filePath = path.join(SQL_DIR, `${id}.sql`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`[Syscom] Falta ${filePath} para migración ${id}`);
  }
  const sql = fs.readFileSync(filePath, 'utf8');
  if (IGNORE_DUP_STATEMENTS.has(id)) {
    execStatementsIgnoreDuplicateColumn(db, sql);
  } else {
    db.exec(sql);
  }
}

function applyMigration(db, id) {
  const hook = migrationHooks[id];
  if (hook) {
    hook(db);
    return;
  }
  applySqlFile(db, id);
}

/**
 * Aplica migraciones pendientes en orden (archivos `sql/NNNN_nombre.sql` + hooks en migrationHooks.js).
 */
function runMigrations(db) {
  ensureMigrationsTable(db);
  syncLegacySchemaMigrationIds(db);
  const ins = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  const ids = listMigrationIds();
  for (const id of ids) {
    if (hasMigration(db, id)) continue;
    applyMigration(db, id);
    ins.run(id, new Date().toISOString());
    console.log(`[Syscom] Migración aplicada: ${id}`);
  }
}

const MIGRATIONS = listMigrationIds().map((id) => ({ id, hasHook: Boolean(migrationHooks[id]) }));

module.exports = {
  runMigrations,
  MIGRATIONS,
  listMigrationIds,
};
