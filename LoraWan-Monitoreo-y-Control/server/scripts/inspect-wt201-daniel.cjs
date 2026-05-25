'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'syscom.db'));
const eui = '24e124715d418848';
const ud = db
  .prepare(
    `SELECT device_id, display_name, dev_eui, product_model, lorawan_class
     FROM user_devices WHERE dev_eui = ?`
  )
  .get(eui);
console.log('user_device', ud);
if (!ud) {
  console.log('NOT REGISTERED');
  process.exit(0);
}
const did = ud.device_id;
const cfg = db
  .prepare('SELECT channel, lorawan_class, product_model FROM device_decode_config WHERE device_id = ?')
  .get(did);
console.log('decode_config', cfg);
const sess = db
  .prepare(
    `SELECT dev_addr, device_class, fcnt_up, fcnt_down, updated_at
     FROM lorawan_lns_sessions WHERE dev_eui = ?`
  )
  .get(eui);
console.log('session', sess);
const uid = '1777495788737';
const rows = db
  .prepare(
    `SELECT ts, properties_json FROM telemetry
     WHERE user_id = ? AND device_id = ? ORDER BY ts DESC LIMIT 15`
  )
  .all(uid, did);
console.log('history rows:', rows.length);
for (const r of rows) {
  let p = {};
  try {
    p = JSON.parse(r.properties_json || '{}');
  } catch {
    /* ignore */
  }
  const ev = p.lorawan_event || '';
  const hex = (p.payload_hex || '').length;
  const cs = p.connectStatus || p.status || '';
  const keys = Object.keys(p).filter((k) => !/^(lorawan_|payload_|devEui|rssi|snr|fcnt|fPort)/i.test(k)).slice(0, 8);
  console.log(
    new Date(r.ts).toISOString(),
    '| join=', /join/i.test(String(ev)),
    '| hexLen=', hex,
    '| cs=', cs,
    '| sample=', keys.join(',')
  );
}
const latest = db
  .prepare(
    `SELECT ts, properties_json FROM telemetry
     WHERE user_id = ? AND device_id = ? ORDER BY ts DESC LIMIT 1`
  )
  .get(uid, did);
if (latest) {
  let p = {};
  try {
    p = JSON.parse(latest.properties_json || '{}');
  } catch {
    /* ignore */
  }
  console.log('telemetry_latest', new Date(latest.ts).toISOString(), {
    lorawan_event: p.lorawan_event,
    payload_hex_len: (p.payload_hex || '').length,
    connectStatus: p.connectStatus || p.status,
    temperature: p.temperature,
    target_temperature: p.target_temperature,
  });
}
