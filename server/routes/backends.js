import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';

const createSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i),
  // anthropic-compatible: Claude CLI talks to it via ANTHROPIC_BASE_URL +
  // ANTHROPIC_AUTH_TOKEN (e.g. Z.AI Coding Plan). openai-compatible: a
  // separate OpenAI-shaped endpoint (kept for future direct-call use).
  type: z.enum(['openai-compatible', 'anthropic-compatible']),
  label: z.string().min(1).max(80),
  baseURL: z.string().url(),
  envKey: z.string().min(1).max(80),
  models: z.record(z.string()),
  // Optional: if provided, we also store the actual key value in the
  // secrets store (and inject into process.env) — user can paste the key
  // directly in the UI instead of fiddling with shell env vars.
  secret: z.string().min(1).max(500).optional()
}).strict();

const updateSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  baseURL: z.string().url().optional(),
  envKey: z.string().min(1).max(80).optional(),
  models: z.record(z.string()).optional()
}).strict();

const secretSchema = z.object({
  // Pass empty string or null to clear; otherwise this becomes the new value.
  value: z.string().max(500).nullable()
}).strict();

const revealSchema = z.object({
  // Re-auth — must match webConfig.auth.token. Required even when auth is
  // disabled globally, so revealing a stored secret always demands at least
  // the configured token (matches the auth model — if no token is set, the
  // server has no way to verify identity and will refuse).
  password: z.string().min(1).max(500)
}).strict();

export function createBackendsRouter({ backendsStore, eventBus, webConfig }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(backendsStore.getPublic());
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = createSchema.parse(req.body);
      const { id, secret, ...fields } = data;
      await backendsStore.createBackend(id, fields);
      if (secret && fields.envKey) {
        await backendsStore.setSecret(id, secret);
      }
      if (eventBus) eventBus.publish('backends.updated', {});
      res.status(201).json(backendsStore.getPublic().backends[id]);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (err.code === 'DUPLICATE') return next(new HttpError(409, err.message, 'DUPLICATE'));
      next(err);
    }
  });

  // Dedicated endpoint for setting/clearing a backend's secret. Separate from
  // PATCH / (which handles non-sensitive config fields) so the UI can
  // confidently show a password input without worrying about accidentally
  // including the secret in normal patches.
  router.put('/:id/secret', async (req, res, next) => {
    try {
      const { value } = secretSchema.parse(req.body);
      if (!backendsStore.getBackend(req.params.id)) {
        throw new HttpError(404, 'Backend not found', 'BACKEND_NOT_FOUND');
      }
      await backendsStore.setSecret(req.params.id, value || null);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.json(backendsStore.getPublic().backends[req.params.id]);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (err.message?.includes('no envKey')) {
        return next(new HttpError(400, err.message, 'NO_ENVKEY'));
      }
      next(err);
    }
  });

  // Reveal stored secret/OAuth for a backend after re-authenticating with the
  // server's auth token. Returns the raw values (e.g. `sk-ant-api03-...`) so
  // the user can copy them. We deliberately require `webConfig.auth.token` to
  // be set — without it, there is no way to verify the requester's identity.
  router.post('/:id/reveal', async (req, res, next) => {
    try {
      const { password } = revealSchema.parse(req.body);
      const expected = webConfig?.auth?.token;
      if (!expected) {
        throw new HttpError(
          503,
          '서버에 인증 토큰이 설정되지 않아 토큰을 노출할 수 없습니다. 설정 > 보안에서 토큰을 먼저 설정하세요.',
          'AUTH_NOT_CONFIGURED'
        );
      }
      if (password !== expected) {
        throw new HttpError(403, '비밀번호가 일치하지 않습니다', 'BAD_PASSWORD');
      }
      if (!backendsStore.getBackend(req.params.id)) {
        throw new HttpError(404, 'Backend not found', 'BACKEND_NOT_FOUND');
      }
      const backend = backendsStore.getBackend(req.params.id);
      const secret = backendsStore.getSecretValue(req.params.id);
      const oauthToken = backendsStore.getOAuthToken(req.params.id);
      const claudeCreds = backendsStore.getClaudeCliCreds(req.params.id);
      // For convenience, also expose well-known process.env API keys so the
      // user can copy the value the runner will actually inject. Only
      // includes keys that are SET — never reports `null` / `undefined`.
      const envCandidates = backend?.envKey
        ? [backend.envKey]
        : ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
      const env = {};
      for (const k of envCandidates) {
        if (process.env[k]) env[k] = process.env[k];
      }
      res.json({
        secret,
        oauthToken,
        claudeCreds,
        env: Object.keys(env).length ? env : null
      });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const data = updateSchema.parse(req.body);
      if (!backendsStore.getBackend(req.params.id)) {
        throw new HttpError(404, 'Backend not found', 'BACKEND_NOT_FOUND');
      }
      await backendsStore.updateBackend(req.params.id, data);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.json(backendsStore.getPublic().backends[req.params.id]);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (!backendsStore.getBackend(req.params.id)) {
        throw new HttpError(404, 'Backend not found', 'BACKEND_NOT_FOUND');
      }
      await backendsStore.deleteBackend(req.params.id);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.status(204).end();
    } catch (err) {
      if (err.code === 'PROTECTED') return next(new HttpError(400, err.message, 'PROTECTED'));
      next(err);
    }
  });

  router.post('/active', async (req, res, next) => {
    try {
      const { backendId } = z.object({ backendId: z.string() }).parse(req.body);
      await backendsStore.setActive(backendId);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.json({ activeBackend: backendId });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.post('/austerity', async (req, res, next) => {
    try {
      const { enabled, backendId } = z
        .object({ enabled: z.boolean(), backendId: z.string().optional() })
        .parse(req.body);
      await backendsStore.setAusterity(enabled, backendId);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.json({ austerityMode: enabled });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  return router;
}
