import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../lib/logger.js';

const exec = promisify(execFile);

/**
 * 에이전트 동시 슬롯별 git worktree 격리.
 *
 * maxConcurrent 를 1 초과로 올리면 같은 에이전트의 워커 둘이 같은 workingDir 을
 * 동시에 편집한다 — 한쪽 Edit 가 다른 쪽 변경을 덮어쓰고, 어느 쪽 diff 가 남았는지
 * 아무도 모른다. 그래서 지금까지 읽기 전용 에이전트만 상향할 수 있었다.
 *
 * 여기서는 슬롯마다 detached worktree 를 하나씩 붙인다:
 *   slot 0 → 원본 workingDir (worktreeIncludePrimary=false 면 slot 0 도 worktree)
 *   slot N → <worktreeRoot>/<agentId>-slotN  (git worktree add --detach)
 *
 * 리스는 **세션에 붙는다**(슬롯이 아니라). 워커 세션은 재사용되며 다음 턴은
 * --resume 으로 붙는데, CLI 세션 파일 경로가 cwd 문자열로 인코딩되기 때문에
 * 같은 세션에 다른 경로를 주면 resume 대상을 못 찾아 콜드스타트가 된다.
 *
 * 빈 슬롯이 없으면 **유휴 홀더**(러너도 없고 진행 중 위임도 없는 세션)에서 회수한다.
 * 회수 대상은 worker-pool 에서도 빼 다시 resume 되지 않게 한다 — cwd 가 사라진
 * 세션을 resume 하면 조용히 fresh 세션으로 떨어진다.
 *
 * 회수·해제 때 worktree 가 더럽다면 그냥 지우지 않고 패치로 먼저 뽑아 둔다
 * (<worktreeRoot>/_patches/). 워커가 커밋하지 않은 산출물이 통째로 사라지는 것을
 * 막는 최소한의 안전장치다.
 */

/** worktree 에 링크해 줄 gitignore 된 디렉토리 — 없으면 워커가 빌드/테스트를 못 돈다. */
const DEFAULT_LINKS = ['node_modules'];

