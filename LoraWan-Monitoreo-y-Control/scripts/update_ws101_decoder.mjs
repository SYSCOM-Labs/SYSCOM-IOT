import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { WS101_DECODER_SCRIPT } from '../src/constants/ws101DecoderScript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../server/data/syscom.db');

/** Mismo script y canal que la plantilla WS101 (FPort app / downlink Milesight: 85). */
const decoderScript = WS101_DECODER_SCRIPT;
const channel = '85';

const deviceId = process.argv[2] || '24e124535c487937';

const db = new DatabaseSync(dbPath);
try {
  db.prepare(
    'INSERT OR REPLACE INTO device_decode_config (device_id, decoder_script, channel, updated_at) VALUES (?, ?, ?, ?)'
  ).run(deviceId, decoderScript, channel, new Date().toISOString());
  console.log('Decoder WS101 actualizado (channel=' + channel + ') para device_id=', deviceId);
} catch (err) {
  console.error(err);
  process.exit(1);
}
