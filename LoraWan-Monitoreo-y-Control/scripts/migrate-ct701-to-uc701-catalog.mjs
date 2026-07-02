/**
 * Renombra plantilla CT701 → UC701 en SQLite y aplica decoder + downlinks de semilla.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { UC701_DECODER_SCRIPT } from '../src/constants/uc701DecoderScript.js';
import { UC701_DOWNLINK_PRESETS } from '../src/constants/uc701DownlinkPresets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'server/data/syscom.db');
const db = new DatabaseSync(dbPath);
const row = db
  .prepare("SELECT value FROM server_settings WHERE key = 'device_templates_catalog_v1'")
  .get();
if (!row?.value) {
  console.log('No catalog in SQLite');
  process.exit(0);
}
const cat = JSON.parse(row.value);
const templates = Array.isArray(cat.templates) ? cat.templates : [];
let changed = false;

for (const t of templates) {
  const modelo = String(t.modelo || '').trim().toUpperCase();
  if (modelo !== 'CT701' && modelo !== 'UC701') continue;
  t.modelo = 'UC701';
  t.marca = t.marca || 'Milesight';
  t.channel = String(t.channel || '85').trim();
  t.lorawanClass = t.lorawanClass || 'C';
  t.decoderScript = UC701_DECODER_SCRIPT;
  t.downlinks = UC701_DOWNLINK_PRESETS.map((d) => ({ ...d }));
  changed = true;
  console.log('Updated template', t.id, '→ UC701, downlinks:', t.downlinks.length);
}

if (!changed) {
  console.log('No CT701/UC701 template found in catalog');
  process.exit(0);
}

cat.updatedAt = new Date().toISOString();
db.prepare(
  "INSERT INTO server_settings (key, value, updated_at) VALUES ('device_templates_catalog_v1', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
).run(JSON.stringify(cat), new Date().toISOString());
console.log('SQLite catalog saved');
