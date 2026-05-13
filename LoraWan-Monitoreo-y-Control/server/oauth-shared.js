'use strict';

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* ignore */
    }
    out[k] = v;
  }
  return out;
}

function cookieAttrs(isProduction, maxAgeSec) {
  const bits = [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${maxAgeSec}`];
  if (isProduction) bits.push('Secure');
  return bits.join('; ');
}

function getFrontendOrigin() {
  return String(process.env.SYSCOM_FRONTEND_ORIGIN || '').trim().replace(/\/$/, '') || 'http://127.0.0.1:5173';
}

function defaultApiOriginBase() {
  const apiPublic = String(process.env.SYSCOM_API_PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  const port = String(process.env.PORT || '3001').trim();
  return apiPublic || `http://127.0.0.1:${port}`;
}

/** @param {'google'|'microsoft'|'yahoo'} provider */
function defaultOAuthCallbackUrl(provider) {
  return `${defaultApiOriginBase()}/api/auth/${provider}/callback`;
}

/**
 * @param {string} envVarName p. ej. GOOGLE_OAUTH_REDIRECT_URI
 * @param {'google'|'microsoft'|'yahoo'} provider
 */
function resolveOAuthRedirectUri(envVarName, provider) {
  const explicit = String(process.env[envVarName] || '').trim();
  if (explicit) return explicit;
  return defaultOAuthCallbackUrl(provider);
}

function buildSuccessRedirect(frontend, provider, sessionToken) {
  const frag = `oauth_verify=${encodeURIComponent(provider)}&auth_token=${encodeURIComponent(sessionToken)}`;
  return `${frontend}/#${frag}`;
}

function buildErrorRedirect(frontend, code, provider) {
  const p = provider ? `&provider=${encodeURIComponent(provider)}` : '';
  return `${frontend}/?oauth=${encodeURIComponent(code)}${p}`;
}

module.exports = {
  parseCookies,
  cookieAttrs,
  getFrontendOrigin,
  defaultOAuthCallbackUrl,
  resolveOAuthRedirectUri,
  buildSuccessRedirect,
  buildErrorRedirect,
};
