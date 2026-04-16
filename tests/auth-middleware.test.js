import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createAuthMiddleware, authorizeWsUpgrade } from '../server/middleware/auth.js';
import { errorHandler } from '../server/middleware/error-handler.js';

function buildApp(webConfig) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthMiddleware({ webConfig }));
  // Mount some trivial routes under /api so we can probe them
  app.get('/api/health', (_, res) => res.json({ ok: true }));
  app.get('/api/settings', (_, res) =>
    res.json({ auth: { enabled: webConfig.auth.enabled, token: webConfig.auth.token ? '***' : null } })
  );
  app.get('/api/agents', (_, res) => res.json({ agents: [] }));
  app.patch('/api/settings', (_, res) => res.json({ patched: true }));
  app.use(errorHandler);
  return app;
}

describe('auth middleware', () => {
  it('passes everything through when auth.enabled is false', async () => {
    const webConfig = { auth: { enabled: false, token: null } };
    const app = buildApp(webConfig);
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
  });

  it('blocks protected routes with 401 when no token provided', async () => {
    const webConfig = { auth: { enabled: true, token: 'secret123' } };
    const app = buildApp(webConfig);
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('blocks with 401 when token is wrong', async () => {
    const webConfig = { auth: { enabled: true, token: 'secret123' } };
    const app = buildApp(webConfig);
    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID');
  });

  it('passes with correct Bearer token', async () => {
    const webConfig = { auth: { enabled: true, token: 'secret123' } };
    const app = buildApp(webConfig);
    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', 'Bearer secret123');
    expect(res.status).toBe(200);
  });

  it('always allows GET /api/health even with auth on', async () => {
    const webConfig = { auth: { enabled: true, token: 'secret123' } };
    const app = buildApp(webConfig);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('always allows GET /api/settings (token is already masked)', async () => {
    const webConfig = { auth: { enabled: true, token: 'secret123' } };
    const app = buildApp(webConfig);
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.auth.token).toBe('***');
  });

  it('PATCH /api/settings is NOT exempt — still requires auth', async () => {
    const webConfig = { auth: { enabled: true, token: 'secret123' } };
    const app = buildApp(webConfig);
    const noToken = await request(app).patch('/api/settings').send({});
    expect(noToken.status).toBe(401);
    const withToken = await request(app)
      .patch('/api/settings')
      .set('Authorization', 'Bearer secret123')
      .send({});
    expect(withToken.status).toBe(200);
  });

  it('returns 503 AUTH_NOT_CONFIGURED when enabled but no token', async () => {
    const webConfig = { auth: { enabled: true, token: null } };
    const app = buildApp(webConfig);
    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', 'Bearer anything');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AUTH_NOT_CONFIGURED');
  });

  it('reads webConfig live (toggle works without rebuilding middleware)', async () => {
    const webConfig = { auth: { enabled: false, token: null } };
    const app = buildApp(webConfig);
    // Initially open
    expect((await request(app).get('/api/agents')).status).toBe(200);
    // Flip to enabled + set token
    webConfig.auth.enabled = true;
    webConfig.auth.token = 'hot-reload-token';
    // Now requests without a token should 401
    expect((await request(app).get('/api/agents')).status).toBe(401);
    // With the token they pass
    expect(
      (await request(app).get('/api/agents').set('Authorization', 'Bearer hot-reload-token')).status
    ).toBe(200);
  });
});

describe('authorizeWsUpgrade', () => {
  const req = (url) => ({ url });

  it('allows all upgrades when auth disabled', () => {
    expect(authorizeWsUpgrade(req('/ws'), { auth: { enabled: false, token: null } })).toBe(true);
    expect(authorizeWsUpgrade(req('/ws?token=whatever'), { auth: { enabled: false } })).toBe(true);
  });

  it('rejects upgrades with no token when auth on', () => {
    expect(authorizeWsUpgrade(req('/ws'), { auth: { enabled: true, token: 'abc' } })).toBe(false);
  });

  it('rejects wrong token', () => {
    expect(
      authorizeWsUpgrade(req('/ws?token=wrong'), { auth: { enabled: true, token: 'abc' } })
    ).toBe(false);
  });

  it('accepts matching token', () => {
    expect(
      authorizeWsUpgrade(req('/ws?token=abc'), { auth: { enabled: true, token: 'abc' } })
    ).toBe(true);
  });

  it('rejects when enabled but no server token configured', () => {
    expect(
      authorizeWsUpgrade(req('/ws?token=abc'), { auth: { enabled: true, token: null } })
    ).toBe(false);
  });
});
