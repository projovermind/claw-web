import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Auto-cleanup: deletes top-level files in `dir` whose mtime exceeds maxAgeDays.
 * Runs every `intervalMs` (default 6h) plus once shortly after startup.
 *
 * Use case: chat-attachment uploads where files older than N days are no longer
 * referenced by active sessions and just consume disk.
 *
 * @param {object} opts
 * @param {string} opts.dir            Absolute path to scan
 * @param {number} opts.maxAgeDays     Files older than this are deleted
 * @param {number} [opts.intervalMs]   Cleanup cycle interval (default 6h)
 * @param {string} [opts.label]        Logger label (default basename of dir)
 * @returns {{ start: () => void, stop: () => void, runOnce: () => Promise<{deleted:number,kept:number}> }}
 */
export function createAutoCleanup({ dir, maxAgeDays, intervalMs = 6 * 60 * 60 * 1000, label }) {
  const tag = label || path.basename(dir);
  let timer = null;

  async function runOnce() {
    if (!fssync.existsSync(dir)) return { deleted: 0, kept: 0 };
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    let kept = 0;
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      logger.warn({ err: err.message, dir }, `auto-cleanup[${tag}]: readdir failed`);
      return { deleted: 0, kept: 0 };
    }
    for (const name of entries) {
      const p = path.join(dir, name);
      try {
        const s = await fs.stat(p);
        if (!s.isFile()) { kept++; continue; }
        if (s.mtimeMs < cutoff) {
          await fs.unlink(p);
          deleted++;
        } else {
          kept++;
        }
      } catch (err) {
        logger.warn({ err: err.message, file: p }, `auto-cleanup[${tag}]: entry failed`);
      }
    }
    if (deleted > 0) {
      logger.info({ deleted, kept, dir, maxAgeDays }, `auto-cleanup[${tag}]: removed expired files`);
    }
    return { deleted, kept };
  }

  return {
    start() {
      // Initial run 30s after startup so boot isn't slowed
      setTimeout(() => {
        runOnce().catch((err) => logger.error({ err }, `auto-cleanup[${tag}]: initial run failed`));
      }, 30_000);
      timer = setInterval(() => {
        runOnce().catch((err) => logger.error({ err }, `auto-cleanup[${tag}]: cycle failed`));
      }, intervalMs);
      if (timer.unref) timer.unref();
      logger.info({ dir, maxAgeDays, intervalMs }, `auto-cleanup[${tag}]: started`);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info(`auto-cleanup[${tag}]: stopped`);
      }
    },
    runOnce
  };
}
