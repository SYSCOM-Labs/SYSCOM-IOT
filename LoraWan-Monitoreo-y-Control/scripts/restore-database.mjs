/**
 * Restaura server/data/syscom.db desde un respaldo .db (detenga npm start antes).
 *
 *   node scripts/restore-database.mjs
 *   node scripts/restore-database.mjs server/data/backups/syscom-2026-05-19T06-00-00.db
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'server', 'data');
const mainDb = join(dataDir, 'syscom.db');
const backupDir = join(dataDir, 'backups');

function pickLatestBackup() {
  if (!existsSync(backupDir)) throw new Error(`No existe ${backupDir}`);
  const candidates = readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => join(backupDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!candidates.length) throw new Error('No hay archivos .db en server/data/backups');
  return candidates[0];
}

const srcArg = process.argv[2];
const src = srcArg ? resolve(process.cwd(), srcArg) : pickLatestBackup();

if (!existsSync(src)) {
  console.error('No se encontró respaldo:', src);
  process.exit(1);
}
const magic = readFileSync(src).subarray(0, 15).toString('utf8');
if (magic !== 'SQLite format 3') {
  console.error('No es SQLite válido:', src);
  process.exit(1);
}

const stamp = Date.now();
const safety = `${mainDb}.antes-restore-${stamp}.bak`;
console.log('Origen:', src);
console.log('Destino:', mainDb);
console.log('Copia de seguridad del estado actual →', safety);

try {
  copyFileSync(mainDb, safety);
} catch (e) {
  console.warn('(sin copia previa del main db)', e.message);
}

for (const suffix of ['-wal', '-shm']) {
  try {
    unlinkSync(`${mainDb}${suffix}`);
  } catch {
    /* ignore */
  }
}

copyFileSync(src, mainDb);
console.log('✅ Base restaurada. Reinicie: npm start');
console.log('   Respaldo del estado vacío guardado en:', safety);
