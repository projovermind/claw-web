import { Router } from 'express';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HttpError } from '../middleware/error-handler.js';

/**
 * 원클릭 설치용 MCP 서버 프리셋. 커뮤니티에서 가장 많이 쓰이는 3종.
 */
export const MCP_PRESETS = [
  {
    id: 'playwright',
    name: 'Playwright MCP',
    desc: '브라우저 자동화 — 페이지 조작·스크린샷·E2E 확인',
    config: { command: 'npx', args: ['@playwright/mcp@latest'] }
  },
  {
    id: 'context7',
    name: 'Context7',
    desc: '라이브러리 최신 문서를 실시간으로 가져오는 문서 검색 MCP',
    config: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] }
  },
  {
    id: 'github',
    name: 'GitHub MCP',
    desc: 'GitHub 이슈·PR·레포 조회 (원격 HTTP 엔드포인트)',
    config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' }
  }
];

/**
 * MCP Server configuration management.
 *
 * GET  /api/mcp/servers            → read MCP config from .claude/settings.json
 * PUT  /api/mcp/servers            → write MCP config back
 * GET  /api/mcp/presets            → list one-click presets
 * POST /api/mcp/presets/:id/apply  → merge a preset into the saved servers
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

  router.get('/presets', (_req, res) => {
    res.json({ presets: MCP_PRESETS });
  });

  router.post('/presets/:id/apply', async (req, res, next) => {
    try {
      const preset = MCP_PRESETS.find((p) => p.id === req.params.id);
      if (!preset) throw new HttpError(404, 'Preset not found', 'PRESET_NOT_FOUND');

      const settingsPath = findSettingsPath();
      let settings = {};
      if (fssync.existsSync(settingsPath)) {
        try {
          settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
        } catch {
          settings = {};
        }
      } else {
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      }

      const servers = settings.mcpServers ?? {};
      // 같은 키를 덮어쓰면 사용자가 손으로 맞춰 둔 인증/인자가 소리 없이 날아간다.
      if (servers[preset.id]) {
        throw new HttpError(409, `MCP server "${preset.id}" already exists`, 'DUPLICATE_SERVER');
      }

      settings.mcpServers = { ...servers, [preset.id]: preset.config };
      const tmp = settingsPath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(settings, null, 2));
      await fs.rename(tmp, settingsPath);

      res.json({ mcpServers: settings.mcpServers, path: settingsPath });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
