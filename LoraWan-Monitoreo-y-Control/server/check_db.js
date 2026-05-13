const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'data', 'syscom.db'));
const deviceId = '24e124535c487937';
const stmt = db.prepare('SELECT * FROM telemetry WHERE device_id = ? ORDER BY ts DESC LIMIT 10');
const rows = stmt.all(deviceId);
console.log(JSON.stringify(rows, null, 2));
