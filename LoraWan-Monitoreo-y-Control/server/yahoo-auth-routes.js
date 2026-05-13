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

const YAHOO_AUTH = 'https://api.login.yahoo.com/oauth2/request_auth';
const YAHOO_TOKEN = 'https://api.login.yahoo.com/oauth2/get_token';
const YAHOO_USERINFO = 'https://api.login.yahoo.com/openid/v1/userinfo';

const OAUTH_COOKIE = 'sysccom_yahoo_oauth';
const OAUTH_STATE_TYP = 'yahoo_oauth_state';

function getYahooOAuthConfig() {
  const clientId = String(process.env.YAHOO_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.YAHOO_OAUTH_CLIENT_SECRET || '').trim();
  const redirectUri = resolveOAuthRedirectUri('YAHOO_OAUTH_REDIRECT_URI', 'yahoo');
  const frontend = getFrontendOrigin();
  return { clientId, clientSecret, redirectUri, frontend };
}

function yahooBasicAuthHeader(clientId, clientSecret) {
  const raw = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
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
function mountYahooAuthRoutes(app, deps) {
  const { store, jwt, jwtSecret, jwtExpiresIn, sessionJwtPayload, isProduction, loginRateLimit, metrics } = deps;

  app.get('/api/auth/yahoo/config', (req, res) => {
    const { clientId, clientSecret } = getYahooOAuthConfig();
    res.json({ enabled: Boolean(clientId && clientSecret) });
  });

  app.get('/api/auth/yahoo/start', loginRateLimit, (req, res) => {
    const { clientId, clientSecret, redirectUri, frontend } = getYahooOAuthConfig();
    if (!clientId || !clientSecret) {
      return res.redirect(302, buildErrorRedirect(frontend, 'not_configured', 'yahoo'));
    }
    const state = crypto.randomBytes(24).toString('hex');
    const signed = jwt.sign({ typ: OAUTH_STATE_TYP, state }, jwtSecret, { expiresIn: '10m' });
    res.setHeader('Set-Cookie', `${OAUTH_COOKIE}=${encodeURIComponent(signed)}; ${cookieAttrs(isProduction, 600)}`);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      prompt: 'login',
    });
    res.redirect(302, `${YAHOO_AUTH}?${params.toString()}`);
  });

  app.get('/api/auth/yahoo/callback', async (req, res) => {
    const { clientId, clientSecret, redirectUri, frontend } = getYahooOAuthConfig();
    const err = (code) => res.redirect(302, buildErrorRedirect(frontend, code, 'yahoo'));

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
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      });
      const tr = await fetch(YAHOO_TOKEN, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: yahooBasicAuthHeader(clientId, clientSecret),
        },
        body,
      });
      const tokens = await tr.json().catch(() => ({}));
      if (!tr.ok || !tokens.access_token) {
        console.warn('[oauth-yahoo] token exchange', tokens.error || tr.status);
        return err('token');
      }
      const ui = await fetch(YAHOO_USERINFO, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const profile = await ui.json().catch(() => ({}));
      if (!ui.ok) {
        return err('profile');
      }
      const email = String(profile.email || '')
        .trim()
        .toLowerCase();
      if (!email) {
        return err('no_email');
      }
      if (profile.email_verified !== true && profile.email_verified !== 'true') {
        return err('unverified');
      }
      const user = store.getUserByEmail(email);
      if (!user) {
        return err('no_account');
      }
      if (typeof metrics.inc === 'function') {
        metrics.inc('login_success');
      }
      const sessionToken = jwt.sign(sessionJwtPayload(user), jwtSecret, { expiresIn: jwtExpiresIn });
      res.redirect(302, buildSuccessRedirect(frontend, 'yahoo', sessionToken));
    } catch (e) {
      console.warn('[oauth-yahoo] callback', e && e.message);
      return err('error');
    }
  });
}

module.exports = { mountYahooAuthRoutes };
