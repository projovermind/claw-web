import { Router } from 'express';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';

const writeSchema = z.object({
  content: z.string().max(200000),
  // Optional: if provided, must match the current file's mtime for the write
  // to proceed. This prevents silent overwrite of external edits (e.g. someone
  // editing CLAUDE.md in VS Code while the web modal is open).
  ifMatchMtime: z.number().optional()
}).strict();

// Only allow exactly these filenames at the project root
const ALLOWED_FILENAMES = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);

/**
 * Per-project markdown editor (primarily CLAUDE.md).
 *
 * GET    /api/projects/:id/md           → { filename: 'CLAUDE.md', exists, content, size }
 * PUT    /api/projects/:id/md           → writes body.content to CLAUDE.md at project root
 * GET    /api/projects/:id/md/:filename → reads a specific allowlisted filename
 * PUT    /api/projects/:id/md/:filename → writes to a specific allowlisted filename
 *
 * Security:
 * - Only writes to files at the exact project.path (no subdirs)
 * - Filename must be in ALLOWED_FILENAMES (prevents path traversal + overwrite of source code)
 * - Project.path must be within webConfig.allowedRoots
 */
export function createProjectMdRouter({ projectsStore, webConfig, eventBus }) {
  const router = Router();

  function resolveFile(projectId, filename) {
    const project = projectsStore.getById(projectId);
    if (!project) {
      throw new HttpError(404, `Project ${projectId} not found`, 'PROJECT_NOT_FOUND');
    }
    if (!ALLOWED_FILENAMES.has(filename)) {
      throw new HttpError(400, `Filename not allowed: ${filename}`, 'BAD_FILENAME');
    }
    const projectPath = path.resolve(project.path);
    // allowedRoots check
    const allowedRoots = (webConfig.allowedRoots ?? []).map((r) => path.resolve(r));
    const inAllowedRoot = allowedRoots.some((root) => projectPath.startsWith(root));
    if (!inAllowedRoot) {
      throw new HttpError(
        403,
        'Project path is outside allowedRoots — cannot read/write files',
        'OUTSIDE_ALLOWED_ROOTS'
      );
    }
    const filePath = path.join(projectPath, filename);
    // Verify no traversal
    if (!path.resolve(filePath).startsWith(projectPath + path.sep) && path.resolve(filePath) !== path.join(projectPath, filename)) {
      throw new HttpError(400, 'Path traversal detected', 'BAD_PATH');
    }
    return { project, filePath };
  }

  async function readMd(projectId, filename) {
    const { filePath } = resolveFile(projectId, filename);
    let exists = false;
    let content = '';
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = await fs.stat(filePath);
      exists = true;
      size = stat.size;
      mtimeMs = Math.floor(stat.mtimeMs);
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      // file doesn't exist yet — return empty
    }
    return { filename, exists, size, mtimeMs, content, filePath };
  }

  async function writeMd(projectId, filename, content, ifMatchMtime) {
    const { filePath, project } = resolveFile(projectId, filename);
    // Ensure project dir exists (we won't create it; require it)
    if (!fssync.existsSync(project.path)) {
      throw new HttpError(404, `Project directory does not exist: ${project.path}`, 'DIR_NOT_FOUND');
    }
    // Conflict detection: if caller provided ifMatchMtime, compare with current mtime.
    // - File doesn't exist yet + ifMatchMtime === 0 → OK (create new)
    // - File exists with matching mtime → OK (safe overwrite)
    // - Mismatch → 409 Conflict, client shows merge UI
    if (ifMatchMtime !== undefined) {
      let currentMtime = 0;
      try {
        const stat = await fs.stat(filePath);
        currentMtime = Math.floor(stat.mtimeMs);
      } catch {
        currentMtime = 0;
      }
      if (currentMtime !== ifMatchMtime) {
        throw new HttpError(
          409,
          `File was modified externally (expected mtime ${ifMatchMtime}, got ${currentMtime})`,
          'MTIME_CONFLICT'
        );
      }
    }
    // Atomic write
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, filePath);
    const stat = await fs.stat(filePath);
    return {
      filename,
      exists: true,
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      filePath
    };
  }

  // Default CLAUDE.md
  router.get('/:id/md', async (req, res, next) => {
    try {
      const data = await readMd(req.params.id, 'CLAUDE.md');
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id/md', async (req, res, next) => {
    try {
      const { content, ifMatchMtime } = writeSchema.parse(req.body);
      const data = await writeMd(req.params.id, 'CLAUDE.md', content, ifMatchMtime);
      if (eventBus) eventBus.publish('project.md.updated', { projectId: req.params.id, filename: 'CLAUDE.md' });
      res.json(data);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // Generic by filename
  router.get('/:id/md/:filename', async (req, res, next) => {
    try {
      const data = await readMd(req.params.id, req.params.filename);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id/md/:filename', async (req, res, next) => {
    try {
      const { content, ifMatchMtime } = writeSchema.parse(req.body);
      const data = await writeMd(req.params.id, req.params.filename, content, ifMatchMtime);
      if (eventBus) eventBus.publish('project.md.updated', { projectId: req.params.id, filename: req.params.filename });
      res.json(data);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  return router;
}
