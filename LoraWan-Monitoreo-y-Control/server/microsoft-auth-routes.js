'use strict';

const crypto = require('crypto');
const {
  parseCookies,
  cookieAttrs,
  getFrontendOrigin,
  resolveOAuthRedirectUri,
  buildSuccessRedirect,
  buildErrorRedirect,
} = require('./oauth-shared');

const OAUTH_COOKIE = 'sysccom_microsoft_oauth';
const OAUTH_STATE_TYP = 'microsoft_oauth_state';

function tenantBase(tenant) {
  const t = String(tenant || 'common').trim() || 'common';
  return `https://login.microsoftonline.com/${encodeURIComponent(t)}`;
}

function tryEmailFromIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const pad = (s) => s + '='.repeat((4 - (s.length % 4)) % 4);
    const json = Buffer.from(pad(parts[1].replace(/-/g, '+').replace(/_/g, '/')), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    const a = String(payload.email || '').trim().toLowerCase();
    if (a.includes('@')) return a;
    const b = String(payload.preferred_username || '').trim().toLowerCase();
    if (b.includes('@')) return b;
  } catch {
    /* ignore */
  }
  return null;
}

function getMicrosoftOAuthConfig() {
  const clientId = String(process.env.MICROSOFT_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.MICROSOFT_OAUTH_CLIENT_SECRET || '').trim();
  const tenant = String(process.env.MICROSOFT_OAUTH_TENANT || 'common').trim() || 'common';
  const redirectUri = resolveOAuthRedirectUri('MICROSOFT_OAUTH_REDIRECT_URI', 'microsoft');
  const frontend = getFrontendOrigin();
  return { clientId, clientSecret, tenant, redirectUri, frontend };
}

/**
 * @param {import('express').Express} app
 * @param {{
 *   store: object,
 *   jwt: typeof import('jsonwebtoken'),
 *   jwtSecret: string,
 *   jwtExpiresIn: string,
 *   sessionJwtPayload: (user: object) => object,
 *   isProduction: boolean,
 *   loginRateLimit: import('express').RequestHandler,
 *   metrics: { inc?: (name: string) => void },
 * }} deps
 */
function mountMicrosoftAuthRoutes(app, deps) {
  const { store, jwt, jwtSecret, jwtExpiresIn, sessionJwtPayload, isProduction, loginRateLimit, metrics } = deps;

  app.get('/api/auth/microsoft/config', (req, res) => {
    const { clientId, clientSecret } = getMicrosoftOAuthConfig();
    res.json({ enabled: Boolean(clientId && clientSecret) });
  });

  app.get('/api/auth/microsoft/start', loginRateLimit, (req, res) => {
    const { clientId, clientSecret, tenant, redirectUri, frontend } = getMicrosoftOAuthConfig();
    if (!clientId || !clientSecret) {
      return res.redirect(302, buildErrorRedirect(frontend, 'not_configured', 'microsoft'));
    }
    const state = crypto.randomBytes(24).toString('hex');
    const signed = jwt.sign({ typ: OAUTH_STATE_TYP, state }, jwtSecret, { expiresIn: '10m' });
    res.setHeader('Set-Cookie', `${OAUTH_COOKIE}=${encodeURIComponent(signed)}; ${cookieAttrs(isProduction, 600)}`);
    const scope = ['openid', 'email', 'profile', 'https://graph.microsoft.com/User.Read'].join(' ');
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope,
      state,
      prompt: 'select_account',
    });
    res.redirect(302, `${tenantBase(tenant)}/oauth2/v2.0/authorize?${params.toString()}`);
  });

  app.get('/api/auth/microsoft/callback', async (req, res) => {
    const { clientId, clientSecret, tenant, redirectUri, frontend } = getMicrosoftOAuthConfig();
    const err = (code) => res.redirect(302, buildErrorRedirect(frontend, code, 'microsoft'));

    if (!clientId || !clientSecret) {
      return err('not_configured');
    }

    const q = req.query || {};
    if (q.error) {
      return err(q.error === 'access_denied' ? 'denied' : 'provider_error');
    }
    const code = typeof q.code === 'string' ? q.code : '';
    const state = typeof q.state === 'string' ? q.state : '';
    if (!code || !state) {
      return err('bad_request');
    }

    const cookies = parseCookies(req.headers.cookie);
    const rawCookie = cookies[OAUTH_COOKIE];
    if (!rawCookie) {
      return err('session');
    }

    let decoded;
    try {
      decoded = jwt.verify(rawCookie, jwtSecret);
    } catch {
      return err('session');
    }
    if (!decoded || decoded.typ !== OAUTH_STATE_TYP || decoded.state !== state) {
      return err('session');
    }

    res.setHeader(
      'Set-Cookie',
      `${OAUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProduction ? '; Secure' : ''}`
    );

    try {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      const tr = await fetch(`${tenantBase(tenant)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const tokens = await tr.json().catch(() => ({}));
      if (!tr.ok || !tokens.access_token) {
        console.warn('[oauth-microsoft] token exchange', tokens.error || tr.status);
        return err('token');
      }

      let email = tryEmailFromIdToken(tokens.id_token);
      if (!email) {
        const gr = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        const prof = await gr.json().catch(() => ({}));
        if (!gr.ok) {
          return err('profile');
        }
        email = String(prof.mail || '')
          .trim()
          .toLowerCase();
        if (!email) {
          email = String(prof.userPrincipalName || '')
            .trim()
            .toLowerCase();
        }
      }

      if (!email || !email.includes('@')) {
        return err('no_email');
      }

      const user = store.getUserByEmail(email);
      if (!user) {
        return err('no_account');
      }
      if (typeof metrics.inc === 'function') {
        metrics.inc('login_success');
      }
      const sessionToken = jwt.sign(sessionJwtPayload(user), jwtSecret, { expiresIn: jwtExpiresIn });
      res.redirect(302, buildSuccessRedirect(frontend, 'microsoft', sessionToken));
    } catch (e) {
      console.warn('[oauth-microsoft] callback', e && e.message);
      return err('error');
    }
  });
}

module.exports = { mountMicrosoftAuthRoutes };
