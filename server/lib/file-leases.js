/**
 * File Leases — 세션 단위 파일 임대 원장.
 *
 * claw-web 은 워크트리를 나누지 않는다. 한 프로젝트의 모든 세션이 같은 워킹트리를
 * 그대로 공유하므로, 두 세션이 같은 파일을 동시에 고치면 rebase 충돌이 아니라
 * **마지막 쓰기가 이긴다** — 앞 세션의 편집이 조용히 사라진다. deploy-guard 는
 * "누가 뭘 만졌는지" 를 사후에 보여줄 뿐 동시 편집 자체를 막지 못한다.
 *
 * 왜 큐가 아니라 임대인가: 큐는 모든 작업을 한 줄로 세워 병렬성을 죽인다. 실제
 * 충돌은 '같은 파일을 두 세션이 동시에 고치는 것' 하나뿐이라, 파일 단위로만
 * 배타하면 나머지는 전부 병렬로 굴러도 안전하다. (Sonamoo scripts/coord/leases.cjs
 * 와 같은 설계. 다만 그쪽은 워크트리 단위 — 여기서는 워크트리가 하나뿐이라
 * 소유자 키가 세션이다.)
 *
 * 저장 위치는 deploy-log-store 와 같은 규칙 — 워킹디렉토리 해시로 파일을 가른다.
 * 같은 트리를 공유하는 세션끼리만 한 원장을 본다.
 *
 * 레코드: { root, rel, sessionId, agentId, label, since, touchedAt, expiresAt }
 * TTL 은 마지막 편집으로부터 90분 — 세션이 죽어도 임대가 영원히 남지 않게 하는
 * 안전장치다. 정상 종료는 release() 가 즉시 해제한다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 마지막 편집으로부터 이만큼 지나면 임대가 저절로 풀린다. */
export const TTL_MS = 90 * 60 * 1000;

/** 잠금을 못 잡고 이만큼 버티면 소유자가 살아 있어도 회수한다 (데드락 방지). */
const LOCK_WAIT_MS = 3_000;
/** 소유자 PID 가 살아 있어도 이보다 오래된 잠금은 새는 것으로 본다. */
const LOCK_STALE_MS = 30_000;
/** mkdir 직후 owner.json 을 쓰기 전의 찰나 — 이 안의 '주인 없는' 잠금은 뺏지 않는다. */
const OWNER_GRACE_MS = 1_000;

function leaseDir() {
  return process.env.CLAW_WEB_LEASE_DIR || path.join(REPO_ROOT, 'data', 'user', 'file-leases');
}

/** 같은 워킹트리를 쓰는 세션끼리 한 원장 — 프로젝트/에이전트 id 와 무관하다. */
function fileFor(root) {
  const key = crypto.createHash('sha1').update(String(root)).digest('hex').slice(0, 16);
  return path.join(leaseDir(), `${key}.json`);
}

