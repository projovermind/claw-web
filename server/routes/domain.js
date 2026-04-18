import { Router } from 'express';
import { logger } from '../lib/logger.js';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

function cfHeaders(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
}

export function createDomainRouter({ secretsStore }) {
  const router = Router();

  // Helper: get stored CF credentials
  function getCreds() {
    const state = secretsStore._getState();
    const accountId = state.backends?.cf_account_id?.value;
    const apiToken = state.backends?.cf_api_token?.value;
    return { accountId, apiToken };
  }

  // POST /credentials — store CF account ID + API token
  router.post('/credentials', async (req, res, next) => {
    try {
      const { accountId, apiToken } = req.body;
      if (!accountId || !apiToken) {
        return res.status(400).json({ error: 'accountId and apiToken are required' });
      }
      await Promise.all([
        secretsStore.set('cf_account_id', 'CF_ACCOUNT_ID', accountId),
        secretsStore.set('cf_api_token', 'CF_API_TOKEN', apiToken),
      ]);
      logger.info('domain: CF credentials saved');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /credentials — check whether credentials are stored
  router.get('/credentials', (req, res) => {
    const { accountId, apiToken } = getCreds();
    res.json({ hasCredentials: !!(accountId && apiToken) });
  });

  // GET /search?q=name — domain availability + price via CF Registrar
  router.get('/search', async (req, res, next) => {
    try {
      const { accountId, apiToken } = getCreds();
      if (!accountId || !apiToken) {
        return res.status(401).json({ error: 'Cloudflare credentials not configured' });
      }
      const name = req.query.q;
      if (!name) return res.status(400).json({ error: 'q (domain name) is required' });

      const cfRes = await fetch(
        `${CF_BASE}/accounts/${accountId}/registrar/domains/${encodeURIComponent(name)}`,
        { headers: cfHeaders(apiToken) }
      );
      const data = await cfRes.json();
      res.status(cfRes.status).json(data);
    } catch (err) {
      next(err);
    }
  });

  // GET /list — list owned domains (zones)
  router.get('/list', async (req, res, next) => {
    try {
      const { accountId, apiToken } = getCreds();
      if (!accountId || !apiToken) {
        return res.status(401).json({ error: 'Cloudflare credentials not configured' });
      }

      const cfRes = await fetch(
        `${CF_BASE}/accounts/${accountId}/zones?per_page=100`,
        { headers: cfHeaders(apiToken) }
      );
      const data = await cfRes.json();
      res.status(cfRes.status).json(data);
    } catch (err) {
      next(err);
    }
  });

  // POST /purchase — register domain via CF Registrar
  router.post('/purchase', async (req, res, next) => {
    try {
      const { accountId, apiToken } = getCreds();
      if (!accountId || !apiToken) {
        return res.status(401).json({ error: 'Cloudflare credentials not configured' });
      }
      const { name, ...rest } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });

      const cfRes = await fetch(
        `${CF_BASE}/accounts/${accountId}/registrar/domains/${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: cfHeaders(apiToken),
          body: JSON.stringify(rest),
        }
      );
      const data = await cfRes.json();
      res.status(cfRes.status).json(data);
    } catch (err) {
      next(err);
    }
  });

  // POST /dns-connect — create CNAME record to connect domain to tunnel/target
  router.post('/dns-connect', async (req, res, next) => {
    try {
      const { accountId, apiToken } = getCreds();
      if (!accountId || !apiToken) {
        return res.status(401).json({ error: 'Cloudflare credentials not configured' });
      }
      const { zone_id, name, target } = req.body;
      if (!zone_id || !name || !target) {
        return res.status(400).json({ error: 'zone_id, name, and target are required' });
      }

      const cfRes = await fetch(
        `${CF_BASE}/zones/${zone_id}/dns_records`,
        {
          method: 'POST',
          headers: cfHeaders(apiToken),
          body: JSON.stringify({
            type: 'CNAME',
            name,
            content: target,
            proxied: true,
            ttl: 1,
          }),
        }
      );
      const data = await cfRes.json();
      res.status(cfRes.status).json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
