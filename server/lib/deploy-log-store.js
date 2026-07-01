/**
 * Deploy Log Store — cross-session deploy ledger.
 *
 * Multiple Claude sessions of the same project run in the SAME git working tree
 * but have independent conversation contexts, so they can't see each other's
 * deploys. That blind spot causes one session's `vercel --prod` / git redeploy
 * to silently roll back another session's live work.
 *
 * This ledger is a shared, append-only record keyed by working directory. Every
 * session reads it (via the deploy-guard injection) and writes to it after a
 * deploy, so all sessions converge on "who deployed what, when".
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(REPO_ROOT, 'data', 'user', 'deploy-logs');

const MAX_ENTRIES = 50;      // keep the ledger bounded
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000; // entries older than this are pruned on read

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

// Filename keyed by a hash of the absolute working dir — all sessions sharing
// the same git tree share one ledger, regardless of project/agent id.
function fileFor(workingDir) {
  const key = crypto.createHash('sha1').update(String(workingDir)).digest('hex').slice(0, 16);
  return path.join(LOG_DIR, `${key}.json`);
}

/**
 * Read ledger entries for a working dir, newest first. Sync (used by injector).
 * @param {string} workingDir
 * @returns {Array<{ts:string, session:string|null, target:string|null, commit:string|null, note:string|null}>}
 */
export function readDeployLog(workingDir) {
  if (!workingDir) return [];
  const file = fileFor(workingDir);
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries.slice().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  } catch (err) {
    logger.warn({ workingDir, err: err.message }, 'deploy-log: read failed');
    return [];
  }
}

/**
 * Append a deploy record. Locked + atomic so concurrent sessions don't clobber.
 * @param {string} workingDir
 * @param {{target?:string, note?:string, commit?:string, session?:string}} entry
 * @returns {Promise<object>} the stored entry
 */
export async function appendDeployLog(workingDir, entry = {}) {
  if (!workingDir) throw new Error('appendDeployLog: workingDir required');
  ensureDir();
  const file = fileFor(workingDir);
  if (!fs.existsSync(file)) {
    await fsp.writeFile(file, JSON.stringify({ version: 1, dir: workingDir, entries: [] }, null, 2));
  }

  const record = {
    ts: new Date().toISOString(),
    session: entry.session ? String(entry.session).slice(0, 64) : null,
    target: entry.target ? String(entry.target).slice(0, 200) : null,
    commit: entry.commit ? String(entry.commit).slice(0, 80) : null,
    note: entry.note ? String(entry.note).slice(0, 300) : null,
  };

  const release = await lockfile.lock(file, { retries: { retries: 10, minTimeout: 100 } });
  try {
    let current = { version: 1, dir: workingDir, entries: [] };
    try {
      current = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!Array.isArray(current.entries)) current.entries = [];
    } catch { /* start fresh on corruption */ }

    current.entries.push(record);
    if (current.entries.length > MAX_ENTRIES) {
      current.entries = current.entries.slice(-MAX_ENTRIES);
    }

    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(current, null, 2));
    await fsp.rename(tmp, file);
  } finally {
    await release();
  }
  return record;
}

/** Ledger entries within the recent window, newest first. */
export function recentDeployLog(workingDir) {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  return readDeployLog(workingDir).filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isNaN(t) || t >= cutoff;
  });
}
