import { Router } from 'express';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { HttpError } from '../middleware/error-handler.js';

const uploadSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(200).optional(),
  dataBase64: z.string().min(1) // raw base64 without data URL prefix
}).strict();

// Max 20 MB per upload (base64 expands ~33%, so ~27 MB on wire)
const MAX_BYTES = 20 * 1024 * 1024;

function sanitizeFilename(name) {
  // Remove path separators, keep basename only, replace unsafe chars
  const base = path.basename(name).replace(/[^\w.\-가-힣 ]/g, '_');
  return base.slice(0, 120);
}

export function createUploadsRouter({ uploadsDir, eventBus }) {
  const router = Router();

  // Ensure dir exists
  if (!fssync.existsSync(uploadsDir)) {
    fssync.mkdirSync(uploadsDir, { recursive: true });
  }

  // POST /api/uploads  — receive base64 JSON, persist to disk
  router.post('/', async (req, res, next) => {
    try {
      const body = uploadSchema.parse(req.body);
      const cleanName = sanitizeFilename(body.filename);
      const buffer = Buffer.from(body.dataBase64, 'base64');
      if (buffer.length === 0) {
        throw new HttpError(400, 'Empty upload', 'EMPTY');
      }
      if (buffer.length > MAX_BYTES) {
        throw new HttpError(413, `File too large (max ${MAX_BYTES / 1024 / 1024} MB)`, 'TOO_LARGE');
      }
      const id = nanoid(16);
      const diskName = `${id}-${cleanName}`;
      const diskPath = path.join(uploadsDir, diskName);
      await fs.writeFile(diskPath, buffer);

      const payload = {
        id,
        filename: cleanName,
        contentType: body.contentType ?? 'application/octet-stream',
        size: buffer.length,
        path: diskPath,
        createdAt: new Date().toISOString()
      };
      if (eventBus) eventBus.publish('upload.created', payload);
      res.status(201).json(payload);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // GET /api/uploads  — list files in uploadsDir
  router.get('/', async (req, res, next) => {
    try {
      const entries = await fs.readdir(uploadsDir);
      const stats = await Promise.all(
        entries.map(async (name) => {
          const p = path.join(uploadsDir, name);
          try {
            const s = await fs.stat(p);
            // Our convention: {id}-{filename}
            const m = name.match(/^([a-zA-Z0-9_-]{16})-(.+)$/);
            if (!m) return null;
            return {
              id: m[1],
              filename: m[2],
              size: s.size,
              path: p,
              createdAt: s.birthtime.toISOString()
            };
          } catch {
            return null;
          }
        })
      );
      res.json({ uploads: stats.filter((x) => x !== null) });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/uploads/:id  — serve file inline
  router.get('/:id', async (req, res, next) => {
    try {
      const entries = await fs.readdir(uploadsDir);
      const match = entries.find((n) => n.startsWith(`${req.params.id}-`));
      if (!match) return next(new HttpError(404, 'Upload not found', 'UPLOAD_NOT_FOUND'));
      res.sendFile(path.join(uploadsDir, match));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/uploads/:id
  router.delete('/:id', async (req, res, next) => {
    try {
      const entries = await fs.readdir(uploadsDir);
      const match = entries.find((n) => n.startsWith(`${req.params.id}-`));
      if (!match) return next(new HttpError(404, 'Upload not found', 'UPLOAD_NOT_FOUND'));
      await fs.unlink(path.join(uploadsDir, match));
      if (eventBus) eventBus.publish('upload.deleted', { id: req.params.id });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
