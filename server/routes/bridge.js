/**
 * VS Code Bridge endpoint — Phase 5
 *
 * A minimal "push last editor state from the IDE to claw-web" channel.
 * The VS Code extension (claw-web-bridge) POSTs its current state here:
 *   - open files
 *   - active file
 *   - selection / cursor
 *   - workspace folders
 *
 * Agents can opt in (agent.bridgeAutoAttach) to have this context injected
 * into every turn. We also expose GET for the UI to display what the bridge
 * is currently reporting.
 *
 * Storage is in-memory with a per-workspace short TTL — the bridge is meant
 * to be the live, freshest signal; stale state is worse than no state.
 */
import { Router } from 'express';
import { z } from 'zod';
import path from 'node:path';
import { HttpError } from '../middleware/error-handler.js';

const CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 min

const fileRefSchema = z.object({
  path: z.string().min(1).max(1000),
  languageId: z.string().max(50).optional(),
  isDirty: z.boolean().optional()
}).strict();

const selectionSchema = z.object({
  path: z.string().max(1000),
  startLine: z.number().int().min(0),
  startColumn: z.number().int().min(0),
  endLine: z.number().int().min(0),
  endColumn: z.number().int().min(0),
  text: z.string().max(64 * 1024).optional()
}).strict();

const contextSchema = z.object({
  workspaceFolders: z.array(z.string().max(1000)).max(10).optional(),
  activeFile: fileRefSchema.nullable().optional(),
  openFiles: z.array(fileRefSchema).max(200).optional(),
  selection: selectionSchema.nullable().optional(),
  cursor: z.object({ path: z.string().max(1000), line: z.number().int().min(0), column: z.number().int().min(0) }).nullable().optional(),
  ideVersion: z.string().max(50).optional()
}).strict();

export function createBridgeRouter({ webConfig }) {
  const router = Router();

  // Map of workspace (first folder absolute path) → { context, updatedAt }
  const state = new Map();

  function resolveAllowedRoots() {
    return (webConfig.allowedRoots ?? []).map((r) => path.resolve(r));
  }
  function insideAllowed(absPath) {
    const resolved = path.resolve(absPath);
    return resolveAllowedRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));
  }

  function gc() {
    const now = Date.now();
    for (const [k, v] of state) {
      if (now - v.updatedAt > CONTEXT_TTL_MS) state.delete(k);
    }
  }

  router.post('/context', (req, res, next) => {
    try {
      const parsed = contextSchema.parse(req.body);
      // Derive workspace key from first workspaceFolder or activeFile's dir
      let key = null;
      if (Array.isArray(parsed.workspaceFolders) && parsed.workspaceFolders.length > 0) {
        key = path.resolve(parsed.workspaceFolders[0]);
      } else if (parsed.activeFile?.path) {
        key = path.dirname(path.resolve(parsed.activeFile.path));
      }
      if (!key) throw new HttpError(400, 'no workspace or activeFile provided', 'NO_KEY');
      if (!insideAllowed(key)) {
        throw new HttpError(403, `workspace outside allowedRoots: ${key}`, 'OUTSIDE_ALLOWED_ROOTS');
      }
      gc();
      state.set(key, { context: parsed, updatedAt: Date.now() });
      res.json({ ok: true, key, storedAt: new Date().toISOString() });
    } catch (err) {
      if (err?.name === 'ZodError') {
        const first = err.issues?.[0];
        const msg = first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'invalid body';
        return next(new HttpError(400, msg, 'INVALID_BODY'));
      }
      next(err);
    }
  });

  router.get('/context', (req, res, next) => {
    try {
      const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : '';
      gc();
      if (workspace) {
        const key = path.resolve(workspace);
        const entry = state.get(key);
        if (!entry) return res.json({ workspace: key, context: null });
        return res.json({ workspace: key, context: entry.context, updatedAt: new Date(entry.updatedAt).toISOString() });
      }
      // No workspace: return a map of all current workspaces (metadata only)
      const entries = [];
      for (const [k, v] of state) {
        entries.push({ workspace: k, updatedAt: new Date(v.updatedAt).toISOString() });
      }
      res.json({ workspaces: entries });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/context', (req, res, next) => {
    try {
      const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : '';
      if (!workspace) {
        state.clear();
        return res.json({ ok: true, cleared: 'all' });
      }
      const key = path.resolve(workspace);
      state.delete(key);
      res.json({ ok: true, cleared: key });
    } catch (err) {
      next(err);
    }
  });

  // Shared store-style read helper for other modules (message injection)
  router.getContextForWorkspace = (workspace) => {
    if (!workspace) return null;
    const key = path.resolve(workspace);
    gc();
    const entry = state.get(key);
    return entry ? entry.context : null;
  };

  return router;
}
