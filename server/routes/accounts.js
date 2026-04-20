import { Router } from 'express';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { HttpError } from '../middleware/error-handler.js';

const execFileAsync = promisify(execFile);

const createSchema = z.object({
  label: z.string().min(1).max(80),
  configDir: z.string().max(500).optional(),
  priority: z.number().int().min(0).max(999).optional(),
}).strict();

const updateSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  configDir: z.string().max(500).optional(),
  status: z.enum(['active', 'cooldown', 'disabled']).optional(),
  priority: z.number().int().min(0).max(999).optional(),
}).strict();

function findClaudeBin() {
  const candidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  return 'claude';
}

const CLAUDE_BIN = findClaudeBin();

export function createAccountsRouter({ accountsStore, eventBus }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ accounts: accountsStore.getAll() });
  });

  router.get('/:id', (req, res, next) => {
    const acc = accountsStore.getById(req.params.id);
    if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));
    res.json(acc);
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = createSchema.parse(req.body);
      const home = process.env.HOME || process.env.USERPROFILE || '/tmp';

      // Create account first to get the ID
      const account = await accountsStore.create({
        label: data.label,
        configDir: data.configDir ?? '',  // placeholder, updated below
        priority: data.priority ?? 0,
      });

      // Resolve final configDir
      const configDir = data.configDir || path.join(home, '.claude-claw', `account-${account.id}`);
      await fs.mkdir(configDir, { recursive: true });

      if (!data.configDir) {
        await accountsStore.update(account.id, { configDir });
      }

      eventBus?.publish('accounts.updated', {});
      res.status(201).json(accountsStore.getById(account.id));
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const patch = updateSchema.parse(req.body);
      const updated = await accountsStore.update(req.params.id, patch);

      if (patch.configDir) {
        await fs.mkdir(patch.configDir, { recursive: true }).catch(() => {});
      }

      eventBus?.publish('accounts.updated', {});
      res.json(updated);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (err.code === 'NOT_FOUND') return next(new HttpError(404, err.message, 'NOT_FOUND'));
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await accountsStore.delete(req.params.id);
      eventBus?.publish('accounts.updated', {});
      res.status(204).end();
    } catch (err) {
      if (err.code === 'NOT_FOUND') return next(new HttpError(404, err.message, 'NOT_FOUND'));
      next(err);
    }
  });

  // POST /:id/test — run `claude --version` with account's CLAUDE_CONFIG_DIR
  router.post('/:id/test', async (req, res, next) => {
    try {
      const acc = accountsStore.getById(req.params.id);
      if (!acc) return next(new HttpError(404, 'Account not found', 'NOT_FOUND'));

      const env = { ...process.env, CLAUDE_CONFIG_DIR: acc.configDir };
      const { stdout, stderr } = await execFileAsync(CLAUDE_BIN, ['--version'], {
        env,
        timeout: 10_000,
      });

      res.json({
        ok: true,
        configDir: acc.configDir,
        output: (stdout || stderr || '').trim(),
      });
    } catch (err) {
      const acc = accountsStore.getById(req.params.id);
      res.json({
        ok: false,
        configDir: acc?.configDir,
        error: err.message,
      });
    }
  });

  return router;
}
