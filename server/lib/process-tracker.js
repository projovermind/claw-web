import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Tracks spawned Claude CLI child process PIDs to a JSON file on disk.
 *
 * Why: if the web server crashes ungracefully (kill -9, power loss, segfault),
 * spawned Claude CLI children become orphans — reparented to PID 1 and keep
 * running in the background. On the next boot, we have no in-memory handle
 * to them. This tracker lets us detect surviving orphans and kill them so
 * the user doesn't end up with duplicate agents on retry.
 *
 * Shape of the on-disk file:
 *   { "sessions": { "<sessionId>": { "pid": 12345, "startedAt": "2026-04-15T..." } } }
 *
 * On graceful shutdown the file is cleaned up via release(). On crash it's
 * read on next boot and every live PID is SIGTERM'd.
 */
export function createProcessTracker({ filePath }) {
  // Ensure parent dir exists
  const dir = path.dirname(filePath);
  if (!fssync.existsSync(dir)) {
    fssync.mkdirSync(dir, { recursive: true });
  }

  let state = { sessions: {} };
  if (fssync.existsSync(filePath)) {
    try {
      state = JSON.parse(fssync.readFileSync(filePath, 'utf8'));
      if (!state.sessions) state.sessions = {};
    } catch {
      state = { sessions: {} };
    }
  }

  // Serialize writes so simultaneous track/release calls don't trample each other.
  let writeChain = Promise.resolve();

  function flush() {
    writeChain = writeChain.then(async () => {
      try {
        const tmp = filePath + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(state, null, 2));
        await fs.rename(tmp, filePath);
      } catch (err) {
        logger.warn({ err }, 'process-tracker: flush failed');
      }
    });
    return writeChain;
  }

  return {
    /**
     * Register a spawned child. Best-effort — returns the flush promise but
     * callers don't need to await it (write happens in parallel with chat start).
     */
    track(sessionId, pid) {
      state.sessions[sessionId] = { pid, startedAt: new Date().toISOString() };
      return flush();
    },

    /** Remove after natural exit or graceful abort. */
    release(sessionId) {
      if (state.sessions[sessionId]) {
        delete state.sessions[sessionId];
        return flush();
      }
      return Promise.resolve();
    },

    /**
     * On boot: for every tracked PID still alive, send SIGTERM then clear
     * the file. Returns the count of orphans killed.
     *
     * @param {Object} [opts]
     * @param {Set<string>|Array<string>} [opts.preserveSessionIds] - 이어가기 예정 세션 ID 들은 kill 하지 않음.
     *   soft-restart 로 autoResume=true 상태라면 pending-resume.json 의 ID들을 넘겨 중복 spawn 을 방지.
     */
    async reapOrphans(opts = {}) {
      const preserve = opts.preserveSessionIds instanceof Set
        ? opts.preserveSessionIds
        : new Set(Array.isArray(opts.preserveSessionIds) ? opts.preserveSessionIds : []);
      const entries = Object.entries(state.sessions);
      let killed = 0;
      let preserved = 0;
      for (const [sessionId, info] of entries) {
        if (!info?.pid) continue;
        try {
          // Signal 0 = liveness probe
          process.kill(info.pid, 0);
          // Alive
          if (preserve.has(sessionId)) {
            preserved += 1;
            logger.info(
              { sessionId, pid: info.pid, startedAt: info.startedAt },
              'process-tracker: preserving live Claude CLI (pending resume will reuse)'
            );
            continue;
          }
          try {
            process.kill(info.pid, 'SIGTERM');
            killed += 1;
            logger.warn(
              { sessionId, pid: info.pid, startedAt: info.startedAt },
              'process-tracker: killed orphaned Claude CLI process from previous run'
            );
          } catch (err) {
            logger.warn(
              { err, sessionId, pid: info.pid },
              'process-tracker: failed to SIGTERM orphan'
            );
          }
        } catch {
          // Not alive — already gone, nothing to do
        }
      }
      // preserve 된 엔트리만 살리고 나머지는 제거
      const next = { sessions: {} };
      for (const [sid, info] of Object.entries(state.sessions)) {
        if (preserve.has(sid)) next.sessions[sid] = info;
      }
      state = next;
      await flush();
      return { killed, preserved };
    },

    /** For tests + observability */
    _getState: () => state
  };
}
