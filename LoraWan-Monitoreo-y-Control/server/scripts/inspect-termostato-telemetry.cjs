'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'syscom.db'));
const uid = '1777495788737';
const did = '24e124715d419053';
const rows = db
  .prepare(
    `SELECT ts, properties_json FROM telemetry WHERE user_id = ? AND device_id = ? ORDER BY ts DESC LIMIT 15`
  )
  .all(uid, did);
for (const r of rows) {
  let p = r.properties_json;
  try {
    p = JSON.parse(p);
  } catch {
    p = {};
  }
  const keys = [
    'lorawan_class',
    'temperature_control_enable',
    'temperature_control_status',
    'system_status',
    'fPort',
    'payload_hex',
  ];
  const slice = {};
  for (const k of keys) {
    if (p[k] != null) slice[k] = p[k];
  }
  console.log(new Date(r.ts).toISOString(), JSON.stringify(slice));
}
