import { Database } from 'node:sqlite';
const db = new Database('server/data/syscom.db');
const deviceId = '24e124535c487937';
const rows = db.prepare('SELECT * FROM telemetry WHERE device_id = ? ORDER BY timestamp DESC LIMIT 10').all(deviceId);
console.log(JSON.stringify(rows, null, 2));
db.close();
