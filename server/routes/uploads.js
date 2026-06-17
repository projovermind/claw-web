import express, { Router } from 'express';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { HttpError } from '../middleware/error-handler.js';
import { createRequire } from 'node:module';
import pino from 'pino';

const log = pino({ name: 'uploads' });

// Attempt to load sharp — graceful fallback if native module unavailable
let sharp = null;
try {
  const require = createRequire(import.meta.url);
  sharp = require('sharp');
} catch {
  log.warn('sharp not available — images will be stored as-is');
}

const IMAGE_MAX_PX = 1280;
const JPEG_QUALITY = 82;

// Returns { buffer, outMime } — outMime may differ from input (e.g. PNG→JPEG)
async function maybeResizeImage(buffer, contentType) {
  if (!sharp || !contentType?.startsWith('image/')) return { buffer, outMime: contentType };
  try {
    const meta = await sharp(buffer).metadata();
    const { width = 0, height = 0, hasAlpha } = meta;
    const longest = Math.max(width, height);
    const needsResize = longest > IMAGE_MAX_PX;

    const pipeline = sharp(buffer).rotate(); // auto-orient via EXIF
    if (needsResize) {
      pipeline.resize({ width: IMAGE_MAX_PX, height: IMAGE_MAX_PX, fit: 'inside', withoutEnlargement: true });
    }

    let outBuffer, outMime;
    if (contentType === 'image/png' && hasAlpha) {
      outBuffer = await pipeline.png({ compressionLevel: 8 }).toBuffer();
      outMime = 'image/png';
    } else {
      outBuffer = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer();
      outMime = 'image/jpeg';
    }

    log.info({ before: buffer.length, after: outBuffer.length, reduction: `${((1 - outBuffer.length / buffer.length) * 100).toFixed(1)}%`, needsResize }, 'image resized');
    return { buffer: outBuffer, outMime };
  } catch (err) {
    log.warn({ err: err.message }, 'sharp resize failed — using original');
    return { buffer, outMime: contentType };
  }
}

const uploadSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(200).optional(),
  dataBase64: z.string().min(1) // raw base64 without data URL prefix
}).strict();

// Max 200 MB per upload — supports arbitrary binaries (zip, exe, installers…).
// Base64 route is capped lower in practice by the global express.json limit,
// so large files should use the /raw binary route below.
const MAX_BYTES = 200 * 1024 * 1024;

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

  // Shared: validate buffer, resize images, write to disk, publish event.
  async function persistUpload({ buffer, filename, contentType }) {
    if (!buffer || buffer.length === 0) {
      throw new HttpError(400, 'Empty upload', 'EMPTY');
    }
    if (buffer.length > MAX_BYTES) {
      throw new HttpError(413, `File too large (max ${MAX_BYTES / 1024 / 1024} MB)`, 'TOO_LARGE');
    }
    const cleanName = sanitizeFilename(filename);
    const id = nanoid(16);
    const mimeType = contentType || 'application/octet-stream';
    const { buffer: finalBuffer, outMime } = await maybeResizeImage(buffer, mimeType);

    // Rename extension if format changed (e.g. PNG-without-alpha → JPEG)
    let finalName = cleanName;
    if (outMime === 'image/jpeg' && mimeType !== 'image/jpeg') {
      finalName = cleanName.replace(/\.[^.]+$/, '.jpg');
    }

    const diskName = `${id}-${finalName}`;
    const diskPath = path.join(uploadsDir, diskName);
    await fs.writeFile(diskPath, finalBuffer);

    const payload = {
      id,
      filename: finalName,
      contentType: outMime,
      size: finalBuffer.length,
      path: diskPath,
      createdAt: new Date().toISOString()
    };
    if (eventBus) eventBus.publish('upload.created', payload);
    return payload;
  }

  // POST /api/uploads  — receive base64 JSON, persist to disk (small files / pasted images)
  router.post('/', async (req, res, next) => {
    try {
      const body = uploadSchema.parse(req.body);
      const payload = await persistUpload({
        buffer: Buffer.from(body.dataBase64, 'base64'),
        filename: body.filename,
        contentType: body.contentType
      });
      res.status(201).json(payload);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // POST /api/uploads/raw?name=<filename>  — raw binary body, any file type.
  // Avoids base64 inflation + the global express.json limit, so large
  // binaries (zip, exe, installers) can be transferred efficiently.
  router.post('/raw', express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res, next) => {
    try {
      const rawName = typeof req.query.name === 'string' ? req.query.name : '';
      let filename = 'upload.bin';
      try { filename = decodeURIComponent(rawName) || filename; } catch { filename = rawName || filename; }
      const payload = await persistUpload({
        buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        filename,
        contentType: req.headers['x-upload-content-type'] || req.headers['content-type']
      });
      res.status(201).json(payload);
    } catch (err) {
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
      // html/svg 업로드를 앱 origin 에서 inline 렌더하면 스크립트 실행(XSS) 가능
      // → text/plain 으로 강등 + nosniff.
      const ext = path.extname(match).toLowerCase();
      const headers = { 'X-Content-Type-Options': 'nosniff' };
      if (ext === '.html' || ext === '.svg') headers['Content-Type'] = 'text/plain; charset=utf-8';
      res.sendFile(path.join(uploadsDir, match), { headers });
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
