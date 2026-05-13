/**
 * Vacía usuarios y datos vinculados para volver a ver el asistente de primer superadmin
 * (tabla `users` vacía → GET /api/setup/status → needsSetup: true).
 *
 * Uso (con el servidor Node DETENIDO para evitar bloqueo WAL):
 *   node scripts/reset-bootstrap-local.mjs
 *
 * Ruta de SQLite (opcional, por defecto server/data/syscom.db o SYSCOM_SQLITE_PATH):
 *   node scripts/reset-bootstrap-local.mjs "C:\ruta\syscom.db"
 *
 * Opcional: borrar el marcador de migración desde db.json para permitir reimportación
 * si define SYSCOM_IMPORT_LEGACY_DB_JSON=1:
 *   node scripts/reset-bootstrap-local.mjs --remove-migrate-marker
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'server', 'data');
const defaultDb = path.join(dataDir, 'syscom.db');
const migrateMarker = path.join(dataDir, '.migrated-from-json');

const args = process.argv.slice(2).filter((a) => a !== '--remove-migrate-marker');
const removeMarker = process.argv.includes('--remove-migrate-marker');
const dbPath = args[0] || process.env.SYSCOM_SQLITE_PATH || defaultDb;

if (!fs.existsSync(dbPath)) {
  console.log('No existe el archivo SQLite (ya está “vacío” a efectos de usuarios):');
  console.log(' ', dbPath);
  if (removeMarker && fs.existsSync(migrateMarker)) {
    fs.unlinkSync(migrateMarker);
    console.log('Eliminado:', migrateMarker);
  }
  process.exit(0);
}

/** Orden: tablas con user_id / dispositivos antes que `users`. */
const DELETE_ORDER = [
  'lns_ui_events',
  'lorawan_lns_tx_inflight',
  'lorawan_lns_downlink',
  'lorawan_lns_deferred_app_dl',
  'lns_integration_token',
  'lorawan_lns_sessions',
  'downlink_log',
  'automation_rules',
  'device_dashboard',
  'device_bsd_preferences',
  'device_labels',
  'telemetry',
  'lorawan_gateways',
  'user_devices',
  'device_license',
  'device_decode_config',
  'users',
];

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = OFF;');
db.exec('BEGIN IMMEDIATE;');
try {
  for (const table of DELETE_ORDER) {
    try {
      db.exec(`DELETE FROM ${table}`);
    } catch (e) {
      if (!String(e.message || '').includes('no such table')) {
        throw e;
      }
    }
  }
  db.exec('COMMIT;');
} catch (e) {
  try {
    db.exec('ROLLBACK;');
  } catch {
    /* ignore */
  }
  throw e;
}
db.close();

if (removeMarker && fs.existsSync(migrateMarker)) {
  fs.unlinkSync(migrateMarker);
  console.log('Eliminado marcador:', migrateMarker);
}

const n = (() => {
  const d = new DatabaseSync(dbPath);
  const row = d.prepare('SELECT COUNT(*) AS c FROM users').get();
  d.close();
  return Number(row && row.c) || 0;
})();

console.log('Listo. SQLite:', dbPath);
console.log('Usuarios restantes:', n, '(debe ser 0 → ventana de primer superadmin tras arrancar el API).');
