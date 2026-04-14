/**
 * Rate limiting en memoria por clave (IP, usuario, etc.). Sin Redis ni servicios externos.
 */
'use strict';

function defaultKeyFromReq(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf && typeof xf === 'string') {
    const first = xf.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

/**
 * @param {{
 *   windowMs: number,
 *   max: number,
 *   key?: (req: import('express').Request) => string,
 *   onReject?: (req: import('express').Request) => void,
 * }} opts
 */
function createRateLimiter(opts) {
  const windowMs = Math.max(1000, opts.windowMs || 60000);
  const max = Math.max(1, opts.max || 60);
  const keyFn = typeof opts.key === 'function' ? opts.key : defaultKeyFromReq;
  const onReject = typeof opts.onReject === 'function' ? opts.onReject : null;
  /** @type {Map<string, { count: number, reset: number }>} */
  const buckets = new Map();
  let lastSweep = Date.now();

  function sweep() {
    const now = Date.now();
    if (now - lastSweep < 60000) return;
    lastSweep = now;
    for (const [k, b] of buckets) {
      if (now > b.reset + windowMs) buckets.delete(k);
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    sweep();
    const key = keyFn(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      if (onReject) onReject(req);
      const retryAfterSec = Math.ceil((b.reset - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfterSec)));
      return res.status(429).json({
        error: 'Demasiadas solicitudes. Espere e intente de nuevo.',
        code: 'RATE_LIMIT',
      });
    }
    next();
  };
}

module.exports = { createRateLimiter, defaultKeyFromReq };
