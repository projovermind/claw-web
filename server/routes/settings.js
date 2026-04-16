import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs/promises';
import { HttpError } from '../middleware/error-handler.js';

const featurePatchSchema = z.object({
  features: z.record(z.boolean()).optional(),
  auth: z
    .object({
      enabled: z.boolean().optional(),
      token: z.string().nullable().optional()
    })
    .optional()
}).strict();

export function createSettingsRouter({ webConfig, webConfigPath, eventBus }) {
  const router = Router();

  router.get('/', (req, res) => {
    const { auth, ...safe } = webConfig;
    res.json({
      ...safe,
      auth: { enabled: auth.enabled, token: auth.token ? '***' : null }
    });
  });

  router.patch('/', async (req, res, next) => {
    try {
      const patch = featurePatchSchema.parse(req.body);
      if (patch.features) {
        webConfig.features = { ...webConfig.features, ...patch.features };
      }
      if (patch.auth) {
        if (typeof patch.auth.enabled === 'boolean') webConfig.auth.enabled = patch.auth.enabled;
        if (patch.auth.token !== undefined) webConfig.auth.token = patch.auth.token;
      }
      await fs.writeFile(webConfigPath, JSON.stringify(webConfig, null, 2));
      if (eventBus) eventBus.publish('settings.updated', {});
      const { auth, ...safe } = webConfig;
      res.json({
        ...safe,
        auth: { enabled: auth.enabled, token: auth.token ? '***' : null }
      });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  return router;
}
