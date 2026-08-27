/**
 * Restablece la clave temporal de un usuario en el SQLite del servidor.
 *
 * En el VPS (producción):
 *   cd /opt/syscom-iot/app
 *   sudo -u syscom -H env SYSCOM_SQLITE_PATH=/var/lib/syscom-iot/data.sqlite \
 *     node scripts/set-provisional-password.mjs juan.martinez@syscom.mx
 *
 * Opcional, otra clave temporal (mín. 6 caracteres):
 *   node scripts/set-provisional-password.mjs usuario@empresa.com MiTemp1
 *
 * Tras el cambio, esa cuenta entra con la clave y debe definir una contraseña segura.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const defaultDb =
  process.env.SYSCOM_SQLITE_PATH || path.join(root, 'server', 'data', 'syscom.db');

const email = String(process.argv[2] || '')
  .trim()
  .toLowerCase();
const provisional = String(process.argv[3] || '123456').trim();

if (!email || !email.includes('@')) {
  console.error('Uso: node scripts/set-provisional-password.mjs correo@dominio [clave-temporal]');
  process.exit(1);
}
if (provisional.length < 6) {
  console.error('La clave temporal debe tener al menos 6 caracteres.');
  process.exit(1);
}

const dbPath = defaultDb;
if (!fs.existsSync(dbPath)) {
  console.error('No existe el SQLite:', dbPath);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const row = db.prepare('SELECT id, email, length(password) AS pw_len, substr(password, 1, 7) AS pw_pfx, must_change_password FROM users WHERE lower(email) = ?').get(email);
if (!row) {
  console.error('No hay usuario con ese correo:', email);
  db.close();
  process.exit(1);
}

const hash = bcrypt.hashSync(provisional, 10);
db.prepare('UPDATE users SET password = ?, must_change_password = 1 WHERE id = ?').run(hash, row.id);
const after = db.prepare('SELECT length(password) AS pw_len, substr(password, 1, 4) AS pw_pfx, must_change_password FROM users WHERE id = ?').get(row.id);
db.close();

console.log('Actualizado:', row.email);
console.log('Hash bcrypt:', String(after.pw_pfx) === '$2a$' || String(after.pw_pfx) === '$2b$' ? 'sí' : 'revisar');
console.log('Debe cambiar clave al entrar:', Number(after.must_change_password) === 1 ? 'sí' : 'no');
console.log('Ya puede iniciar sesión con la clave temporal y luego definir una segura.');
