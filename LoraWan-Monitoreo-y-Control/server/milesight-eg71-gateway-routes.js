'use strict';

/**
 * Proxy autenticado hacia la API del gateway Milesight EG71.
 * Montar desde server.js sin alterar rutas UG65 existentes.
 */
module.exports = function registerMilesightEg71GatewayRoutes(app, deps) {
  const {
    authMiddleware,
    navSettingsMiddleware,
    getEg71GatewayConfig,
    requireEg71Gateway,
    eg71,
  } = deps;

  function sendGwResponse(res, r) {
    if (r.json !== null && r.json !== undefined) {
      return res.status(r.status >= 200 && r.status < 600 ? r.status : 502).json(r.json);
    }
    const status = r.status >= 200 && r.status < 600 ? r.status : 502;
    res.status(status).type('application/json').send(r.text || '{}');
  }

  app.post('/api/milesight-eg71-gateway/probe', authMiddleware, navSettingsMiddleware, async (req, res) => {
    try {
      const { baseUrl, apiUsername, apiPassword, rejectUnauthorized } = req.body || {};
      if (!baseUrl) return res.status(400).json({ error: 'baseUrl requerido (ej. https://192.168.1.10)' });
      const config = {
        baseUrl: eg71.normalizeBaseUrl(baseUrl),
        apiUsername: apiUsername || 'admin',
        apiPassword: apiPassword || '',
        rejectUnauthorized: rejectUnauthorized !== false,
      };
      const result = await eg71.probeEg71Gateway(config);
      res.json(result);
    } catch (e) {
      const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      res.status(code).json({ error: e.message, details: e.body });
    }
  });

  app.post(
    '/api/milesight-eg71-gateway/probe-saved',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const result = await eg71.probeEg71Gateway(req.eg71Config);
        res.json(result);
      } catch (e) {
        const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
        res.status(code).json({ error: e.message, details: e.body });
      }
    }
  );

  app.post(
    '/api/milesight-eg71-gateway/islogin',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const r = await eg71.eg71JsonRequest(req.user.id, req.eg71Config, 'POST', '/islogin', null);
        sendGwResponse(res, r);
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    }
  );

  app.get(
    '/api/milesight-eg71-gateway/page-init',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const bundle = await eg71.eg71PageInitBundle(req.user.id, req.eg71Config);
        res.json({
          islogin: bundle.islogin.json,
          accessInfo: bundle.accessInfo.json,
          cgiSecurity: bundle.cgiSecurity.json,
          cgiGeneral: bundle.cgiGeneral.json,
          cgiDashboard: bundle.cgiDashboard.json,
        });
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    }
  );

  /** Proxy genérico CGI (body = execute/core/function/values/id). Respeta rate limit ≥500 ms. */
  app.post(
    '/api/milesight-eg71-gateway/cgi',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const r = await eg71.eg71CgiRequest(req.user.id, req.eg71Config, body);
        sendGwResponse(res, r);
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    }
  );

  /**
   * Proxy REST genérico: { method, path, body } → gateway /api/...
   * path ejemplo: "/api/dsdevices/device" o "/api/payloadcodecs-short?limit=10"
   */
  app.post(
    '/api/milesight-eg71-gateway/rest',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const { method, path, body } = req.body || {};
        const p = String(path || '').trim();
        if (!p) return res.status(400).json({ error: 'path requerido (ej. /api/dsdevices/device)' });
        const gwPath = p.startsWith('/') ? p : `/${p}`;
        const m = String(method || 'GET').toUpperCase();
        const hasBody = body != null && m !== 'GET' && m !== 'HEAD';
        const r = await eg71.eg71JsonRequest(
          req.user.id,
          req.eg71Config,
          m,
          gwPath,
          hasBody ? body : null
        );
        sendGwResponse(res, r);
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    }
  );

  // ── Atajos REST frecuentes (adquisición de datos / biblioteca) ──

  app.post(
    '/api/milesight-eg71-gateway/devices/list',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const payload = {
          protocolType: [],
          deviceType: [],
          deviceNameOrEui: '',
          status: '',
          pageSize: 10,
          page: 1,
          ...(req.body && typeof req.body === 'object' ? req.body : {}),
        };
        const r = await eg71.eg71JsonRequest(
          req.user.id,
          req.eg71Config,
          'POST',
          '/api/dsdevices/device',
          payload
        );
        sendGwResponse(res, r);
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    }
  );

  app.get(
    '/api/milesight-eg71-gateway/access-network',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const r = await eg71.eg71JsonRequest(req.user.id, req.eg71Config, 'GET', '/api/access-network', null);
        sendGwResponse(res, r);
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    }
  );

  app.get(
    '/api/milesight-eg71-gateway/payloadcodecs-short',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '?order=asc&offset=0&limit=9999';
        const r = await eg71.eg71JsonRequest(
          req.user.id,
          req.eg71Config,
          'GET',
          `/api/payloadcodecs-short${q.startsWith('?') ? q : `?${q}`}`,
          null
        );
        sendGwResponse(res, r);
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    }
  );

  app.get(
    '/api/milesight-eg71-gateway/urprofiles',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '?limit=9999&offset=0&organizationID=1';
        const r = await eg71.eg71JsonRequest(
          req.user.id,
          req.eg71Config,
          'GET',
          `/api/urprofiles${q.startsWith('?') ? q : `?${q}`}`,
          null
        );
        sendGwResponse(res, r);
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    }
  );

  app.get(
    '/api/milesight-eg71-gateway/dsforward',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const r = await eg71.eg71JsonRequest(req.user.id, req.eg71Config, 'GET', '/api/dsforward', null);
        sendGwResponse(res, r);
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    }
  );

  app.get(
    '/api/milesight-eg71-gateway/general-info/interfaces',
    authMiddleware,
    navSettingsMiddleware,
    requireEg71Gateway,
    async (req, res) => {
      try {
        const r = await eg71.eg71JsonRequest(
          req.user.id,
          req.eg71Config,
          'GET',
          '/api/general-info/interface/IpAddress',
          null
        );
        sendGwResponse(res, r);
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    }
  );
};
