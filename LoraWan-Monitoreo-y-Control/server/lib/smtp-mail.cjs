'use strict';

const crypto = require('crypto');
const { normalizeProviderId, getProviderPreset, listProviderPresetsPublic } = require('./smtp-providers.cjs');
const queue = require('./smtp-queue.cjs');

let _nodemailer;
function getNodemailer() {
  if (_nodemailer) return _nodemailer;
  try {
    _nodemailer = require('nodemailer');
    return _nodemailer;
  } catch (e) {
    const err = new Error(
      'nodemailer no está instalado. Ejecute: npm install (en la carpeta LoraWan-Monitoreo-y-Control).'
    );
    err.code = 'MODULE_MISSING';
    throw err;
  }
}

function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  if (at <= 1) return '***';
  return `${s.slice(0, 2)}***${s.slice(at)}`;
}

function readStoredConfig(store) {
  const raw = store.getServerSetting(queue.SMTP_SETTING_KEY);
  if (!raw || !String(raw).trim()) return null;
  try {
    const o = JSON.parse(String(raw));
    if (!o || typeof o !== 'object') return null;
    return o;
  } catch {
    return null;
  }
}

function deriveEncKey() {
  const secret = String(
    process.env.SYSCOM_SMTP_ENCRYPTION_KEY || process.env.JWT_SECRET || ''
  ).trim();
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function encryptPass(plain) {
  const key = deriveEncKey();
  if (!key || !plain) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptPass(stored) {
  const s = String(stored || '');
  if (!s.startsWith('enc:')) return s;
  const key = deriveEncKey();
  if (!key) return '';
  const parts = s.split(':');
  if (parts.length !== 4) return '';
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Config efectiva: variables de entorno tienen prioridad sobre SQLite.
 * @param {import('../store.js').SyscomStore} store
 */
function resolveSmtpConfig(store) {
  const stored = readStoredConfig(store) || {};
  const provider = normalizeProviderId(
    process.env.SYSCOM_SMTP_PROVIDER || stored.provider || 'gmail'
  );
  const preset = getProviderPreset(provider);
  const envUser = String(process.env.SYSCOM_SMTP_USER || process.env.SYSCOM_SMTP_FROM || '').trim();
  const envPass = String(process.env.SYSCOM_SMTP_PASS || '').trim();
  const user = envUser || String(stored.user || stored.from || '').trim();
  const pass =
    envPass ||
    decryptPass(stored.passEnc || stored.pass || '') ||
    String(stored.passPlain || '').trim();
  const host = String(process.env.SYSCOM_SMTP_HOST || stored.host || preset.host || '').trim();
  const portRaw = process.env.SYSCOM_SMTP_PORT ?? stored.port ?? preset.port;
  const port = Math.max(1, parseInt(String(portRaw), 10) || 587);
  const secure = String(process.env.SYSCOM_SMTP_SECURE || stored.secure || '0').trim() === '1';
  const fromName = String(process.env.SYSCOM_SMTP_FROM_NAME || stored.fromName || 'SYSCOM IoT').trim();
  const dailyLimit = Math.max(
    1,
    parseInt(String(process.env.SYSCOM_SMTP_DAILY_LIMIT || stored.dailyLimit || preset.dailyLimit), 10) ||
      preset.dailyLimit
  );
  const configured = Boolean(user && pass && host);
  return buildResolvedConfig({
    configured,
    provider,
    user,
    pass,
    host,
    port: secure ? 465 : port,
    secure,
    from: user,
    fromName,
    dailyLimit,
    credentialsFromEnv: Boolean(envUser && envPass),
    hasStoredPassword: Boolean(stored.passEnc || stored.pass || stored.passPlain),
  });
}

function buildResolvedConfig(fields) {
  return {
    configured: fields.configured,
    provider: fields.provider,
    user: fields.user,
    pass: fields.pass,
    host: fields.host,
    port: fields.port,
    secure: fields.secure,
    from: fields.from,
    fromName: fields.fromName,
    dailyLimit: fields.dailyLimit,
    credentialsFromEnv: fields.credentialsFromEnv,
    hasStoredPassword: fields.hasStoredPassword,
  };
}

/** Credenciales del cuerpo de «prueba» (no se guardan). */
function resolveSmtpConfigWithOverride(store, override) {
  const base = resolveSmtpConfig(store);
  if (!override || typeof override !== 'object') return base;
  const o = override;
  const user = String(o.user ?? o.from ?? '').trim() || base.user;
  const pass = String(o.password ?? o.pass ?? '').trim() || base.pass;
  const provider = o.provider != null ? normalizeProviderId(o.provider) : base.provider;
  const preset = getProviderPreset(provider);
  const host =
    String(o.host || '').trim() ||
    (provider === 'custom' ? base.host : preset.host || base.host);
  const portRaw = o.port ?? base.port ?? preset.port;
  const port = Math.max(1, parseInt(String(portRaw), 10) || 587);
  const secure =
    o.secure != null ? String(o.secure).trim() === '1' || o.secure === true : base.secure;
  const configured = Boolean(user && pass && host);
  return buildResolvedConfig({
    configured,
    provider,
    user,
    pass,
    host,
    port: secure ? 465 : port,
    secure,
    from: user,
    fromName: String(o.fromName || base.fromName || 'SYSCOM IoT').trim(),
    dailyLimit: base.dailyLimit,
    credentialsFromEnv: base.credentialsFromEnv,
    hasStoredPassword: base.hasStoredPassword,
  });
}

function saveSmtpConfig(store, body) {
  const prev = readStoredConfig(store) || {};
  const provider = normalizeProviderId(body.provider || prev.provider);
  const preset = getProviderPreset(provider);
  const user = String(body.user ?? body.from ?? prev.user ?? '').trim();
  if (!user) {
    const err = new Error('Indique el correo saliente (cuenta SMTP).');
    err.code = 'VALIDATION';
    throw err;
  }
  let passEnc = prev.passEnc || prev.pass || '';
  const newPass = body.password != null ? String(body.password) : body.pass != null ? String(body.pass) : '';
  if (newPass.trim()) {
    passEnc = encryptPass(newPass.trim());
  }
  const host =
    provider === 'custom'
      ? String(body.host || prev.host || '').trim()
      : String(body.host || preset.host || prev.host || preset.host).trim();
  if (!host) {
    const err = new Error('Indique el host SMTP.');
    err.code = 'VALIDATION';
    throw err;
  }
  const port = Math.max(1, parseInt(String(body.port ?? prev.port ?? preset.port), 10) || 587);
  const payload = {
    provider,
    user,
    host,
    port,
    fromName: String(body.fromName ?? prev.fromName ?? 'SYSCOM IoT').trim(),
    passEnc,
    updatedAt: new Date().toISOString(),
  };
  store.setServerSetting(queue.SMTP_SETTING_KEY, JSON.stringify(payload));
  return getPublicSmtpStatus(store);
}

function getPublicSmtpStatus(store) {
  const cfg = resolveSmtpConfig(store);
  const daily = queue.readDailyCounter(store);
  const pending = queue.countOutboxPending(store);
  return {
    configured: cfg.configured,
    provider: cfg.provider,
    fromEmail: cfg.user ? maskEmail(cfg.user) : '',
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    fromName: cfg.fromName,
    dailyLimit: cfg.dailyLimit,
    dailySent: daily.count,
    dailyRemaining: Math.max(0, cfg.dailyLimit - daily.count),
    outboxPending: pending,
    credentialsFromEnv: cfg.credentialsFromEnv,
    hasPassword: cfg.configured && (cfg.credentialsFromEnv || cfg.hasStoredPassword),
    providers: listProviderPresetsPublic(),
  };
}

/** @param {Error & { code?: string, response?: string, responseCode?: number }} err */
function classifySmtpError(err) {
  const appCode = String(err?.code || '').toUpperCase();
  if (appCode === 'NOT_CONFIGURED') {
    return {
      code: 'NOT_CONFIGURED',
      userMessage: String(err?.message || 'SMTP no configurado.'),
      retryable: false,
    };
  }
  if (appCode === 'VALIDATION') {
    return { code: 'VALIDATION', userMessage: String(err?.message || 'Datos inválidos.'), retryable: false };
  }
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || '').toUpperCase();
  const response = String(err?.response || '').toLowerCase();
  const responseCode = err?.responseCode;

  if (code === 'MODULE_MISSING') {
    return { code: 'MODULE_MISSING', userMessage: err.message, retryable: false };
  }
  if (code === 'EAUTH' || /535|534|authentication|invalid credentials|username and password/.test(msg + response)) {
    return {
      code: 'AUTH_FAILED',
      userMessage:
        'Autenticación SMTP rechazada. Use una contraseña de aplicación (no la contraseña normal) y verifique 2FA.',
      retryable: false,
    };
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || /timeout|timed out/.test(msg)) {
    return {
      code: 'TIMEOUT',
      userMessage: 'Tiempo de espera al conectar con el servidor SMTP. Revise red/firewall y puerto 587/465.',
      retryable: true,
    };
  }
  if (
    /daily|limit|quota|too many|rate|throttl|4\.7\.|5\.4\.5|552|421/.test(msg + response) ||
    responseCode === 421 ||
    responseCode === 452 ||
    responseCode === 550
  ) {
    return {
      code: 'RATE_LIMIT',
      userMessage: 'Límite de envío del proveedor alcanzado. El mensaje se encolará para reintentar.',
      retryable: true,
    };
  }
  if (/spam|blocked|blacklist|reputation|policy|550 5\.7/.test(msg + response)) {
    return {
      code: 'SPAM_POLICY',
      userMessage:
        'El proveedor bloqueó el envío (posible spam). Revise SPF/DKIM, evite URLs sospechosas y pida al destinatario revisar carpeta de spam.',
      retryable: false,
    };
  }
  return {
    code: 'SEND_FAILED',
    userMessage: 'No se pudo enviar el correo. Revise la configuración SMTP y los logs del servidor.',
    retryable: true,
  };
}

function buildTransportOptions(cfg) {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: Math.max(5000, parseInt(String(process.env.SYSCOM_SMTP_CONNECT_TIMEOUT_MS || '15000'), 10) || 15000),
    greetingTimeout: Math.max(5000, parseInt(String(process.env.SYSCOM_SMTP_GREETING_TIMEOUT_MS || '15000'), 10) || 15000),
    socketTimeout: Math.max(5000, parseInt(String(process.env.SYSCOM_SMTP_SOCKET_TIMEOUT_MS || '30000'), 10) || 30000),
  };
}

/**
 * @param {import('../store.js').SyscomStore} store
 * @param {{ to: string, subject: string, text: string, html?: string, meta?: object, allowQueue?: boolean, configOverride?: object }} opts
 */
async function sendNotificationEmail(store, opts) {
  const allowQueue = opts.allowQueue !== false;
  const to = String(opts.to || '').trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    const err = new Error('Destinatario de correo inválido.');
    err.code = 'VALIDATION';
    throw err;
  }
  const cfg = opts.configOverride
    ? resolveSmtpConfigWithOverride(store, opts.configOverride)
    : resolveSmtpConfig(store);
  if (!cfg.configured) {
    const err = new Error(
      'SMTP no configurado. Complete correo y contraseña de aplicación en el formulario (y pulse Guardar SMTP), o defina SYSCOM_SMTP_USER y SYSCOM_SMTP_PASS en el .env del servidor.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const daily = queue.readDailyCounter(store);
  if (daily.count >= cfg.dailyLimit) {
    if (!allowQueue) {
      const err = new Error('Límite diario de envío SMTP alcanzado.');
      err.code = 'DAILY_LIMIT';
      throw err;
    }
    const id = queue.enqueueEmail(store, {
      to,
      subject: opts.subject,
      text: opts.text,
      meta: opts.meta,
      status: 'queued_limit',
      sendAfterMs: Date.now() + queue.msUntilNextUtcDay(),
    });
    console.warn(
      '[smtp] Límite diario (%s/%s). Encolado id=%s para %s',
      daily.count,
      cfg.dailyLimit,
      id,
      maskEmail(to)
    );
    return { ok: true, queued: true, outboxId: id, reason: 'DAILY_LIMIT' };
  }

  try {
    const nm = getNodemailer();
    const transporter = nm.createTransport(buildTransportOptions(cfg));
    const fromHdr =
      cfg.fromName && cfg.from
        ? `"${cfg.fromName.replace(/"/g, '')}" <${cfg.from}>`
        : cfg.from;
    const info = await transporter.sendMail({
      from: fromHdr,
      to,
      subject: String(opts.subject || 'Notificación SYSCOM IoT').slice(0, 998),
      text: String(opts.text || ''),
      html: opts.html != null ? String(opts.html) : undefined,
    });
    queue.incrementDailyCounter(store);
    console.info('[smtp] Enviado a %s messageId=%s', maskEmail(to), info && info.messageId ? info.messageId : '—');
    return { ok: true, queued: false, messageId: info && info.messageId };
  } catch (e) {
    const classified = classifySmtpError(e);
    console.warn('[smtp] Fallo envío a %s [%s]: %s', maskEmail(to), classified.code, classified.userMessage);
    if (allowQueue && classified.retryable) {
      const id = queue.enqueueEmail(store, {
        to,
        subject: opts.subject,
        text: opts.text,
        meta: { ...(opts.meta || {}), errorCode: classified.code },
        status: classified.code === 'RATE_LIMIT' ? 'queued_limit' : 'pending',
        sendAfterMs:
          classified.code === 'RATE_LIMIT'
            ? Date.now() + queue.msUntilNextUtcDay()
            : Date.now() + 300000,
      });
      return { ok: false, queued: true, outboxId: id, error: classified };
    }
    throw Object.assign(new Error(classified.userMessage), { code: classified.code, cause: e });
  }
}

async function processOutboxBatch(store) {
  const cfg = resolveSmtpConfig(store);
  if (!cfg.configured) return { processed: 0 };
  const perMinute = Math.max(
    1,
    Math.min(30, parseInt(String(process.env.SYSCOM_SMTP_RATE_PER_MIN || '10'), 10) || 10)
  );
  const rows = queue.listDueOutbox(store, perMinute);
  let processed = 0;
  for (const row of rows) {
    try {
      await sendNotificationEmail(store, {
        to: row.to_addr,
        subject: row.subject,
        text: row.body_text,
        allowQueue: false,
      });
      queue.markOutboxSent(store, row.id);
      processed += 1;
    } catch (e) {
      const c = classifySmtpError(e);
      queue.markOutboxFailed(store, row.id, c.userMessage, c.code === 'RATE_LIMIT' ? queue.msUntilNextUtcDay() : 300000);
    }
  }
  return { processed };
}

function startSmtpQueueWorker(store) {
  const intervalMs = Math.max(
    15000,
    parseInt(String(process.env.SYSCOM_SMTP_QUEUE_INTERVAL_MS || '60000'), 10) || 60000
  );
  const tick = () => {
    processOutboxBatch(store).catch((e) => console.warn('[smtp] queue:', e && e.message));
    try {
      queue.pruneOldOutbox(store);
    } catch {
      /* ignore */
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}

function buildAutomationEmailBody(rule, action) {
  const defaultMessage = `La regla "${rule.name}" se ha activado.\nCondiciones: ${(rule.conditions || [])
    .map((c) => `${c.propName || c.propKey || '—'} ${c.operator} ${c.value}`)
    .join(' AND ')}\nFecha: ${new Date().toLocaleString()}`;
  const subjectTrim = String(action.emailSubject ?? action.email_subject ?? '').trim();
  const bodyTrim = String(action.emailBody ?? action.email_body ?? '').trim();
  return {
    subject: subjectTrim || `Alerta: ${rule.name}`,
    text: bodyTrim || defaultMessage,
  };
}

module.exports = {
  maskEmail,
  resolveSmtpConfig,
  resolveSmtpConfigWithOverride,
  saveSmtpConfig,
  getPublicSmtpStatus,
  classifySmtpError,
  sendNotificationEmail,
  processOutboxBatch,
  startSmtpQueueWorker,
  buildAutomationEmailBody,
};
