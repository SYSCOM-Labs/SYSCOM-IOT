'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BOOTSTRAP_SUPERADMINS } = require('./bootstrap-admins');

const SQL_DIR = path.join(__dirname, 'sql');

function readSql(name) {
  return fs.readFileSync(path.join(SQL_DIR, name), 'utf8');
}

/**
 * 0002: solo si password sigue NOT NULL (instalaciones antiguas).
 */
function migration0002UserPasswordNullable(db) {
  try {
    const sql = readSql('0002_user_password_nullable.sql');
    const info = db.prepare('PRAGMA table_info(users)').all();
    const pwCol = info.find((c) => c.name === 'password');
    if (pwCol && pwCol.notnull === 1) {
      db.exec(sql);
      console.log('[Syscom] Migración: users.password ahora permite NULL (OAuth)');
    }
  } catch (e) {
    console.warn('[Syscom] Migración password nullable:', e.message);
  }
}

function chunksFrom0004Sql(raw) {
  const chunks = [];
  const parts = raw.split(/\n(?=-- @CHUNK )/);
  for (const p of parts) {
    const m = p.match(/^-- @CHUNK \w+\s*\n([\s\S]*)$/);
    if (m) chunks.push(m[1].trim());
  }
  return chunks;
}

/**
 * 0004: crea tablas, columnas opcionales en user_devices y rellena licencias.
 */
function migration0004DeviceSchema(db) {
  try {
    const raw = readSql('0004_device_schema.sql');
    const [decodeSql, licenseSql, backfillSql] = chunksFrom0004Sql(raw);
    db.exec(decodeSql);
    const cols = db.prepare('PRAGMA table_info(user_devices)').all();
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('app_eui')) db.exec('ALTER TABLE user_devices ADD COLUMN app_eui TEXT');
    if (!names.has('app_key')) db.exec('ALTER TABLE user_devices ADD COLUMN app_key TEXT');
    if (!names.has('tag')) db.exec('ALTER TABLE user_devices ADD COLUMN tag TEXT');
    if (!names.has('lorawan_class')) db.exec('ALTER TABLE user_devices ADD COLUMN lorawan_class TEXT');
    db.exec(licenseSql);
    db.exec(backfillSql);
  } catch (e) {
    console.warn('[Syscom] Migración device schema:', e.message);
  }
}

/**
 * 0009: normalización de roles + correos bootstrap como superadmin.
 */
function migration0009RolesNormalize(db) {
  try {
    db.exec(readSql('0009_roles_normalize.sql'));
    const stmt = db.prepare(`UPDATE users SET role = 'superadmin' WHERE lower(trim(email)) = ?`);
    for (const row of BOOTSTRAP_SUPERADMINS) {
      stmt.run(String(row.email).trim().toLowerCase());
    }
  } catch (e) {
    console.warn('[Syscom] Migración de roles:', e.message);
  }
}

/**
 * 0010: crea usuarios superadmin iniciales si no existen (tokens con crypto).
 */
function migration0010SeedBootstrapSuperadmins(db) {
  const byEmail = db.prepare('SELECT id FROM users WHERE lower(trim(email)) = ?');
  const insert = db.prepare(`
    INSERT INTO users (
      id, email, password, role, profile_name, created_by, created_by_email,
      ingest_token, created_at, milesight_ug_json, must_change_password, picture_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const row of BOOTSTRAP_SUPERADMINS) {
    const email = String(row.email).trim();
    const emailLower = email.toLowerCase();
    const existing = byEmail.get(emailLower);
    if (existing) continue;
    insert.run(
      crypto.randomUUID(),
      email,
      null,
      'superadmin',
      row.profileName || '',
      null,
      null,
      crypto.randomBytes(24).toString('hex'),
      now,
      null,
      0,
      null
    );
    console.log(`[Syscom] Usuario inicial creado (superadmin): ${email}`);
  }
  const ensure = db.prepare(`UPDATE users SET role = 'superadmin' WHERE lower(trim(email)) = ?`);
  for (const row of BOOTSTRAP_SUPERADMINS) {
    ensure.run(String(row.email).trim().toLowerCase());
  }
}

module.exports = {
  '0002_user_password_nullable': migration0002UserPasswordNullable,
  '0004_device_schema': migration0004DeviceSchema,
  '0009_roles_normalize': migration0009RolesNormalize,
  '0010_seed_bootstrap_superadmins': migration0010SeedBootstrapSuperadmins,
};
