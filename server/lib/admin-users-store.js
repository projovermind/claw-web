import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';
import { logger } from './logger.js';

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;

/** Format: scrypt$<saltHex>$<hashHex> */
async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== KEY_LEN) return false;
  const computed = await scryptAsync(password, salt, KEY_LEN);
  return timingSafeEqual(expected, computed);
}

/**
 * Admin users store — username/password accounts for the web UI.
 *
 * File shape: { version: 1, users: { [id]: { id, username, passwordHash, role, createdAt, updatedAt } } }
 * role: 'admin' | 'user' (admin can manage other users)
 *
 * Stored at data/private/admin-users.json with 0600 permissions.
 */
export async function createAdminUsersStore(filePath) {
  const dir = path.dirname(filePath);
  if (!fssync.existsSync(dir)) {
    fssync.mkdirSync(dir, { recursive: true });
  }

  let state = { version: 1, users: {} };
  if (fssync.existsSync(filePath)) {
    try {
      state = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!state.users) state.users = {};
    } catch (err) {
      logger.warn({ err: err.message, filePath }, 'admin-users-store: parse failed, starting empty');
      state = { version: 1, users: {} };
    }
  } else {
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  async function persist() {
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  function publicUser(u) {
    if (!u) return null;
    return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, updatedAt: u.updatedAt };
  }

  return {
    count() {
      return Object.keys(state.users).length;
    },

    list() {
      return Object.values(state.users).map(publicUser);
    },

    getById(id) {
      return publicUser(state.users[id]);
    },

    getByUsername(username) {
      const u = Object.values(state.users).find((x) => x.username === username);
      return publicUser(u);
    },

    async create({ username, password, role = 'user' }) {
      const trimmed = String(username || '').trim();
      if (!trimmed) throw Object.assign(new Error('username required'), { code: 'INVALID' });
      if (!password) throw Object.assign(new Error('password required'), { code: 'INVALID' });
      const dupe = Object.values(state.users).some((x) => x.username === trimmed);
      if (dupe) throw Object.assign(new Error('username already exists'), { code: 'DUPLICATE' });

      const id = `usr_${nanoid(12)}`;
      const now = new Date().toISOString();
      state.users[id] = {
        id,
        username: trimmed,
        passwordHash: await hashPassword(password),
        role: role === 'admin' ? 'admin' : 'user',
        createdAt: now,
        updatedAt: now,
      };
      await persist();
      return publicUser(state.users[id]);
    },

    async setPassword(id, password) {
      const u = state.users[id];
      if (!u) throw Object.assign(new Error('user not found'), { code: 'NOT_FOUND' });
      if (!password) throw Object.assign(new Error('password required'), { code: 'INVALID' });
      u.passwordHash = await hashPassword(password);
      u.updatedAt = new Date().toISOString();
      await persist();
      return publicUser(u);
    },

    async setRole(id, role) {
      const u = state.users[id];
      if (!u) throw Object.assign(new Error('user not found'), { code: 'NOT_FOUND' });
      u.role = role === 'admin' ? 'admin' : 'user';
      u.updatedAt = new Date().toISOString();
      await persist();
      return publicUser(u);
    },

    async remove(id) {
      if (!state.users[id]) throw Object.assign(new Error('user not found'), { code: 'NOT_FOUND' });
      delete state.users[id];
      await persist();
    },

    /**
     * Verify username/password. Returns the public user record on success, null on failure.
     * Always runs scrypt against a dummy hash on miss to keep timing constant.
     */
    async verify(username, password) {
      const u = Object.values(state.users).find((x) => x.username === username);
      if (!u) {
        // Constant-time miss: hash against a throwaway salt so attackers can't enumerate usernames by timing
        await scryptAsync(String(password ?? ''), randomBytes(16), KEY_LEN).catch(() => {});
        return null;
      }
      const ok = await verifyPassword(password, u.passwordHash);
      return ok ? publicUser(u) : null;
    },
  };
}
