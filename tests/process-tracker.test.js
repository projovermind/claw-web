import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createProcessTracker } from '../server/lib/process-tracker.js';

describe('process-tracker', () => {
  let tmpDir, filePath, strays;

  beforeEach(() => {
    strays = [];
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tmpDir = path.join(os.tmpdir(), `tracker-${id}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    filePath = path.join(tmpDir, 'running.json');
  });

  afterEach(async () => {
    for (const pid of strays) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('tracks and releases a pid', async () => {
    const t = createProcessTracker({ filePath });
    await t.track('sess1', 12345);
    expect(t._getState().sessions.sess1.pid).toBe(12345);
    await t.release('sess1');
    expect(t._getState().sessions.sess1).toBeUndefined();
  });

  it('persists state across tracker instances', async () => {
    const t1 = createProcessTracker({ filePath });
    await t1.track('sess1', 12345);
    // New instance reads the file
    const t2 = createProcessTracker({ filePath });
    expect(t2._getState().sessions.sess1.pid).toBe(12345);
  });

  it('reapOrphans clears dead pids silently', async () => {
    const t1 = createProcessTracker({ filePath });
    // A pid that's almost certainly not running (chosen to be non-existent)
    await t1.track('sess1', 1);
    await t1.track('sess2', 999999);
    // Reap should not throw; dead pids are simply cleared
    const t2 = createProcessTracker({ filePath });
    const { killed, preserved } = await t2.reapOrphans();
    // Neither PID should have been killable (the one we track as dead above is not ours)
    // But the state should be cleared regardless.
    expect(t2._getState().sessions).toEqual({});
    // killed can be 0 or more depending on what OS thinks of those pids, but the
    // important invariant is that state is cleared.
    expect(typeof killed).toBe('number');
    expect(preserved).toBe(0);
  });

  it('reapOrphans SIGTERMs a live orphan (integration)', async () => {
    // Spawn a tiny sleep process that survives briefly, track it, then reap it.
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid;
    expect(pid).toBeDefined();

    const t1 = createProcessTracker({ filePath });
    await t1.track('orphan-sess', pid);

    // Verify it's alive
    expect(() => process.kill(pid, 0)).not.toThrow();

    // New tracker instance reads the file and reaps
    const t2 = createProcessTracker({ filePath });
    const { killed } = await t2.reapOrphans();
    expect(killed).toBeGreaterThanOrEqual(1);

    // Give it a moment to die
    await new Promise((r) => setTimeout(r, 100));

    // State should be cleared
    expect(t2._getState().sessions).toEqual({});
  });

  it('records serverPid on track', async () => {
    const t = createProcessTracker({ filePath });
    await t.track('sess1', 12345);
    expect(t._getState().sessions.sess1.serverPid).toBe(process.pid);
  });

  it('타 인스턴스 소유 pid 는 보존 (다른 serverPid 가 살아있으면 kill 하지 않음)', async () => {
    // 워커 역할 프로세스 + 그 워커를 소유한 '다른 claw-web 인스턴스' 역할 프로세스
    const worker = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const otherServer = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    worker.unref();
    otherServer.unref();
    strays.push(worker.pid, otherServer.pid);

    // 다른 인스턴스가 기록한 것처럼 파일을 직접 작성
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sessions: {
          'other-instance-sess': {
            pid: worker.pid,
            serverPid: otherServer.pid,
            startedAt: new Date().toISOString()
          }
        }
      })
    );

    const t = createProcessTracker({ filePath });
    const { killed, skipped } = await t.reapOrphans();

    expect(killed).toBe(0);
    expect(skipped).toBe(1);
    // 워커는 여전히 살아 있어야 한다
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(worker.pid, 0)).not.toThrow();
    // 엔트리도 남의 것이므로 파일에서 지우지 않는다
    expect(t._getState().sessions['other-instance-sess'].pid).toBe(worker.pid);
  });

  it('소유 인스턴스가 죽었으면 고아로 보고 kill 한다', async () => {
    const worker = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    worker.unref();
    strays.push(worker.pid);

    // serverPid 는 존재하지 않는 pid (죽은 이전 인스턴스)
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sessions: {
          'dead-instance-sess': {
            pid: worker.pid,
            serverPid: 999999,
            startedAt: new Date().toISOString()
          }
        }
      })
    );

    const t = createProcessTracker({ filePath });
    const { killed } = await t.reapOrphans();
    expect(killed).toBe(1);
    expect(t._getState().sessions).toEqual({});
  });

  it('pid 재사용 의심(startedAt 보다 늦게 시작한 프로세스) 은 kill 하지 않음', async () => {
    const worker = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    worker.unref();
    strays.push(worker.pid);

    // 이 프로세스는 방금 떴는데 startedAt 은 1시간 전 → 같은 pid 를 물려받은 남의 프로세스
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        sessions: {
          'recycled-sess': {
            pid: worker.pid,
            serverPid: process.pid,
            startedAt: new Date(Date.now() - 3600_000).toISOString()
          }
        }
      })
    );

    const t = createProcessTracker({ filePath });
    const { killed, skipped } = await t.reapOrphans();
    expect(killed).toBe(0);
    expect(skipped).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(worker.pid, 0)).not.toThrow();
  });

  it('track is idempotent on same sessionId (overwrites)', async () => {
    const t = createProcessTracker({ filePath });
    await t.track('sess1', 100);
    await t.track('sess1', 200);
    expect(t._getState().sessions.sess1.pid).toBe(200);
  });
});