function ensureDir() {
  fs.mkdirSync(leaseDir(), { recursive: true });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 잠금 소유자가 아직 살아 있는가.
 *
 * Sonamoo 원본은 2초를 못 기다리면 무조건 잠금을 뺏었다. 그 사이 소유자가 원장을
 * 쓰는 중이면 두 프로세스가 동시에 write 하고, 늦게 끝난 쪽 내용이 앞 것을 덮는다
 * — 임대 원장이 바로 그걸 막으려는 물건인데 원장 자신이 같은 사고를 낸다.
 * 그래서 PID 로 소유자 생사를 먼저 확인하고, 죽었을 때만 즉시 회수한다.
 *
 * EPERM 은 '살아 있는데 내가 시그널을 못 보내는 것'이므로 살아 있는 쪽으로 친다.
 * 다른 호스트의 PID 는 판정할 수 없으니 살아 있다고 보고 나이로만 회수한다.
 */
function ownerAlive(owner) {
  if (!owner || typeof owner.pid !== 'number') return false;
  if (owner.host && owner.host !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function withLock(root, fn) {
  ensureDir();
  const lock = fileFor(root) + '.lock';
  const ownerFile = path.join(lock, 'owner.json');
  const started = Date.now();

  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lock);
      try {
        fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
      } catch { /* 소유자 표시 실패는 치명적이지 않다 — 나이 기준으로 회수된다 */ }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (attempt > 500) throw new Error(`file-leases: 잠금을 잡지 못했습니다 (${lock})`);

      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { /* 없거나 깨짐 */ }

      if (!owner) {
        // 주인 표시가 없다 — 방금 mkdir 한 프로세스가 쓰는 중일 수 있다.
        let lockAge = Infinity;
        try { lockAge = Date.now() - fs.statSync(lock).mtimeMs; } catch { /* 이미 풀림 */ }
        if (lockAge < OWNER_GRACE_MS) { sleepSync(25); continue; }
      }

      const age = Date.now() - (owner?.at ?? 0);
      const dead = !ownerAlive(owner);
      const stale = age > LOCK_STALE_MS;
      const waited = Date.now() - started > LOCK_WAIT_MS;

      if (dead || stale || waited) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* 경합 — 다음 루프 */ }
        continue;
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* 이미 뺏김 */ }
  }
}

function readAll(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(root), 'utf8'));
    return Array.isArray(parsed.leases) ? parsed.leases : [];
  } catch {
    return [];
  }
}

function writeAll(root, leases) {
  ensureDir();
  const file = fileFor(root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ leases }, null, 1));
  fs.renameSync(tmp, file);
}

function live(leases, now = Date.now()) {
  return leases.filter((l) => l && l.expiresAt > now);
}

/** 살아 있는 임대 전부(만료분 제외). 읽기 전용 — 잠금을 잡지 않는다. */
export function list(root) {
  return live(readAll(root));
}

/**
 * 임대 시도.
 *
 * @returns {object|null} 다른 세션이 쥐고 있으면 그 레코드(=충돌), 아니면 null
 *   (내 임대를 새로 만들었거나 갱신했다).
 */
export function acquire({ root, rel, sessionId, agentId, label }) {
  if (!root || !rel || !sessionId) return null;
  return withLock(root, () => {
    const now = Date.now();
    const leases = live(readAll(root), now);
    const other = leases.find((l) => l.rel === rel && l.sessionId !== sessionId);
    if (other) return other;

    const mine = leases.find((l) => l.rel === rel && l.sessionId === sessionId);
    if (mine) {
      mine.touchedAt = now;
      mine.expiresAt = now + TTL_MS;
      if (agentId) mine.agentId = agentId;
      if (label) mine.label = label;
    } else {
      leases.push({
        root,
        rel,
        sessionId,
        agentId: agentId ?? null,
        label: label ?? null,
        since: now,
        touchedAt: now,
        expiresAt: now + TTL_MS
      });
    }
    writeAll(root, leases);
    return null;
  });
}

/**
 * 해제. sessionId 만 주면 그 세션의 임대 전부, rel 을 같이 주면 그 파일 하나만.
 * @returns {number} 지운 개수
 */
export function release({ root, sessionId, rel }) {
  if (!root || !sessionId) return 0;
  return withLock(root, () => {
    const before = live(readAll(root));
    const after = before.filter((l) => !(l.sessionId === sessionId && (!rel || l.rel === rel)));
    if (after.length !== before.length) writeAll(root, after);
    return before.length - after.length;
  });
}

/** 만료분만 걷어낸다. @returns {number} 지운 개수 */
export function pruneExpired(root) {
  return withLock(root, () => {
    const all = readAll(root);
    const kept = live(all);
    if (kept.length !== all.length) writeAll(root, kept);
    return all.length - kept.length;
  });
}

/** "12분" / "2시간 5분" — 사람이 읽을 경과 시간. */
export function fmtAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return '방금';
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
