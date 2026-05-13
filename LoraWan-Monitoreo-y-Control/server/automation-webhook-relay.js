'use strict';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

/**
 * @param {string} urlString
 * @returns {string|null} mensaje de error o null si OK
 */
function validateWebhookRelayUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return 'URL inválida';
  }
  const proto = u.protocol.toLowerCase();
  if (proto !== 'https:' && !(proto === 'http:' && !IS_PRODUCTION)) {
    return IS_PRODUCTION
      ? 'Solo se permiten URLs https://'
      : 'Solo se permiten URLs http:// o https:// (http solo en desarrollo)';
  }
  const host = u.hostname.toLowerCase();
  if (!host) return 'Host vacío';
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' || host === '::1') {
    return 'No se permite reenvío a localhost';
  }
  if (host === '169.254.169.254' || host.endsWith('.local')) {
    return 'Host no permitido';
  }
  if (/^(10|127)\.\d+\.\d+\.\d+$/i.test(host)) return 'IP privada no permitida';
  if (/^192\.168\.\d+\.\d+$/i.test(host)) return 'IP privada no permitida';
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/i.test(host)) return 'IP privada no permitida';
  if (/^169\.254\./i.test(host)) return 'IP de enlace local no permitida';
  return null;
}

function isPushMoreWebhookUrl(url) {
  try {
    const u = new URL(String(url).trim());
    let h = u.hostname.toLowerCase();
    if (h.startsWith('www.')) h = h.slice(4);
    const path = (u.pathname || '').toLowerCase();
    if (!path.includes('/webhook')) return false;
    return h === 'pushmore.io' || h.endsWith('.pushmore.io');
  } catch {
    return /pushmore\.io\/webhook\//i.test(String(url));
  }
}

function extractHumanFromMaybeJsonString(str) {
  const s = String(str || '').trim();
  if (!s.startsWith('{')) return s;
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object') {
      const inner = String(j.message || j.text || '').trim();
      if (inner) return inner;
    }
  } catch {
    /* seguir con s */
  }
  return s;
}

function formatConditionLine(c) {
  const name = String(c.propName || c.propKey || '—').trim();
  const op = String(c.operator || '==').trim();
  const val = String(c.value != null ? c.value : '—').trim();
  const opLabel =
    op === '==' ? 'es igual a' : op === '!=' ? 'distinto de' : op === '>=' ? 'mayor o igual a' : op;
  return `${name} ${opLabel} ${val}`;
}

function formatTimestampForDisplay(ts) {
  try {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString('es-ES');
  } catch {
    /* */
  }
  return String(ts);
}

/**
 * PushMore.io documenta `curl --data "hello world"`: cuerpo en bruto (curl usa
 * `application/x-www-form-urlencoded`), no JSON.
 * @param {object} payload
 */
function pushMorePlainBodyFromPayload(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  let fromMsg = String(p.message || p.text || '').trim();
  fromMsg = extractHumanFromMaybeJsonString(fromMsg);
  if (fromMsg) return fromMsg;

  const conds = Array.isArray(p.conditions) ? p.conditions : [];
  const condLines = conds.length ? conds.map(formatConditionLine) : [];
  const rn = String(p.ruleName || 'SYSCOM IoT').trim();
  const tb = String(p.triggeredBy || '').trim();
  const ts = formatTimestampForDisplay(p.timestamp || new Date().toISOString());
  const parts = [`Regla: ${rn}`];
  if (condLines.length) parts.push(`Condiciones:\n${condLines.join('\n')}`);
  else if (tb) parts.push(`Condiciones: ${tb}`);
  parts.push(`Fecha: ${ts}`);
  return parts.join('\n\n');
}

/**
 * @param {string} url
 * @param {object} payload
 * @param {{ forcePushMorePlain?: boolean }} [opts]
 * @returns {Promise<{ status: number, ok: boolean, textSnippet: string, telegramError?: string|null }>}
 */
async function relayWebhookPost(url, payload, opts = {}) {
  const timeoutMs = Math.min(30000, Math.max(3000, parseInt(process.env.SYSCOM_WEBHOOK_RELAY_TIMEOUT_MS, 10) || 15000));
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  const pushmore = Boolean(opts.forcePushMorePlain) || isPushMoreWebhookUrl(url);
  const plainBody = pushmore ? pushMorePlainBodyFromPayload(payload) : null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: pushmore
        ? {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Accept: 'text/plain, application/json, */*',
            'User-Agent': 'syscom-iot-automation-webhook-relay/1',
          }
        : {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            'User-Agent': 'syscom-iot-automation-webhook-relay/1',
          },
      body: pushmore ? plainBody : JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await r.text();
    const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    /** Telegram Bot API: HTTP 200 con cuerpo `{ "ok": false, "description": "..." }` cuando falla chat_id/token/etc. */
    let logicalOk = r.ok;
    let telegramError = null;
    if (logicalOk && /api\.telegram\.org/i.test(String(url))) {
      try {
        const j = JSON.parse(text);
        if (j && typeof j === 'object' && j.ok === false) {
          logicalOk = false;
          telegramError = j.description || j.error_code || JSON.stringify(j);
        }
      } catch {
        /* cuerpo no JSON */
      }
    }
    return { status: r.status, ok: logicalOk, textSnippet: snippet, telegramError };
  } finally {
    clearTimeout(tid);
  }
}

module.exports = {
  validateWebhookRelayUrl,
  relayWebhookPost,
};
