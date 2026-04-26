import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Plain-text secrets store for backend API keys, kept out of git.
 *
 * Why: the original design required the user to set env vars in their shell
 * (`export ZAI_API_KEY=...`) and restart the server. That's painful for
 * beginners. Now the UI can accept the key value directly, and we store it
 * in `secrets.json` (gitignored) with 0600 permissions.
 *
 * On init, every secret is also written into `process.env[envKey]`, so any
 * existing code that reads `process.env[backend.envKey]` (including
 * child_process.spawn env inheritance) keeps working unchanged. Live updates
 * via `set()` also update process.env in place, so the next spawn picks
 * them up without a server restart.
 *
 * Shape:
 *   {
 *     "version": 1,
 *     "backends": {
 *       "<backendId>": { "envKey": "ZAI_API_KEY", "value": "sk-..." }
 *     }
 *   }
 *
 * Only the envKey + value pair is stored. If you later rename a backend's
 * envKey, call `set(backendId, newEnvKey, value)` to re-stamp.
 */
export async function createSecretsStore({ filePath }) {
  const dir = path.dirname(filePath);
  if (!fssync.existsSync(dir)) {
    fssync.mkdirSync(dir, { recursive: true });
  }

  let state = { version: 1, backends: {}, oauth: {} };
  if (fssync.existsSync(filePath)) {
    try {
      state = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!state.backends) state.backends = {};
      if (!state.oauth) state.oauth = {};
    } catch (err) {
      logger.warn({ err, filePath }, 'secrets-store: parse failed, starting empty');
      state = { version: 1, backends: {}, oauth: {} };
    }
  } else {
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  // Hydrate process.env from stored secrets — do NOT overwrite values already
  // set in the parent env (shell / launchctl setenv), so the user can still
  // override via shell if they prefer.
  let hydrated = 0;
  for (const [, info] of Object.entries(state.backends)) {
    if (info?.envKey && info?.value && !process.env[info.envKey]) {
      process.env[info.envKey] = info.value;
      hydrated += 1;
    }
  }
  if (hydrated > 0) {
    logger.info({ hydrated }, 'secrets-store: loaded secrets into process.env');
  }

  // Serialize writes
  let writeChain = Promise.resolve();
  function flush() {
    writeChain = writeChain.then(async () => {
      const tmp = filePath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await fs.rename(tmp, filePath);
      try {
        await fs.chmod(filePath, 0o600);
      } catch {
        /* ignore */
      }
    });
    return writeChain;
  }

  return {
    /**
     * Returns whether the given backend has a secret configured — either
     * via the stored secrets.json OR via a pre-existing process.env var.
     */
    status(backendId, envKey) {
      if (!envKey) return 'n/a';
      if (process.env[envKey]) return 'set';
      return 'unset';
    },

    /**
     * Store the given value for backendId and inject it into process.env.
     * Value can be null/empty to CLEAR the secret.
     */
    async set(backendId, envKey, value) {
      if (!envKey) throw new Error('envKey is required');
      if (!value) {
        // Clear
        delete state.backends[backendId];
        // Also remove from process.env only if it came from us — we can't
        // distinguish that here, so just always unset to be safe.
        delete process.env[envKey];
        await flush();
        return;
      }
      state.backends[backendId] = { envKey, value };
      process.env[envKey] = value;
      await flush();
    },

    /**
     * When a backend is deleted entirely, forget its secret.
     */
    async forget(backendId) {
      const info = state.backends[backendId];
      if (info) {
        delete state.backends[backendId];
        if (info.envKey) delete process.env[info.envKey];
      }
      // Also forget any managed OAuth token
      if (state.oauth[backendId]) {
        delete state.oauth[backendId];
      }
      await flush();
    },

    // ── Managed OAuth tokens (Claude CLI: CLAUDE_CODE_OAUTH_TOKEN) ──
    // Each Claude CLI backend can carry its own long-lived OAuth token (from
    // Anthropic Console). These are NOT hydrated into process.env (they would
    // collide — they all share the same env key). Instead, the runner looks
    // up the right token per-spawn via getOAuth().
    getOAuth(backendId) {
      return state.oauth?.[backendId] ?? null;
    },

    async setOAuth(backendId, token) {
      if (!backendId) throw new Error('backendId is required');
      if (!token) {
        delete state.oauth[backendId];
      } else {
        state.oauth[backendId] = token;
      }
      await flush();
    },

    hasOAuth(backendId) {
      return !!state.oauth?.[backendId];
    },

    _getState: () => state
  };
}
