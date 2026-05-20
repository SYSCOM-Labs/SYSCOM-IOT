'use strict';

/**
 * Deja un solo dueño por EUI de gateway (por defecto SYSCOM_LNS_GATEWAY_PRIMARY_USER_ID o el primer user_id).
 *
 * Uso:
 *   node scripts/cleanup-lns-gateways.cjs --dry-run
 *   node scripts/cleanup-lns-gateways.cjs --apply
 *   node scripts/cleanup-lns-gateways.cjs --apply --keep-user=1777495788737
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dryRun = !apply || args.includes('--dry-run');
const keepArg = args.find((a) => a.startsWith('--keep-user='));
const keepUser = keepArg ? keepArg.split('=')[1] : process.env.SYSCOM_LNS_GATEWAY_PRIMARY_USER_ID || '1777495788737';

const dbPath = path.join(__dirname, '..', 'data', 'syscom.db');
const db = new DatabaseSync(dbPath);

function normEui(eui) {
  return String(eui || '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
}

const dups = db
  .prepare(
    `SELECT lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) AS eui_norm,
            GROUP_CONCAT(id) AS ids,
            GROUP_CONCAT(user_id) AS user_ids,
            COUNT(*) AS n
     FROM lorawan_gateways
     GROUP BY eui_norm HAVING n > 1`
  )
  .all();

if (dups.length === 0) {
  console.log('No hay gateways duplicados por EUI.');
  process.exit(0);
}

console.log(dryRun ? '[DRY-RUN] No se borra nada.' : '[APPLY] Borrando filas duplicadas.');
console.log('Usuario a conservar por EUI:', keepUser);

const delStmt = db.prepare('DELETE FROM lorawan_gateways WHERE id = ? AND user_id = ?');
let toDelete = 0;

for (const row of dups) {
  const rows = db
    .prepare(
      `SELECT id, user_id, name, gateway_eui FROM lorawan_gateways
       WHERE lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) = ?`
    )
    .all(row.eui_norm);

  const keep =
    rows.find((r) => String(r.user_id) === String(keepUser)) ||
    rows[0];
  console.log('\nEUI', row.eui_norm, '→ conservar', keep.user_id, keep.name || keep.gateway_eui);

  for (const r of rows) {
    if (String(r.id) === String(keep.id) && String(r.user_id) === String(keep.user_id)) continue;
    console.log('  eliminar:', r.user_id, r.id, r.name || r.gateway_eui);
    toDelete += 1;
    if (!dryRun) delStmt.run(r.id, r.user_id);
  }
}

console.log('\nTotal filas a eliminar:', toDelete);
if (dryRun) {
  console.log('Ejecute: node scripts/cleanup-lns-gateways.cjs --apply');
}
