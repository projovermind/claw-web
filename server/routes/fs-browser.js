import { Router } from 'express';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';

const mkdirSchema = z.object({
  // The parent directory (must be inside allowedRoots)
  path: z.string().min(1).max(1000),
  // The new folder name — single segment, no slashes, no traversal
  name: z.string().min(1).max(100)
}).strict();

/**
 * Read-only filesystem browser, restricted to allowedRoots.
 *
 * GET /api/fs/roots          → list allowedRoots
 * GET /api/fs/ls?path=<abs>  → list directories inside <abs>
 *
 * Only directories are returned (project paths are always directories).
 * Hidden entries (dotfiles) and files are filtered out to keep the picker
 * clean. The allowedRoots check blocks any traversal outside the sandboxed
 * roots — even if the path the client sends is absolute.
 */
export function createFsBrowserRouter({ webConfig }) {
  const router = Router();

  function resolveAllowedRoots() {
    return (webConfig.allowedRoots ?? []).map((r) => path.resolve(r));
  }

  function isInsideAllowed(absPath) {
    const resolved = path.resolve(absPath);
    const roots = resolveAllowedRoots();
    return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  }

  // path.resolve 는 symlink 를 풀지 않음 — allowedRoots 내부의 symlink 가
  // 외부(~/.ssh 등)를 가리키면 isInsideAllowed 를 통과해 버린다.
  // 실제 디스크 경로(realpath)로 한 번 더 검증. 존재하지 않으면 ENOENT throw.
  // root 쪽도 realpath 로 비교 — macOS 의 /var → /private/var 처럼 root 경로
  // 자체에 symlink 구성요소가 있으면 정상 요청까지 403 이 되는 것을 방지.
  async function assertRealInsideAllowed(absPath) {
    const real = await fs.realpath(absPath);
    const realRoots = await Promise.all(
      resolveAllowedRoots().map(async (r) => {
        try { return await fs.realpath(r); } catch { return r; }
      })
    );
    const ok = realRoots.some((root) => real === root || real.startsWith(root + path.sep));
    if (!ok) {
      throw new HttpError(403, 'Path escapes allowedRoots (symlink)', 'OUTSIDE_ALLOWED_ROOTS');
    }
    return real;
  }

  router.get('/roots', (req, res) => {
    const roots = resolveAllowedRoots();
    res.json({
      roots: roots.map((r) => ({
        path: r,
        name: path.basename(r) || r
      }))
    });
  });

  router.post('/mkdir', async (req, res, next) => {
    try {
      const { path: parentPath, name } = mkdirSchema.parse(req.body);
      // Name must be a single safe segment — no path separators, no "." / ".."
      if (/[\/\\]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
        throw new HttpError(
          400,
          'Folder name must be a single segment and cannot start with "."',
          'BAD_NAME'
        );
      }
      const parentAbs = path.resolve(parentPath);
      if (!isInsideAllowed(parentAbs)) {
        throw new HttpError(
          403,
          `Parent path is outside allowedRoots: ${parentAbs}`,
          'OUTSIDE_ALLOWED_ROOTS'
        );
      }
      // Verify parent actually exists and is a directory
      try {
        const stat = await fs.stat(parentAbs);
        if (!stat.isDirectory()) {
          throw new HttpError(400, `Not a directory: ${parentAbs}`, 'NOT_DIR');
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err.code === 'ENOENT') {
          throw new HttpError(404, `Parent not found: ${parentAbs}`, 'NOT_FOUND');
        }
        throw err;
      }
      const newPath = path.join(parentAbs, name);
      // Defensive: the join result must ALSO be inside allowedRoots (paranoia
      // against Unicode tricks that could slip through the name regex)
      if (!isInsideAllowed(newPath)) {
        throw new HttpError(403, 'Resolved path escapes allowedRoots', 'OUTSIDE_ALLOWED_ROOTS');
      }
      try {
        await fs.mkdir(newPath, { recursive: false });
      } catch (err) {
        if (err.code === 'EEXIST') {
          throw new HttpError(409, `Folder already exists: ${name}`, 'ALREADY_EXISTS');
        }
        if (err.code === 'EACCES') {
          throw new HttpError(403, `Permission denied: ${newPath}`, 'PERMISSION_DENIED');
        }
        throw err;
      }
      res.status(201).json({ path: newPath, name });
    } catch (err) {
      if (err.name === 'ZodError') {
        const first = err.issues?.[0];
        const msg = first ? `${first.path.join('.') || 'field'}: ${first.message}` : 'Invalid body';
        return next(new HttpError(400, msg, 'INVALID_BODY'));
      }
      next(err);
    }
  });

  router.get('/ls', async (req, res, next) => {
    try {
      const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
      if (!rawPath) {
        throw new HttpError(400, 'path query param required', 'MISSING_PATH');
      }
      const absPath = path.resolve(rawPath);
      if (!isInsideAllowed(absPath)) {
        throw new HttpError(
          403,
          `Path is outside allowedRoots: ${absPath}`,
          'OUTSIDE_ALLOWED_ROOTS'
        );
      }
      try {
        await assertRealInsideAllowed(absPath);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err.code === 'ENOENT') throw new HttpError(404, `Directory not found: ${absPath}`, 'NOT_FOUND');
        throw err;
      }
      let entries;
      try {
        entries = await fs.readdir(absPath, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new HttpError(404, `Directory not found: ${absPath}`, 'NOT_FOUND');
        }
        if (err.code === 'ENOTDIR') {
          throw new HttpError(400, `Not a directory: ${absPath}`, 'NOT_DIR');
        }
        if (err.code === 'EACCES') {
          throw new HttpError(403, `Permission denied: ${absPath}`, 'PERMISSION_DENIED');
        }
        throw err;
      }

      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          path: path.join(absPath, e.name)
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

      const parent = path.dirname(absPath);
      const parentAllowed = isInsideAllowed(parent) && parent !== absPath;

      res.json({
        path: absPath,
        parent: parentAllowed ? parent : null,
        entries: dirs
      });
    } catch (err) {
      next(err);
    }
  });

  // Fuzzy file search: GET /api/fs/search?root=<abs>&q=<query>&limit=30
  // Walks the root directory (respecting allowedRoots), finds files (not dirs)
  // whose basename or relative path contains every space-separated query token,
  // sorted by relevance (basename match beats path-only match). Skips node_modules,
  // .git, dist, __pycache__, .next, .cache, and hidden dirs.
  router.get('/search', async (req, res, next) => {
    try {
      const rootRaw = typeof req.query.root === 'string' ? req.query.root : '';
      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
      const limit = Math.min(Number(req.query.limit) || 30, 100);
      if (!rootRaw) throw new HttpError(400, 'root param required', 'MISSING_ROOT');
      const root = path.resolve(rootRaw);
      if (!isInsideAllowed(root)) {
        throw new HttpError(403, 'Root outside allowedRoots', 'OUTSIDE_ALLOWED_ROOTS');
      }
      try {
        await assertRealInsideAllowed(root);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err.code === 'ENOENT') throw new HttpError(404, 'Root not found', 'NOT_FOUND');
        throw err;
      }
      if (!q) {
        return res.json({ root, results: [] });
      }

      const tokens = q.split(/\s+/).filter(Boolean);
      const SKIP = new Set([
        'node_modules', '.git', 'dist', '__pycache__', '.next', '.cache',
        '.DS_Store', '.tsbuildinfo', '.turbo'
      ]);

      const results = [];
      const maxDepth = 8;

      async function walk(dir, depth) {
        if (depth > maxDepth || results.length >= limit * 3) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return; // permission denied, broken link, etc.
        }
        for (const e of entries) {
          if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full, depth + 1);
          } else if (e.isFile()) {
            const rel = path.relative(root, full);
            const blob = rel.toLowerCase();
            const nameBlob = e.name.toLowerCase();
            const allMatch = tokens.every((t) => blob.includes(t));
            if (allMatch) {
              const nameHit = tokens.every((t) => nameBlob.includes(t));
              results.push({ name: e.name, path: full, rel, nameHit });
            }
          }
        }
      }

      await walk(root, 0);

      // Sort: basename-match first, then alphabetical by relative path
      results.sort((a, b) => {
        if (a.nameHit !== b.nameHit) return a.nameHit ? -1 : 1;
        return a.rel.localeCompare(b.rel);
      });

      res.json({
        root,
        results: results.slice(0, limit).map((r) => ({
          name: r.name,
          path: r.path,
          rel: r.rel
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  // File tree listing (Phase 3): files + directories, non-recursive (lazy).
  // GET /api/fs/tree?path=<abs>
  //   → { path, parent, entries: [{ name, path, kind: 'dir'|'file', size?, mtime? }] }
  // Hidden dot-entries and common heavy dirs (node_modules, .git, dist) are filtered.
  router.get('/tree', async (req, res, next) => {
    try {
      const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
      if (!rawPath) throw new HttpError(400, 'path param required', 'MISSING_PATH');
      const absPath = path.resolve(rawPath);
      if (!isInsideAllowed(absPath)) {
        throw new HttpError(403, `Path outside allowedRoots: ${absPath}`, 'OUTSIDE_ALLOWED_ROOTS');
      }
      try {
        await assertRealInsideAllowed(absPath);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err.code === 'ENOENT') throw new HttpError(404, 'Not found', 'NOT_FOUND');
        throw err;
      }
      let entries;
      try {
        entries = await fs.readdir(absPath, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') throw new HttpError(404, 'Not found', 'NOT_FOUND');
        if (err.code === 'ENOTDIR') throw new HttpError(400, 'Not a directory', 'NOT_DIR');
        if (err.code === 'EACCES') throw new HttpError(403, 'Permission denied', 'PERMISSION_DENIED');
        throw err;
      }

      const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__', '.next', '.cache', '.turbo']);
      const dirs = [];
      const files = [];

      await Promise.all(entries.map(async (e) => {
        if (e.name.startsWith('.')) return;
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) return;
        const full = path.join(absPath, e.name);
        if (e.isDirectory()) {
          dirs.push({ name: e.name, path: full, kind: 'dir' });
        } else if (e.isFile()) {
          let size = 0, mtime = null;
          try {
            const st = await fs.stat(full);
            size = st.size;
            mtime = st.mtime.toISOString();
          } catch { /* ignore */ }
          files.push({ name: e.name, path: full, kind: 'file', size, mtime });
        }
      }));

      dirs.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      files.sort((a, b) => a.name.localeCompare(b.name, 'ko'));

      const parent = path.dirname(absPath);
      const parentAllowed = isInsideAllowed(parent) && parent !== absPath;

      res.json({
        path: absPath,
        parent: parentAllowed ? parent : null,
        entries: [...dirs, ...files]
      });
    } catch (err) {
      next(err);
    }
  });

  // Serve a raw file from disk (restricted to allowedRoots).
  // GET /api/fs/file?path=<absolute_path>
  // Used by the client to render images inline and provide download links
  // for files created by agents (Write/Edit tool calls).
  router.get('/file', async (req, res, next) => {
    try {
      const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
      if (!rawPath) throw new HttpError(400, 'path required', 'MISSING_PATH');
      const absPath = path.resolve(rawPath);
      if (!isInsideAllowed(absPath)) {
        throw new HttpError(403, 'Path outside allowedRoots', 'OUTSIDE_ALLOWED_ROOTS');
      }
      try {
        await assertRealInsideAllowed(absPath);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err.code === 'ENOENT') throw new HttpError(404, 'File not found', 'NOT_FOUND');
        throw err;
      }
      let fileSize = 0;
      try {
        const stat = await fs.stat(absPath);
        if (!stat.isFile()) throw new HttpError(400, 'Not a file', 'NOT_FILE');
        // Size limit: 500MB
        if (stat.size > 500 * 1024 * 1024) {
          throw new HttpError(413, 'File too large (max 500MB)', 'TOO_LARGE');
        }
        fileSize = stat.size;
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err.code === 'ENOENT') throw new HttpError(404, 'File not found', 'NOT_FOUND');
        throw err;
      }
      // Determine content type from extension
      const ext = path.extname(absPath).toLowerCase();
      const MIME = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf', '.json': 'application/json',
        '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
        '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
        '.ts': 'text/typescript', '.tsx': 'text/typescript',
        '.zip': 'application/zip', '.tar': 'application/x-tar',
      };
      let contentType = MIME[ext] || 'application/octet-stream';
      const isDownload = req.query.download === 'true';
      // html/svg 를 앱 origin 에서 inline 렌더하면 파일 내 스크립트가 실행되어
      // localStorage 토큰 탈취 가능 (에이전트가 만든 파일 = 신뢰 불가).
      // 다운로드가 아니면 text/plain 으로 강등.
      if (!isDownload && (ext === '.html' || ext === '.svg')) {
        contentType = 'text/plain; charset=utf-8';
      }
      if (isDownload) {
        const safeName = path.basename(absPath).replace(/["\r\n]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileSize);
      // Stream from disk to avoid buffering large files (installers, archives) in memory.
      const stream = createReadStream(absPath);
      stream.on('error', (err) => {
        if (!res.headersSent) next(err);
        else res.destroy(err);
      });
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
