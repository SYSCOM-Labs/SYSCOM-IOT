'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'syscom.db'));
const uid = '1777495788737';
const eui = '24e124777e282770';
const devs = db.prepare('SELECT device_id, display_name FROM user_devices WHERE dev_eui = ?').all(eui);
console.log('devices', devs);
for (const d of devs) {
  const rows = db
    .prepare(
      'SELECT ts, properties_json FROM telemetry WHERE user_id = ? AND device_id = ? ORDER BY ts DESC LIMIT 8'
    )
    .all(uid, d.device_id);
  for (const r of rows) {
    let p = r.properties_json;
    if (typeof p === 'string') try { p = JSON.parse(p); } catch { p = {}; }
    const keys = p && typeof p === 'object' ? Object.keys(p).slice(0, 12) : [];
    console.log(d.device_id, new Date(r.ts).toISOString(), 'keys=', keys.join(','));
    if (p?.lorawan_class != null || p?.switch_1 != null) {
      console.log('  lorawan_class=', p.lorawan_class, 'switch_1=', p.switch_1);
    }
  }
}
const cfg = db
  .prepare(
    'SELECT device_id, channel, lorawan_class, product_model FROM device_decode_config WHERE device_id = ? OR device_id = ?'
  )
  .all(eui, devs[0]?.device_id || '');
console.log('decode-config', cfg);
const sess = db
  .prepare(
    'SELECT device_class, fcnt_down, last_rx_tmst, last_gateway_eui FROM lorawan_lns_sessions WHERE dev_eui = ?'
  )
  .get(eui);
console.log('session', sess);
