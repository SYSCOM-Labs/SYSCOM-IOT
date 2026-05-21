'use strict';

const SMTP_SETTING_KEY = 'smtp_notification_config_v1';
const DAILY_COUNTER_KEY = 'smtp_daily_send_counter_v1';

function todayUtcKey() {
  return new Date().toISOString().slice(0, 10);
}

function readDailyCounter(store) {
  const raw = store.getServerSetting(DAILY_COUNTER_KEY);
  if (!raw || !String(raw).trim()) return { day: todayUtcKey(), count: 0 };
  try {
    const o = JSON.parse(String(raw));
    const day = o && o.day != null ? String(o.day) : todayUtcKey();
    const count = Math.max(0, parseInt(String(o.count ?? 0), 10) || 0);
    if (day !== todayUtcKey()) return { day: todayUtcKey(), count: 0 };
    return { day, count };
  } catch {
    return { day: todayUtcKey(), count: 0 };
  }
}

function writeDailyCounter(store, count) {
  store.setServerSetting(
    DAILY_COUNTER_KEY,
    JSON.stringify({ day: todayUtcKey(), count: Math.max(0, count) })
  );
}

function incrementDailyCounter(store) {
  const cur = readDailyCounter(store);
  const next = cur.count + 1;
  writeDailyCounter(store, next);
  return next;
}

function ensureOutboxSchema(store) {
  try {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS email_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        send_after_ms INTEGER NOT NULL,
        to_addr TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        meta_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox(status, send_after_ms);
    `);
  } catch (e) {
    console.warn('[smtp] outbox schema:', e && e.message);
  }
}

function enqueueEmail(store, row) {
  ensureOutboxSchema(store);
  const now = Date.now();
  const sendAfter = Math.max(now, parseInt(String(row.sendAfterMs ?? now), 10) || now);
  const info = store.db
    .prepare(
      `INSERT INTO email_outbox (created_at, send_after_ms, to_addr, subject, body_text, meta_json, attempts, last_error, status)
       VALUES (?, ?, ?, ?, ?, ?, 0, '', ?)`
    )
    .run(
      new Date().toISOString(),
      sendAfter,
      String(row.to || '').trim(),
      String(row.subject || '').slice(0, 998),
      String(row.text || ''),
      row.meta != null ? JSON.stringify(row.meta) : '',
      String(row.status || 'pending')
    );
  return Number(info.lastInsertRowid) || 0;
}

function listDueOutbox(store, limit) {
  ensureOutboxSchema(store);
  const lim = Math.max(1, Math.min(50, parseInt(String(limit || 10), 10) || 10));
  const now = Date.now();
  return store.db
    .prepare(
      `SELECT id, to_addr, subject, body_text, meta_json, attempts, status
       FROM email_outbox
       WHERE status IN ('pending', 'queued_limit')
         AND send_after_ms <= ?
       ORDER BY send_after_ms ASC, id ASC
       LIMIT ?`
    )
    .all(now, lim);
}

function markOutboxSent(store, id) {
  store.db
    .prepare(`UPDATE email_outbox SET status = 'sent', last_error = '' WHERE id = ?`)
    .run(id);
}

function markOutboxFailed(store, id, errMsg, retryMs) {
  const row = store.db.prepare('SELECT attempts FROM email_outbox WHERE id = ?').get(id);
  const attempts = (row && Number(row.attempts)) || 0;
  const nextAttempts = attempts + 1;
  const maxAttempts = Math.max(1, parseInt(String(process.env.SYSCOM_SMTP_MAX_ATTEMPTS || '5'), 10) || 5);
  if (nextAttempts >= maxAttempts) {
    store.db
      .prepare(`UPDATE email_outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`)
      .run(nextAttempts, String(errMsg || '').slice(0, 2000), id);
    return;
  }
  const delay = Math.max(60000, parseInt(String(retryMs || 300000), 10) || 300000);
  store.db
    .prepare(
      `UPDATE email_outbox SET status = 'pending', attempts = ?, last_error = ?, send_after_ms = ? WHERE id = ?`
    )
    .run(nextAttempts, String(errMsg || '').slice(0, 2000), Date.now() + delay, id);
}

function pruneOldOutbox(store) {
  ensureOutboxSchema(store);
  const days = Math.max(7, parseInt(String(process.env.SYSCOM_SMTP_OUTBOX_RETENTION_DAYS || '30'), 10) || 30);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  store.db
    .prepare(`DELETE FROM email_outbox WHERE status IN ('sent', 'failed') AND created_at < ?`)
    .run(cutoff);
}

function countOutboxPending(store) {
  ensureOutboxSchema(store);
  const row = store.db
    .prepare(`SELECT COUNT(*) AS c FROM email_outbox WHERE status IN ('pending', 'queued_limit')`)
    .get();
  return Number(row && row.c) || 0;
}

function msUntilNextUtcDay() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(60000, next.getTime() - now.getTime());
}

module.exports = {
  SMTP_SETTING_KEY,
  readDailyCounter,
  incrementDailyCounter,
  enqueueEmail,
  listDueOutbox,
  markOutboxSent,
  markOutboxFailed,
  pruneOldOutbox,
  countOutboxPending,
  msUntilNextUtcDay,
};
