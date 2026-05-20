#!/usr/bin/env node
/**
 * Re-aplica decoders guardados a filas de telemetría con payload_hex sin campos de aplicación.
 *
 * Uso:
 *   node scripts/redecode-device-telemetry.mjs
 *   node scripts/redecode-device-telemetry.mjs 24e124715d419053
 *   node scripts/redecode-device-telemetry.mjs --dry-run
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', 'server');
const { store } = await import(pathToFileURL(path.join(serverDir, 'store.js')).href);
const { tryApplyStoredDecoder } = await import(pathToFileURL(path.join(serverDir, 'payload-decoder.js')).href);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const deviceFilter = args.find((a) => !a.startsWith('-'));

function rowHasAppFields(props) {
  if (!props || typeof props !== 'object') return false;
  const keys = Object.keys(props);
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl === 'payload_hex' || kl === 'payload_b64' || kl.startsWith('lorawan_')) continue;
    if (/^(rssi|snr|lsnr|freq|datr|dr|gateway_id|devaddr|fcnt|fport|connectstatus)$/i.test(kl)) continue;
    if (props[k] != null && props[k] !== '') return true;
  }
  return false;
}

const userIds = store.listSuperadminUserIds?.().length
  ? store.listSuperadminUserIds()
  : [1];
let updated = 0;
let scanned = 0;

for (const uid of userIds) {
  const devices = store.listUserDevices(uid) || [];
  for (const ud of devices) {
    const did = String(ud.deviceId || '').trim();
    if (!did) continue;
    if (deviceFilter && did !== deviceFilter && String(ud.devEUI || '') !== deviceFilter) continue;

    const history = store.getTelemetryHistory(uid, did, { limit: 200 });
    for (const row of history) {
      scanned += 1;
      const props = row.properties && typeof row.properties === 'object' ? { ...row.properties } : null;
      if (!props) continue;
      const hex = props.payload_hex != null ? String(props.payload_hex).trim() : '';
      if (hex.length < 4) continue;
      if (rowHasAppFields(props)) continue;

      tryApplyStoredDecoder(store, did, did, props);
      if (!rowHasAppFields(props)) continue;

      if (!dryRun) {
        store.patchTelemetryPropertiesAt(uid, did, row.timestamp, props);
      }
      updated += 1;
      console.log(`[redecode] ${did} @ ${row.timestamp} → ${Object.keys(props).filter((k) => !/^payload_|^lorawan_|^rssi$|^snr$/i.test(k)).slice(0, 8).join(', ')}`);
    }
  }
}

console.log(`Listo: ${scanned} filas revisadas, ${updated} ${dryRun ? 'decodificables (dry-run)' : 'actualizadas'}.`);
