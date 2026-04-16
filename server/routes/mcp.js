import { Router } from 'express';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HttpError } from '../middleware/error-handler.js';

/**
 * MCP Server configuration management.
 *
 * GET /api/mcp/servers  → read MCP config from .claude/settings.json
 * PUT /api/mcp/servers  → write MCP config back
 */
export function createMcpRouter({ projectsStore }) {
  const router = Router();

  function findSettingsPath() {
    // Check project-level first, then user-level
    const projectLevel = path.join(process.cwd(), '.claude', 'settings.json');
    if (fssync.existsSync(projectLevel)) return projectLevel;
    const userLevel = path.join(os.homedir(), '.claude', 'settings.json');
    if (fssync.existsSync(userLevel)) return userLevel;
    // Default to user-level for creation
    return userLevel;
  }

  router.get('/servers', async (_req, res, next) => {
    try {
      const settingsPath = findSettingsPath();
      if (!fssync.existsSync(settingsPath)) {
        return res.json({ mcpServers: {}, path: settingsPath });
      }
      const raw = await fs.readFile(settingsPath, 'utf8');
      const settings = JSON.parse(raw);
      res.json({
        mcpServers: settings.mcpServers || {},
        path: settingsPath
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/servers', async (req, res, next) => {
    try {
      const { mcpServers } = req.body;
      if (mcpServers === undefined) {
        throw new HttpError(400, 'mcpServers field is required', 'MISSING_FIELD');
      }

      const settingsPath = findSettingsPath();
      let settings = {};

      if (fssync.existsSync(settingsPath)) {
        try {
          const raw = await fs.readFile(settingsPath, 'utf8');
          settings = JSON.parse(raw);
        } catch {
          settings = {};
        }
      } else {
        // Ensure .claude directory exists
        const dir = path.dirname(settingsPath);
        await fs.mkdir(dir, { recursive: true });
      }

      settings.mcpServers = mcpServers;
      const tmp = settingsPath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(settings, null, 2));
      await fs.rename(tmp, settingsPath);

      res.json({ mcpServers, path: settingsPath });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
