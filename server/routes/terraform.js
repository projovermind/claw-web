/**
 * Terraform API — 기존 환경 스캔 + 선택적 import
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../middleware/error-handler.js';
import {
  fullTerraformScan,
  generateDefaultAgents
} from '../lib/terraform-scanner.js';
import { logger } from '../lib/logger.js';

export function createTerraformRouter({ projectsStore, configStore, metadataStore, eventBus }) {
  const router = Router();

  // POST /api/terraform/scan
  // body: { roots: string[] }
  router.post('/scan', async (req, res, next) => {
    try {
      const home = process.env.HOME || '';
      const defaultRoots = [
        path.join(home, 'Projects'),
        path.join(home, 'Documents'),
        path.join(home, 'Code'),
        '/Volumes/Core/Vault',
        '/Volumes/Core'
      ];
      const roots = Array.isArray(req.body?.roots) && req.body.roots.length > 0
        ? req.body.roots
        : defaultRoots.filter(p => fs.existsSync(p));

      const result = await fullTerraformScan(roots);
      res.json(result);
    } catch (err) { next(err); }
  });

  // POST /api/terraform/apply
  // body: { projects: [{ id, name, path, color, createDefaultAgents }] }
  router.post('/apply', async (req, res, next) => {
    try {
      const items = Array.isArray(req.body?.projects) ? req.body.projects : [];
      if (items.length === 0) throw new HttpError(400, 'No projects selected', 'INVALID_BODY');

      const created = [];
      const createdAgents = [];
      const errors = [];

      for (const item of items) {
        const { id, name, path: projPath, color, createDefaultAgents } = item;
        if (!id || !name || !projPath) {
          errors.push({ id, error: 'missing fields' });
          continue;
        }
        try {
          if (projectsStore.getById(id)) {
            errors.push({ id, error: 'already exists' });
            continue;
          }
          await projectsStore.create({
            id,
            name,
            path: projPath,
            color: color || '#7bcce0',
            defaultAllowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']
          });
          created.push(id);

          if (createDefaultAgents) {
            const agents = generateDefaultAgents(id, name);
            for (const agent of agents) {
              if (configStore.getAgent(agent.id)) continue;
              const { tier, projectId, ...config } = agent;
              await configStore.createAgent(agent.id, {
                ...config,
                workingDir: projPath
              });
              if (metadataStore) {
                await metadataStore.updateAgent(agent.id, { tier, projectId });
              }
              createdAgents.push(agent.id);
            }
          }
        } catch (err) {
          errors.push({ id, error: err.message });
        }
      }

      if (eventBus) {
        eventBus.publish('projects.refreshed', {});
        eventBus.publish('agents.refreshed', {});
      }
      logger.info({ created: created.length, agents: createdAgents.length, errors: errors.length }, 'terraform: applied');
      res.json({ created, createdAgents, errors });
    } catch (err) { next(err); }
  });

  return router;
}