/** 슬롯 이름에 쓸 수 없는 문자 정리 (agentId 는 보통 snake_case). */
function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function createWorktreePool(ctx) {
  /** 절대경로 → { agentId, sessionId, slot, path, root, baseSha, leasedAt } */
  const leases = new Map();
  /** sessionId → 절대경로 */
  const bySession = new Map();
  /** repoRoot 가 아니라고 판정된 workingDir — 매 위임마다 git 을 때리지 않는다. */
  const notARepo = new Set();

  function settings() {
    const chat = ctx.webConfig?.chat ?? {};
    return {
      enabled: chat.worktreeIsolation === true,
      root: chat.worktreeRoot || path.join(os.homedir(), '.claw-web', 'worktrees'),
      links: Array.isArray(chat.worktreeLinks) ? chat.worktreeLinks : DEFAULT_LINKS,
      includePrimary: chat.worktreeIncludePrimary !== false
    };
  }

  /** stdout 을 다듬어 돌려주는 git 실행. 실패는 throw. */
  async function git(cwd, args) {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  }

  /** 패치용 — trim 하면 `git apply` 가 "corrupt patch" 로 거부한다. */
  async function gitRaw(cwd, args) {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  async function repoRootOf(dir) {
    if (notARepo.has(dir)) return null;
    try {
      return await git(dir, ['rev-parse', '--show-toplevel']);
    } catch (err) {
      notARepo.add(dir);
      logger.info({ dir, err: err.message }, 'worktree: not a git repo — slot isolation unavailable');
      return null;
    }
  }

  function slotPath(cfg, agentId, slot) {
    return path.join(cfg.root, `${safeName(agentId)}-slot${slot}`);
  }

  /** 지금 이 세션이 살아 움직이는 중인가 — 회수해도 되는지의 판단 기준. */
  function isHolderActive(sessionId) {
    if (!sessionId) return false;
    if (ctx.isSessionBusy?.(sessionId)) return true;
    return !!ctx.delegationTracker?.getByTarget?.(sessionId);
  }

  /**
   * 커밋되지 않은(또는 detached HEAD 에 커밋된) 변경을 패치 파일로 보존한다.
   * @returns {Promise<string|null>} 패치 경로. 변경이 없으면 null.
   */
  async function exportPatch(lease, cfg) {
    try {
      // primary 에서 끌어온 symlink(node_modules 등)는 패치 대상이 아니다.
      // .gitignore 의 `node_modules/` 는 디렉토리 패턴이라 symlink 를 걸러내지 못한다.
      const excludes = cfg.links.map((rel) => `:(exclude)${rel}`);
      // add -A 로 untracked 까지 인덱스에 올려야 diff 에 잡힌다. 곧 지울 트리이므로
      // 인덱스를 건드려도 잃는 것이 없다.
      await git(lease.path, ['add', '-A', '--', '.', ...excludes]);
      const base = lease.baseSha || 'HEAD';
      const diff = await gitRaw(lease.path, ['diff', '--binary', '--cached', base, '--', '.', ...excludes]);
      if (!diff.trim()) return null;
      const dir = path.join(cfg.root, '_patches');
      await fsp.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${safeName(lease.sessionId || 'unknown')}-${stamp}.patch`);
      await fsp.writeFile(file, diff.endsWith('\n') ? diff : `${diff}\n`);
      logger.warn(
        { sessionId: lease.sessionId, agentId: lease.agentId, patch: file, bytes: diff.length },
        'worktree: uncommitted worker changes saved as patch before cleanup'
      );
      return file;
    } catch (err) {
      logger.warn({ err: err.message, path: lease.path }, 'worktree: patch export failed');
      return null;
    }
  }

  async function removeWorktree(root, target) {
    try {
      await git(root, ['worktree', 'remove', '--force', target]);
    } catch (err) {
      logger.warn({ err: err.message, target }, 'worktree: remove failed — falling back to rm');
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    }
    await git(root, ['worktree', 'prune']).catch(() => {});
  }

  /** 링크할 디렉토리(node_modules 등)를 primary 에서 symlink 로 끌어온다. */
  async function linkShared(root, target, links) {
    for (const rel of links) {
      if (typeof rel !== 'string' || !rel.trim() || rel.includes('..')) continue;
      const src = path.join(root, rel);
      const dst = path.join(target, rel);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      try {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.symlink(src, dst, 'dir');
      } catch (err) {
        logger.warn({ err: err.message, src, dst }, 'worktree: link failed (non-fatal)');
      }
    }
  }

  /**
   * 슬롯 디렉토리를 쓸 수 있는 상태로 만든다.
   * 이미 있으면(재시작으로 리스만 사라진 경우) 패치를 뽑고 primary HEAD 로 되돌린다.
   * @returns {Promise<string>} baseSha
   */
  async function ensureWorktree(root, target, cfg) {
    const headSha = await git(root, ['rev-parse', 'HEAD']);
    if (fs.existsSync(target)) {
      try {
        await git(target, ['rev-parse', '--git-dir']);
        // 지난 실행의 baseSha 는 리스와 함께 사라졌다. merge-base 로 되짚어야
        // detached HEAD 에 커밋된 작업까지 패치에 들어온다.
        const baseSha = await git(target, ['merge-base', 'HEAD', headSha]).catch(() => null);
        await exportPatch({ path: target, sessionId: path.basename(target), baseSha }, cfg);
        await git(target, ['reset', '--hard', headSha]);
        await git(target, ['clean', '-fd']);
        await linkShared(root, target, cfg.links);
        return headSha;
      } catch (err) {
        logger.warn({ err: err.message, target }, 'worktree: stale dir unusable — recreating');
        await removeWorktree(root, target);
      }
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await git(root, ['worktree', 'add', '--detach', target, headSha]);
    await linkShared(root, target, cfg.links);
    return headSha;
  }

  /**
   * slot 0 은 에이전트에 설정된 workingDir 그 자체다 — git toplevel 로 바꿔치면
   * 안 된다. workingDir 이 레포의 하위 디렉토리인 에이전트의 cwd 가 조용히
   * 루트로 올라가고, cwd 문자열이 달라져 기존 세션의 --resume 도 깨진다.
   */
  async function take({ agentId, sessionId, slot, target, root, cfg }) {
    const isolated = slot !== 0;
    const baseSha = isolated
      ? await ensureWorktree(root, target, cfg)
      : await git(root, ['rev-parse', 'HEAD']).catch(() => null);
    const lease = { agentId, sessionId, slot, path: target, root, baseSha, isolated, leasedAt: Date.now() };
    leases.set(target, lease);
    bySession.set(sessionId, target);
    logger.info({ agentId, sessionId, slot, path: target, isolated }, 'worktree: slot leased');
    return { path: target, slot, isolated };
  }

  /**
   * 워커 세션에 줄 cwd 를 확보한다.
   *
   * @param {string} agentId
   * @param {string} sessionId  워커 세션 ID (리스의 주인)
   * @param {{preferred?: string|null}} [opts] preferred — 이 세션이 지난번에 쓰던
   *        경로. 비어 있으면 그 경로를 그대로 다시 잡는다(재시작 후 resume 보존).
   * @returns {Promise<{path: string, slot: number, isolated: boolean}|null>}
   *          null 이면 격리 없음 — 호출자는 기존 동작(원본 workingDir) 그대로.
   */
  async function leaseWorktree(agentId, sessionId, opts = {}) {
    const cfg = settings();
    if (!cfg.enabled || !agentId || !sessionId) return null;
    const primary = ctx.configStore?.getAgent?.(agentId)?.workingDir || null;
    if (!primary) return null;

    // 슬롯이 하나면 격리할 상대가 없다 — 기존 동작을 그대로 둔다.
    const max = ctx.getMaxConcurrent?.(agentId) ?? 1;
    if (max <= 1) return null;

    const root = await repoRootOf(primary);
    if (!root) return null;

    try {
      // 이미 이 세션이 쥐고 있는 슬롯이 있으면 그대로 — 재사용 위임의 정상 경로.
      const held = bySession.get(sessionId);
      if (held && leases.get(held)?.sessionId === sessionId && fs.existsSync(held)) {
        const lease = leases.get(held);
        return { path: lease.path, slot: lease.slot, isolated: lease.isolated };
      }

      const slots = [];
      for (let i = 0; i < max; i++) slots.push(cfg.includePrimary ? i : i + 1);
      const pathFor = (slot) => (slot === 0 ? primary : slotPath(cfg, agentId, slot));

      // 재시작 후: 이 세션이 쓰던 경로를 되찾아야 --resume 이 살아난다.
      // (CLI 세션 파일은 cwd 문자열로 인코딩된 디렉토리에 들어 있다)
      const preferred = opts.preferred || null;
      if (preferred && !leases.has(preferred)) {
        const slot = slots.find((s) => pathFor(s) === preferred);
        if (slot !== undefined) {
          return await take({ agentId, sessionId, slot, target: preferred, root, cfg });
        }
      }

      for (const slot of slots) {
        const target = pathFor(slot);
        if (leases.has(target)) continue;
        return await take({ agentId, sessionId, slot, target, root, cfg });
      }

      // 빈 슬롯이 없다 — 유휴 홀더에서 회수. 활성 세션은 절대 건드리지 않는다.
      for (const slot of slots) {
        const target = pathFor(slot);
        const lease = leases.get(target);
        if (!lease || isHolderActive(lease.sessionId)) continue;
        logger.info(
          { agentId, slot, from: lease.sessionId, to: sessionId },
          'worktree: reclaiming idle slot'
        );
        await releaseWorktree(lease.sessionId, 'reclaimed');
        return await take({ agentId, sessionId, slot, target, root, cfg });
      }

      logger.warn({ agentId, sessionId, max }, 'worktree: no free slot — worker falls back to primary tree');
      return null;
    } catch (err) {
      // 격리에 실패해도 위임 자체는 살려야 한다 — primary 로 떨어진다(기존 동작).
      logger.warn({ err: err.message, agentId, sessionId }, 'worktree: lease failed — using primary tree');
      return null;
    }
  }

  /**
   * 세션이 쥔 슬롯을 놓는다. worktree 슬롯이면 패치를 뽑고 디렉토리까지 정리한다.
   * primary(slot 0) 는 리스만 풀고 아무것도 건드리지 않는다.
   *
   * @returns {Promise<{slot: number, path: string, patch: string|null}|null>}
   */
  async function releaseWorktree(sessionId, reason = 'released') {
    const target = sessionId ? bySession.get(sessionId) : null;
    if (!target) return null;
    const lease = leases.get(target);
    bySession.delete(sessionId);
    leases.delete(target);
    if (!lease) return null;

    if (!lease.isolated) {
      logger.info({ sessionId, reason }, 'worktree: primary slot released');
      return { slot: lease.slot, path: lease.path, patch: null };
    }

    const cfg = settings();
    let patch = null;
    try {
      if (fs.existsSync(lease.path)) {
        patch = await exportPatch(lease, cfg);
        await removeWorktree(lease.root, lease.path);
      }
    } catch (err) {
      logger.warn({ err: err.message, path: lease.path }, 'worktree: cleanup failed');
    }
    // cwd 가 사라진 세션을 resume 하면 CLI 가 조용히 fresh 세션으로 떨어진다 —
    // 재사용 후보에서 빼야 한다.
    ctx.forgetWorkerSession?.(sessionId);
    logger.info({ sessionId, slot: lease.slot, path: lease.path, reason, patch }, 'worktree: slot released');
    return { slot: lease.slot, path: lease.path, patch };
  }

  /** 테스트/디버그용 스냅샷. */
  function worktreeStats() {
    return {
      enabled: settings().enabled,
      leases: [...leases.values()].map((l) => ({
        agentId: l.agentId,
        sessionId: l.sessionId,
        slot: l.slot,
        path: l.path
      }))
    };
  }

  return { leaseWorktree, releaseWorktree, worktreeStats };
}
