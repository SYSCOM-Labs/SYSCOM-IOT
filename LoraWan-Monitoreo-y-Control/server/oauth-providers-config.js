'use strict';

/**
 * Estado de OAuth por proveedor (para el login: qué botones activar).
 */
function mountOAuthProvidersConfig(app) {
  app.get('/api/auth/oauth/providers', (req, res) => {
    res.json({
      google: Boolean(
        String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim() &&
          String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim()
      ),
      microsoft: Boolean(
        String(process.env.MICROSOFT_OAUTH_CLIENT_ID || '').trim() &&
          String(process.env.MICROSOFT_OAUTH_CLIENT_SECRET || '').trim()
      ),
      yahoo: Boolean(
        String(process.env.YAHOO_OAUTH_CLIENT_ID || '').trim() &&
          String(process.env.YAHOO_OAUTH_CLIENT_SECRET || '').trim()
      ),
    });
  });
}

module.exports = { mountOAuthProvidersConfig };
