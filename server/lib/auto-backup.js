import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Auto-backup: copies listed files every hour, keeps last 24 backups per file.
 *
 * @param {string[]} filePaths - Absolute paths to JSON files to back up
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createAutoBackup(filePaths) {
  let timer = null;
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const MAX_BACKUPS = 24;

  async function backupOne(filePath) {
    if (!fssync.existsSync(filePath)) return;
    const dir = path.join(path.dirname(filePath), 'backups');
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const base = path.basename(filePath);
    const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
    const backupName = `${base}.backup-${ts}`;
    const backupPath = path.join(dir, backupName);
    try {
      await fs.copyFile(filePath, backupPath);
    } catch (err) {
      logger.warn({ err, filePath }, 'auto-backup: copy failed');
      return;
    }
    // Clean up old backups — keep only MAX_BACKUPS most recent
    try {
      const entries = await fs.readdir(dir);
      const prefix = `${base}.backup-`;
      const backups = entries
        .filter((e) => e.startsWith(prefix))
        .sort()
        .reverse();
      if (backups.length > MAX_BACKUPS) {
        const toDelete = backups.slice(MAX_BACKUPS);
        for (const old of toDelete) {
          await fs.unlink(path.join(dir, old)).catch(() => {});
        }
      }
    } catch (err) {
      logger.warn({ err, filePath }, 'auto-backup: cleanup failed');
    }
  }

  async function runAll() {
    for (const fp of filePaths) {
      await backupOne(fp);
    }
    logger.info({ files: filePaths.length }, 'auto-backup: cycle completed');
  }

  return {
    start() {
      // Run first backup shortly after startup (10 seconds)
      setTimeout(() => {
        runAll().catch((err) => logger.error({ err }, 'auto-backup: initial run failed'));
      }, 10_000);
      timer = setInterval(() => {
        runAll().catch((err) => logger.error({ err }, 'auto-backup: cycle failed'));
      }, INTERVAL_MS);
      if (timer.unref) timer.unref();
      logger.info({ count: filePaths.length, intervalMs: INTERVAL_MS }, 'auto-backup: started');
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info('auto-backup: stopped');
      }
    }
  };
}
