'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'syscom.db');
const db = new DatabaseSync(dbPath);
const PRIMARY = process.env.SYSCOM_LNS_GATEWAY_PRIMARY_USER_ID || '1777495788737';
const now = Date.now();
const hourAgo = now - 3600000;

const gateways = db
  .prepare(
    `SELECT user_id, name, gateway_eui, frequency_band FROM lorawan_gateways ORDER BY gateway_eui, user_id`
  )
  .all();

const dupGw = db
  .prepare(
    `SELECT lower(replace(replace(replace(gateway_eui,':',''),'-',''),' ','')) AS eui,
            GROUP_CONCAT(user_id) AS users, COUNT(*) AS n
     FROM lorawan_gateways GROUP BY eui HAVING n > 1`
  )
  .all();

const devices = db
  .prepare(
    `SELECT device_id, display_name, dev_eui, product_model, lorawan_class FROM user_devices
     WHERE user_id = ? ORDER BY display_name`
  )
  .all(PRIMARY);

const sessions = db
  .prepare(
    `SELECT dev_eui, dev_addr, device_class, last_gateway_eui, fcnt_up, fcnt_down,
            last_uplink_wall_ms, updated_at
     FROM lorawan_lns_sessions WHERE user_id = ? ORDER BY dev_eui`
  )
  .all(PRIMARY);

const recentTel = db
  .prepare(
    `SELECT device_id, MAX(ts) AS last_ts, COUNT(*) AS n
     FROM telemetry WHERE user_id = ? AND ts >= ?
     GROUP BY device_id ORDER BY last_ts DESC`
  )
  .all(PRIMARY, hourAgo);

const telByDev = new Map(recentTel.map((r) => [r.device_id, r]));

const fleet = [
  { key: 'apagador', eui: '24e124777e282770', name: 'Apagador WS501' },
  { key: 'termostato_daniel', eui: '24e124715d413242', name: 'Termostato Daniel' },
  { key: 'termostato_4to', eui: '24e124715d419053', name: 'Termostato 4to Piso' },
];

console.log('=== FLEET HEALTH ===');
console.log('Cuenta principal:', PRIMARY);
console.log('Hora servidor (aprox):', new Date(now).toISOString());
console.log('');

console.log('--- Gateways ---');
for (const g of gateways) {
  const age = telByDev.has(`gateway-${g.gateway_eui?.slice(-10)}`) ? 'ok' : '';
  console.log(
    JSON.stringify({
      user: g.user_id,
      name: g.name,
      eui: g.gateway_eui,
      band: g.frequency_band,
      duplicate: dupGw.some((d) => g.gateway_eui?.toLowerCase().includes(d.eui.slice(-12))),
    })
  );
}
if (dupGw.length) {
  console.log('DUPLICADOS EUI:', JSON.stringify(dupGw));
} else {
  console.log('Sin EUI duplicado entre cuentas.');
}

console.log('\n--- Dispositivos alta (cuenta principal) ---');
for (const d of devices) {
  const eui = (d.dev_eui || '').toLowerCase();
  const sess = sessions.find((s) => (s.dev_eui || '').toLowerCase() === eui);
  const tel = [...telByDev.entries()].find(
    ([id]) => id.includes(eui.slice(-8)) || eui && id.toLowerCase().includes(eui)
  );
  const lastMs = sess?.last_uplink_wall_ms || (tel ? tel[1].last_ts : null);
  const mins = lastMs ? Math.round((now - Number(lastMs)) / 60000) : null;
  console.log(
    JSON.stringify({
      name: d.display_name,
      devEui: d.dev_eui,
      model: d.product_model,
      classCfg: d.lorawan_class,
      session: sess
        ? {
            devAddr: sess.dev_addr,
            class: sess.device_class,
            gw: sess.last_gateway_eui,
            fcntUp: sess.fcnt_up,
            minsSinceUplink: mins,
          }
        : null,
      telemetryLastHour: tel ? tel[1].n : 0,
    })
  );
}

console.log('\n--- Sesiones LNS sin dispositivo en alta (huérfanas) ---');
const devEuis = new Set(devices.map((d) => (d.dev_eui || '').toLowerCase()));
for (const s of sessions) {
  if (!devEuis.has((s.dev_eui || '').toLowerCase())) {
    console.log(JSON.stringify({ devEui: s.dev_eui, devAddr: s.dev_addr, gw: s.last_gateway_eui }));
  }
}

console.log('\n--- Resumen flota objetivo ---');
for (const f of fleet) {
  const d = devices.find((x) => (x.dev_eui || '').toLowerCase() === f.eui);
  const s = sessions.find((x) => (x.dev_eui || '').toLowerCase() === f.eui);
  const mins = s?.last_uplink_wall_ms ? Math.round((now - Number(s.last_uplink_wall_ms)) / 60000) : null;
  let status = 'sin_sesion';
  if (s && mins != null && mins < 15) status = 'ok';
  else if (s && mins != null && mins < 120) status = 'lento';
  else if (s) status = 'sin_uplink_reciente';
  console.log(`${f.name}: ${status} (uplink hace ${mins != null ? mins + ' min' : '?'})`);
}
