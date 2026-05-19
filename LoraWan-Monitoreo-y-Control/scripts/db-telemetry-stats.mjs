/**
 * Diagnóstico de tamaño de syscom.db y tabla telemetry.
 * Uso (desde LoraWan-Monitoreo-y-Control):
 *   node scripts/db-telemetry-stats.mjs
 *   node scripts/db-telemetry-stats.mjs --prune --vacuum
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function loadEnvFile() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    if (process.env[k] != null && process.env[k] !== '') continue;
    process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}

loadEnvFile();

const args = new Set(process.argv.slice(2));
const doPrune = args.has('--prune');
const doVacuum = args.has('--vacuum');
const doPruneGateways = args.has('--prune-gateways');

const { store } = require(join(root, 'server', 'store.js'));

const stats = store.getTelemetryStorageStats();
const fmt = (n) => (n != null && Number.isFinite(n) ? new Date(n).toLocaleString() : '—');

console.log('\n=== SYSCOM IoT — estadísticas de almacenamiento ===\n');
console.log('Ruta SQLite:', stats.sqlitePath);
console.log('Tamaño archivo:', (stats.fileBytes / (1024 * 1024)).toFixed(2), 'MB');
if (stats.walBytes > 0) {
  console.log('WAL (-wal):', (stats.walBytes / (1024 * 1024)).toFixed(2), 'MB');
}
console.log('Retención configurada:', stats.retentionDays, 'días');
console.log('Filas en telemetry:', stats.totalRows.toLocaleString());
console.log('Usuarios distintos:', stats.distinctUsers);
console.log('Dispositivos distintos:', stats.distinctDevices);
console.log('Filas con evento join:', stats.joinEventRows.toLocaleString());
console.log('Telemetría más antigua:', fmt(stats.oldestTs));
console.log('Telemetría más reciente:', fmt(stats.newestTs));

if (stats.topDevicesByRows.length) {
  console.log('\nTop dispositivos por filas:');
  for (const d of stats.topDevicesByRows) {
    console.log(`  ${d.deviceId}: ${d.rows.toLocaleString()}`);
  }
}

if (stats.topUsersByRows.length) {
  console.log('\nTop cuentas por filas (pool superadmin duplica uplinks):');
  for (const u of stats.topUsersByRows) {
    console.log(`  ${u.userId}: ${u.rows.toLocaleString()}`);
  }
}

if (stats.totalRows > 300000) {
  console.log(
    '\n⚠ La BD es grande. Recomendado en .env:\n' +
      '   SYSCOM_TELEMETRY_RETENTION_MS=7776000000   # 90 días\n' +
      'Luego: npm run db:prune -- --vacuum'
  );
}

if (doPruneGateways) {
  console.log('\n--- Poda telemetría gateway (conserva últimas 48 h) ---');
  const g = store.pruneGatewayTelemetryHistory();
  console.log('Eliminadas:', g.deleted.toLocaleString(), 'filas gateway antiguas');
  if (doVacuum && g.deleted > 0) {
    store.db.exec('VACUUM');
    console.log('VACUUM ejecutado.');
  }
}

if (doPrune) {
  console.log('\n--- Poda según retención ---');
  const r = store.runRetentionPruneNow({ vacuum: doVacuum && !doPruneGateways });
  console.log('Eliminadas:', r.deleted.toLocaleString(), 'filas');
  if (r.vacuumed) console.log('VACUUM ejecutado.');
  const after = store.getTelemetryStorageStats();
  console.log('Tamaño tras poda:', (after.fileBytes / (1024 * 1024)).toFixed(2), 'MB');
  console.log('Filas restantes:', after.totalRows.toLocaleString());
}

console.log('');

store.close();
process.exit(0);
