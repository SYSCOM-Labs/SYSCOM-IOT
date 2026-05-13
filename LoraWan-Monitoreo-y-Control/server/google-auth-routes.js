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

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const OAUTH_COOKIE = 'sysccom_google_oauth';
const OAUTH_STATE_TYP = 'google_oauth_state';

function getGoogleOAuthConfig() {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  const redirectUri = resolveOAuthRedirectUri('GOOGLE_OAUTH_REDIRECT_URI', 'google');
  const frontend = getFrontendOrigin();
  return { clientId, clientSecret, redirectUri, frontend };
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
function mountGoogleAuthRoutes(app, deps) {
  const { store, jwt, jwtSecret, jwtExpiresIn, sessionJwtPayload, isProduction, loginRateLimit, metrics } = deps;

  app.get('/api/auth/google/config', (req, res) => {
    const { clientId, clientSecret } = getGoogleOAuthConfig();
    res.json({ enabled: Boolean(clientId && clientSecret) });
  });

  app.get('/api/auth/google/start', loginRateLimit, (req, res) => {
    const { clientId, clientSecret, redirectUri, frontend } = getGoogleOAuthConfig();
    if (!clientId || !clientSecret) {
      return res.redirect(302, buildErrorRedirect(frontend, 'not_configured', 'google'));
    }
    const state = crypto.randomBytes(24).toString('hex');
    const signed = jwt.sign({ typ: OAUTH_STATE_TYP, state }, jwtSecret, { expiresIn: '10m' });
    res.setHeader('Set-Cookie', `${OAUTH_COOKIE}=${encodeURIComponent(signed)}; ${cookieAttrs(isProduction, 600)}`);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
      access_type: 'online',
    });
    res.redirect(302, `${GOOGLE_AUTH}?${params.toString()}`);
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    const { clientId, clientSecret, redirectUri, frontend } = getGoogleOAuthConfig();
    const err = (code) => res.redirect(302, buildErrorRedirect(frontend, code, 'google'));

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
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      const tr = await fetch(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const tokens = await tr.json().catch(() => ({}));
      if (!tr.ok) {
        console.warn('[oauth-google] token exchange', tokens.error || tr.status);
        return err('token');
      }
      if (!tokens.access_token) {
        return err('token');
      }
      const ui = await fetch(GOOGLE_USERINFO, {
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
      res.redirect(302, buildSuccessRedirect(frontend, 'google', sessionToken));
    } catch (e) {
      console.warn('[oauth-google] callback', e && e.message);
      return err('error');
    }
  });
}

module.exports = { mountGoogleAuthRoutes };
