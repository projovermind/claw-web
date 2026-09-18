import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquire, release, list, pruneExpired, fmtAge, TTL_MS } from '../server/lib/file-leases.js';

const ROOT = '/fake/tree';
let dir;

/** 원장 파일 경로 — 구현과 같은 규칙(워킹디렉토리 sha1 앞 16자). */
function ledgerFile(root = ROOT) {
  const key = crypto.createHash('sha1').update(String(root)).digest('hex').slice(0, 16);
  return path.join(dir, `${key}.json`);
}

function writeLedger(leases, root = ROOT) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ledgerFile(root), JSON.stringify({ leases }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-leases-'));
  process.env.CLAW_WEB_LEASE_DIR = dir;
});

afterEach(() => {
  delete process.env.CLAW_WEB_LEASE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('file-leases', () => {
  it('grants a free file and records the owner session', () => {
    expect(acquire({ root: ROOT, rel: 'a.js', sessionId: 's1', agentId: 'cw_server' })).toBeNull();

    const leases = list(ROOT);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ root: ROOT, rel: 'a.js', sessionId: 's1', agentId: 'cw_server' });
    expect(leases[0].expiresAt - leases[0].touchedAt).toBe(TTL_MS);
  });

  it('blocks a second session and hands back the holder', () => {
    acquire({ root: ROOT, rel: 'a.js', sessionId: 's1', label: '세션A' });
    const other = acquire({ root: ROOT, rel: 'a.js', sessionId: 's2' });

    expect(other).toMatchObject({ sessionId: 's1', label: '세션A', rel: 'a.js' });
    // 충돌한 쪽의 임대는 생기지 않는다.
    expect(list(ROOT)).toHaveLength(1);
  });

  it('renews rather than duplicates when the same session edits again', () => {
    acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' });
    const first = list(ROOT)[0];
    writeLedger([{ ...first, touchedAt: first.touchedAt - 60_000, expiresAt: first.expiresAt - 60_000 }]);

    expect(acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' })).toBeNull();
    const after = list(ROOT);
    expect(after).toHaveLength(1);
    expect(after[0].touchedAt).toBeGreaterThan(first.touchedAt - 60_000);
    expect(after[0].since).toBe(first.since);
  });

  it('lets a different file through — 임대는 파일 단위라 병렬성을 죽이지 않는다', () => {
    acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' });
    expect(acquire({ root: ROOT, rel: 'b.js', sessionId: 's2' })).toBeNull();
    expect(list(ROOT)).toHaveLength(2);
  });

  it('keeps separate working trees separate', () => {
    acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' });
    expect(acquire({ root: '/other/tree', rel: 'a.js', sessionId: 's2' })).toBeNull();
    expect(list(ROOT)).toHaveLength(1);
    expect(list('/other/tree')).toHaveLength(1);
  });

  it('treats an expired lease as gone', () => {
    const past = Date.now() - 1000;
    writeLedger([{ root: ROOT, rel: 'a.js', sessionId: 's1', since: past, touchedAt: past, expiresAt: past }]);

    expect(list(ROOT)).toHaveLength(0);
    expect(acquire({ root: ROOT, rel: 'a.js', sessionId: 's2' })).toBeNull();
    expect(list(ROOT)[0].sessionId).toBe('s2');
  });

  it('releases by session, or one file at a time', () => {
    acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' });
    acquire({ root: ROOT, rel: 'b.js', sessionId: 's1' });
    acquire({ root: ROOT, rel: 'c.js', sessionId: 's2' });

    expect(release({ root: ROOT, sessionId: 's1', rel: 'a.js' })).toBe(1);
    expect(list(ROOT).map((l) => l.rel).sort()).toEqual(['b.js', 'c.js']);

    expect(release({ root: ROOT, sessionId: 's1' })).toBe(1);
    expect(list(ROOT).map((l) => l.rel)).toEqual(['c.js']);

    // 남의 임대는 못 푼다.
    expect(release({ root: ROOT, sessionId: 's1' })).toBe(0);
  });

  it('prunes only expired records', () => {
    const past = Date.now() - 1000;
    acquire({ root: ROOT, rel: 'live.js', sessionId: 's1' });
    const live = list(ROOT)[0];
    writeLedger([live, { root: ROOT, rel: 'dead.js', sessionId: 's9', since: past, touchedAt: past, expiresAt: past }]);

    expect(pruneExpired(ROOT)).toBe(1);
    expect(list(ROOT).map((l) => l.rel)).toEqual(['live.js']);
  });

  it('survives a corrupt ledger instead of taking the session down', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ledgerFile(), '{ not json');
    expect(list(ROOT)).toEqual([]);
    expect(acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' })).toBeNull();
  });

  it('ignores calls missing an owner or a target', () => {
    expect(acquire({ root: ROOT, rel: 'a.js' })).toBeNull();
    expect(acquire({ root: ROOT, sessionId: 's1' })).toBeNull();
    expect(list(ROOT)).toHaveLength(0);
    expect(release({ root: ROOT })).toBe(0);
  });

  describe('mkdir 잠금 — PID 소유자 확인', () => {
    const lockDir = () => ledgerFile() + '.lock';

    function plantLock(owner) {
      fs.mkdirSync(lockDir(), { recursive: true });
      if (owner) fs.writeFileSync(path.join(lockDir(), 'owner.json'), JSON.stringify(owner));
    }

    it('reclaims a lock whose owner process is gone', () => {
      // PID 1 은 살아 있으므로 절대 쓰지 않는다. 존재할 수 없는 큰 PID 를 쓴다.
      plantLock({ pid: 4_194_303, host: os.hostname(), at: Date.now() });

      const started = Date.now();
      expect(acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' })).toBeNull();
      // 죽은 소유자는 기다리지 않고 즉시 회수한다.
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(list(ROOT)).toHaveLength(1);
    });

    it('reclaims a lock left behind with no owner file', () => {
      plantLock(null);
      // OWNER_GRACE_MS(1초)를 넘긴 것처럼 보이게 mtime 을 과거로 민다.
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(lockDir(), old, old);

      expect(acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' })).toBeNull();
      expect(list(ROOT)).toHaveLength(1);
    });

    it('reclaims a lock that a live owner has held far too long', () => {
      // 소유자는 살아 있지만(내 PID) 30초 넘게 쥐고 있다 = 새는 잠금.
      plantLock({ pid: process.pid, host: os.hostname(), at: Date.now() - 60_000 });

      const started = Date.now();
      expect(acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' })).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('waits for a live owner instead of stealing the lock out from under it', () => {
      // Sonamoo 원본은 2초 뒤 무조건 뺏었다 — 소유자가 원장을 쓰는 중이면 두
      // 프로세스가 동시에 write 해서 한쪽 내용이 사라진다. 살아 있는 소유자는 기다린다.
      plantLock({ pid: process.pid, host: os.hostname(), at: Date.now() });
      const timer = setTimeout(() => fs.rmSync(lockDir(), { recursive: true, force: true }), 300);

      const started = Date.now();
      expect(acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' })).toBeNull();
      const waited = Date.now() - started;
      clearTimeout(timer);

      expect(waited).toBeGreaterThanOrEqual(250);
      expect(list(ROOT)).toHaveLength(1);
    });

    it('always drops its own lock, even when the body throws', () => {
      // writeAll 이 실패하도록 원장 디렉터리를 파일로 막아 버린다.
      expect(() => acquire({ root: ROOT, rel: 'a.js', sessionId: 's1' })).not.toThrow();
      expect(fs.existsSync(lockDir())).toBe(false);
    });
  });

  it('formats ages the way the guard prints them', () => {
    expect(fmtAge(20_000)).toBe('방금');
    expect(fmtAge(12 * 60_000)).toBe('12분');
    expect(fmtAge(125 * 60_000)).toBe('2시간 5분');
  });
});
