import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { HttpError } from '../middleware/error-handler.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

/**
 * Session token registry — process-memory only. Restart = all sessions revoked.
 * Keeps username/password auth simple without adding a JWT dependency.
 */
function createSessionRegistry() {
  const sessions = new Map(); // token -> { userId, createdAt, expiresAt }

  function gc() {
    const now = Date.now();
    for (const [t, s] of sessions) {
      if (s.expiresAt < now) sessions.delete(t);
    }
  }

  return {
    issue(userId) {
      gc();
      const token = nanoid(48);
      const now = Date.now();
      sessions.set(token, { userId, createdAt: now, expiresAt: now + SESSION_TTL_MS });
      return token;
    },
    lookup(token) {
      if (!token) return null;
      const s = sessions.get(token);
      if (!s) return null;
      if (s.expiresAt < Date.now()) {
        sessions.delete(token);
        return null;
      }
      return s;
    },
    revoke(token) {
      sessions.delete(token);
    },
    revokeUser(userId) {
      for (const [t, s] of sessions) {
        if (s.userId === userId) sessions.delete(t);
      }
    },
  };
}

const loginSchema = z.object({
  username: z.string().min(1).max(80),
  password: z.string().min(1).max(200),
}).strict();

const createUserSchema = z.object({
  username: z.string().min(1).max(80),
  password: z.string().min(1).max(200),
  role: z.enum(['admin', 'user']).optional(),
}).strict();

const patchUserSchema = z.object({
  password: z.string().min(1).max(200).optional(),
  role: z.enum(['admin', 'user']).optional(),
}).strict();

export function createAuthRouter({ adminUsersStore, sessionRegistry }) {
  const router = Router();

  // ── Public — no auth required (whitelisted in middleware) ──
  // GET /info — tells the UI whether user-mode login is active.
  router.get('/info', (_req, res) => {
    res.json({
      hasUsers: adminUsersStore.count() > 0,
      userMode: adminUsersStore.count() > 0,
    });
  });

  // POST /login — exchange username/password for a session token.
  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = loginSchema.parse(req.body);
      const user = await adminUsersStore.verify(username, password);
      if (!user) return next(new HttpError(401, 'Invalid credentials', 'AUTH_INVALID'));
      const token = sessionRegistry.issue(user.id);
      res.json({ token, user });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // ── Authenticated routes (auth middleware enforces session/bearer) ──

  // POST /logout — revoke the caller's session token.
  router.post('/logout', (req, res) => {
    const token = req._sessionToken ?? null;
    if (token) sessionRegistry.revoke(token);
    res.status(204).end();
  });

  // GET /me — current user (or null if authed via legacy bearer token).
  router.get('/me', (req, res) => {
    res.json({ user: req._authUser ?? null });
  });

  function requireAdmin(req, res, next) {
    // Legacy bearer token == implicit admin (it's the master token).
    if (!req._authUser) return next();
    if (req._authUser.role === 'admin') return next();
    next(new HttpError(403, 'Admin role required', 'FORBIDDEN'));
  }

  // GET /users — list all admin users (admin only).
  router.get('/users', requireAdmin, (_req, res) => {
    res.json({ users: adminUsersStore.list() });
  });

  // POST /users — create new user (admin only).
  router.post('/users', requireAdmin, async (req, res, next) => {
    try {
      const data = createUserSchema.parse(req.body);
      const user = await adminUsersStore.create(data);
      res.status(201).json(user);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (err.code === 'DUPLICATE') return next(new HttpError(409, err.message, 'DUPLICATE'));
      if (err.code === 'INVALID') return next(new HttpError(400, err.message, 'INVALID'));
      next(err);
    }
  });

  // PATCH /users/:id — change password / role.
  // Self may change own password. Admin may change anything.
  router.patch('/users/:id', async (req, res, next) => {
    try {
      const data = patchUserSchema.parse(req.body);
      const target = adminUsersStore.getById(req.params.id);
      if (!target) return next(new HttpError(404, 'User not found', 'NOT_FOUND'));

      const isAdmin = !req._authUser || req._authUser.role === 'admin';
      const isSelf = req._authUser && req._authUser.id === target.id;

      if (!isAdmin) {
        if (!isSelf) return next(new HttpError(403, 'Forbidden', 'FORBIDDEN'));
        if (data.role) return next(new HttpError(403, 'Cannot change own role', 'FORBIDDEN'));
      }

      let updated = target;
      if (data.password) updated = await adminUsersStore.setPassword(target.id, data.password);
      if (data.role) updated = await adminUsersStore.setRole(target.id, data.role);
      res.json(updated);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (err.code === 'NOT_FOUND') return next(new HttpError(404, err.message, 'NOT_FOUND'));
      if (err.code === 'INVALID') return next(new HttpError(400, err.message, 'INVALID'));
      next(err);
    }
  });

  // DELETE /users/:id — admin only. Refuse to delete the last admin.
  router.delete('/users/:id', requireAdmin, async (req, res, next) => {
    try {
      const target = adminUsersStore.getById(req.params.id);
      if (!target) return next(new HttpError(404, 'User not found', 'NOT_FOUND'));
      if (target.role === 'admin') {
        const remainingAdmins = adminUsersStore.list().filter((u) => u.role === 'admin' && u.id !== target.id);
        if (remainingAdmins.length === 0) {
          return next(new HttpError(400, 'Cannot delete the last admin user', 'LAST_ADMIN'));
        }
      }
      await adminUsersStore.remove(target.id);
      sessionRegistry.revokeUser(target.id);
      res.status(204).end();
    } catch (err) {
      if (err.code === 'NOT_FOUND') return next(new HttpError(404, err.message, 'NOT_FOUND'));
      next(err);
    }
  });

  return router;
}

export { createSessionRegistry };
