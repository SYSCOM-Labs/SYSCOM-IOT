'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'syscom.db');
const db = new DatabaseSync(dbPath);

const gw = db
  .prepare(
    `SELECT id, user_id, name, gateway_eui, frequency_band, created_at
     FROM lorawan_gateways ORDER BY lower(gateway_eui), user_id`
  )
  .all();

console.log('=== lorawan_gateways (' + gw.length + ') ===');
for (const r of gw) console.log(JSON.stringify(r));

const dup = db
  .prepare(
    `SELECT lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) AS eui,
            GROUP_CONCAT(user_id) AS users,
            COUNT(*) AS n
     FROM lorawan_gateways
     GROUP BY eui HAVING n > 1`
  )
  .all();

console.log('\n=== duplicate EUI across users ===');
for (const r of dup) console.log(JSON.stringify(r));

try {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const nameCol = cols.includes('email') ? 'email' : cols.includes('username') ? 'username' : 'id';
  const users = db.prepare(`SELECT id, ${nameCol} AS label, role FROM users ORDER BY id`).all();
  console.log('\n=== users ===');
  for (const r of users) console.log(JSON.stringify(r));
} catch (e) {
  console.log('\n=== users (skip):', e.message);
}
