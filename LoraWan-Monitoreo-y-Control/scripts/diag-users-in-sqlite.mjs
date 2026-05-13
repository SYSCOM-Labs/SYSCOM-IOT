/**
 * Muestra cuántos usuarios hay en el SQLite que usa el servidor (misma lógica de ruta que store).
 * Uso (PowerShell, desde LoraWan-Monitoreo-y-Control):
 *   node scripts/diag-users-in-sqlite.mjs
 * Con ruta explícita (igual que SYSCOM_SQLITE_PATH):
 *   node scripts/diag-users-in-sqlite.mjs "C:\ruta\syscom.db"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const defaultDb = path.join(root, 'server', 'data', 'syscom.db');
const dbPath = process.argv[2] || process.env.SYSCOM_SQLITE_PATH || defaultDb;

if (!fs.existsSync(dbPath)) {
  console.log('Archivo no existe (0 usuarios lógicos → asistente de primer superadmin):');
  console.log(' ', dbPath);
  process.exit(0);
}

const db = new DatabaseSync(dbPath);
const row = db.prepare('SELECT COUNT(*) AS c FROM users').get();
const n = Number(row && row.c) || 0;
console.log('SQLite:', dbPath);
console.log('Usuarios en tabla `users`:', n);
if (n > 0) {
  const list = db.prepare('SELECT email, role FROM users LIMIT 25').all();
  console.log('Filas:', list);
}
console.log('');
console.log('needsSetup en API sería:', n === 0 ? 'true (formulario primer superadmin)' : 'false (login)');
db.close();
