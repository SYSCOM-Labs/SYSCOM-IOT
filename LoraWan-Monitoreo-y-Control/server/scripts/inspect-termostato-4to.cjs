'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'syscom.db'));
const eui = '24e124715d419053';
const devs = db
  .prepare(
    `SELECT device_id, display_name, dev_eui, product_model, lorawan_class
     FROM user_devices WHERE dev_eui = ? OR display_name LIKE '%4to%' OR display_name LIKE '%4to piso%'`
  )
  .all(eui);
console.log('devices', devs);
for (const d of devs) {
  const cfg = db
    .prepare('SELECT channel, lorawan_class, product_model FROM device_decode_config WHERE device_id = ?')
    .get(d.device_id);
  const sess = db
    .prepare(
      'SELECT device_class, fcnt_down, last_rx_tmst, last_gateway_eui FROM lorawan_lns_sessions WHERE dev_eui = ?'
    )
    .get(d.dev_eui || eui);
  const presets = db.prepare('SELECT body_json FROM device_shared_presets WHERE device_id = ?').get(d.device_id);
  console.log('---', d.display_name, d.device_id);
  console.log('cfg', cfg);
  console.log('session', sess);
  if (presets) {
    try {
      const b = JSON.parse(presets.body_json);
      console.log(
        'presets',
        (b.downlinks || []).slice(0, 3).map((x) => `${x.name}:${x.hex}`)
      );
    } catch (e) {
      console.log('presets parse err');
    }
  }
}
const logs = db
  .prepare(
    `SELECT created_at, body_json FROM downlink_log
     WHERE body_json LIKE '%419053%' ORDER BY created_at DESC LIMIT 10`
  )
  .all();
console.log('downlink_log (recent)');
for (const r of logs) {
  let b = r.body_json;
  try {
    b = JSON.parse(b);
  } catch {}
  console.log(
    new Date(r.created_at).toISOString(),
    b?.payloadHex || b?.hex,
    'fPort',
    b?.fPort,
    'class',
    b?.deviceClass,
    b?.deferred,
    b?.deviceId
  );
}
const kv = db.prepare(`SELECT value FROM server_settings WHERE key = 'device_templates_catalog_v1'`).get();
if (kv) {
  try {
    const cat = JSON.parse(kv.value);
    const wt = (cat.templates || []).find((t) => String(t.modelo || '').includes('WT201'));
    if (wt) {
      console.log('catalog WT201 class', wt.lorawanClass, 'channel', wt.channel);
      console.log('catalog WT201 downlinks', (wt.downlinks || []).slice(0, 4).map((d) => `${d.name}:${d.hex}`));
    }
  } catch (e) {
    console.log('catalog parse', e.message);
  }
}
try {
  const def = db
    .prepare(
      `SELECT id, payload_hex, f_port, defer_reason, status FROM lorawan_lns_deferred_app_dl
       WHERE dev_eui = ? ORDER BY id DESC LIMIT 5`
    )
    .all(eui);
  console.log('deferred', def);
} catch (e) {
  console.log('deferred err', e.message);
}
