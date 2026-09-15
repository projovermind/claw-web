import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktreePool } from '../server/routes/chat/worktree-pool.js';
import { createWorkerPool } from '../server/routes/chat/worker-pool.js';
import { createQueue } from '../server/routes/chat/queue.js';
import { createDelegation } from '../server/routes/chat/delegation.js';
import { createDelegationTracker } from '../server/lib/delegation-tracker.js';
import { createEventBus } from '../server/lib/event-bus.js';

/**
 * 동시 슬롯별 git worktree 격리 회귀 테스트.
 *
 * 고정하려는 것:
 *   (1) 기본값(isolation off) / maxConcurrent 1 에서는 아무것도 바뀌지 않는다
 *   (2) 동시에 도는 워커 둘은 절대 같은 디렉토리를 받지 않는다
 *   (3) 같은 세션은 항상 같은 경로를 되돌려 받는다(--resume 보존)
 *   (4) 활성 홀더의 슬롯은 회수되지 않고, 유휴 홀더의 것만 회수된다
 *   (5) 해제할 때 커밋되지 않은 변경은 패치로 보존된 뒤 정리된다
 */

let dir;        // tmp 루트
let repo;       // primary working tree (git repo)
let wtRoot;     // 슬롯 디렉토리 루트
let ctx;
let busy;
let forgotten;

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function initRepo() {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const v = 1;\n');
  fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), '// dep\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
}

/** worktree-pool 만 쓰는 최소 ctx. agents 는 테스트에서 직접 조작한다. */
function makePool(chatConfig = {}, agentOverrides = {}) {
  busy = new Set();
  forgotten = [];
  const agents = {
    dev: { name: 'dev', workingDir: repo, maxConcurrent: 2, ...agentOverrides },
    nogit: { name: 'nogit', workingDir: path.join(dir, 'plain'), maxConcurrent: 2 }
  };
  const base = {
    webConfig: {
      chat: { worktreeIsolation: true, worktreeRoot: wtRoot, ...chatConfig }
    },
    configStore: { getAgent: (id) => agents[id] ?? null, getAgents: () => agents },
    getMaxConcurrent: (id) => agents[id]?.maxConcurrent ?? 1,
    isSessionBusy: (id) => busy.has(id),
    delegationTracker: { getByTarget: () => null },
    forgetWorkerSession: (id) => forgotten.push(id)
  };
  Object.assign(base, createWorktreePool(base));
  base.agents = agents;
  return base;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-wt-'));
  repo = path.join(dir, 'repo');
  wtRoot = path.join(dir, 'worktrees');
  fs.mkdirSync(path.join(dir, 'plain'), { recursive: true });
  initRepo();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('worktree slot isolation — 꺼져 있을 때', () => {
  it('worktreeIsolation 기본값(off) 이면 리스를 주지 않는다', async () => {
    ctx = makePool({ worktreeIsolation: false });
    expect(await ctx.leaseWorktree('dev', 'sess_1')).toBeNull();
    expect(ctx.worktreeStats().leases).toEqual([]);
  });

  it('maxConcurrent 1 이면 격리하지 않는다 — 기존 동작 그대로', async () => {
    ctx = makePool({}, { maxConcurrent: 1 });
    expect(await ctx.leaseWorktree('dev', 'sess_1')).toBeNull();
  });

  it('git 레포가 아닌 workingDir 은 격리 불가 — null 로 폴백', async () => {
    ctx = makePool();
    expect(await ctx.leaseWorktree('nogit', 'sess_1')).toBeNull();
  });
});

describe('worktree slot isolation — 슬롯 배정', () => {
  it('동시 워커 둘에게 서로 다른 cwd 를 주고, 두 번째는 실제 worktree 다', async () => {
    ctx = makePool();
    const a = await ctx.leaseWorktree('dev', 'sess_a');
    const b = await ctx.leaseWorktree('dev', 'sess_b');

    expect(a.path).toBe(repo);        // slot 0 = 원본 트리
    expect(a.slot).toBe(0);
    expect(a.isolated).toBe(false);
    expect(b.path).not.toBe(a.path);
    expect(b.slot).toBe(1);
    expect(b.isolated).toBe(true);

    // 실제 git worktree 이고 tracked 파일이 체크아웃돼 있다
    expect(fs.existsSync(path.join(b.path, 'app.js'))).toBe(true);
    expect(git(b.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(git(repo, 'worktree', 'list')).toContain(b.path);

    // 한쪽 편집이 다른 쪽에 보이지 않는다 — 이 격리가 목적 그 자체다
    fs.writeFileSync(path.join(b.path, 'app.js'), 'export const v = 2;\n');
    expect(fs.readFileSync(path.join(repo, 'app.js'), 'utf8')).toContain('v = 1');
  });

  it('worktreeIncludePrimary=false 면 모든 워커가 worktree 로 빠진다', async () => {
    ctx = makePool({ worktreeIncludePrimary: false });
    const a = await ctx.leaseWorktree('dev', 'sess_a');
    const b = await ctx.leaseWorktree('dev', 'sess_b');
    expect(a.path).not.toBe(repo);
    expect(b.path).not.toBe(repo);
    expect(a.path).not.toBe(b.path);
    expect([a.slot, b.slot]).toEqual([1, 2]);
  });

  it('gitignore 된 node_modules 를 symlink 로 끌어온다', async () => {
    ctx = makePool();
    await ctx.leaseWorktree('dev', 'sess_a');
    const b = await ctx.leaseWorktree('dev', 'sess_b');
    const link = path.join(b.path, 'node_modules');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(link, 'left-pad', 'index.js'))).toBe(true);
  });

  it('같은 세션이 다시 요청하면 같은 경로 — resume 이 깨지지 않는다', async () => {
    ctx = makePool();
    await ctx.leaseWorktree('dev', 'sess_a');
    const first = await ctx.leaseWorktree('dev', 'sess_b');
    const again = await ctx.leaseWorktree('dev', 'sess_b');
    expect(again.path).toBe(first.path);
    expect(ctx.worktreeStats().leases).toHaveLength(2);
  });

  it('재시작 후에도 preferred 경로를 되찾는다', async () => {
    ctx = makePool();
    await ctx.leaseWorktree('dev', 'sess_a');
    const before = await ctx.leaseWorktree('dev', 'sess_b');
    fs.writeFileSync(path.join(before.path, 'wip.txt'), 'in progress\n');

    // 프로세스 재시작 — 리스 맵은 사라지고 디렉토리만 남는다
    const revived = makePool();
    const after = await revived.leaseWorktree('dev', 'sess_b', { preferred: before.path });
    expect(after.path).toBe(before.path);
    // 되찾을 때 트리는 primary HEAD 로 초기화되고, 남아 있던 변경은 패치로 보존된다
    expect(fs.existsSync(path.join(after.path, 'wip.txt'))).toBe(false);
    const patches = fs.readdirSync(path.join(wtRoot, '_patches'));
    expect(patches).toHaveLength(1);
    expect(fs.readFileSync(path.join(wtRoot, '_patches', patches[0]), 'utf8')).toContain('wip.txt');
  });
});

describe('worktree slot isolation — 회수와 해제', () => {
  it('활성 홀더의 슬롯은 회수하지 않는다 (null → primary 폴백)', async () => {
    ctx = makePool();
    const a = await ctx.leaseWorktree('dev', 'sess_a');
    const b = await ctx.leaseWorktree('dev', 'sess_b');
    busy.add('sess_a');
    busy.add('sess_b');

    expect(await ctx.leaseWorktree('dev', 'sess_c')).toBeNull();
    // 기존 리스는 그대로 — 활성 세션의 cwd 를 남에게 넘기지 않는다
    const held = ctx.worktreeStats().leases.map((l) => l.path).sort();
    expect(held).toEqual([a.path, b.path].sort());
  });

  it('유휴 홀더의 슬롯만 회수하고, 그 세션은 재사용 후보에서 뺀다', async () => {
    ctx = makePool();
    await ctx.leaseWorktree('dev', 'sess_a');
    const b = await ctx.leaseWorktree('dev', 'sess_b');
    busy.add('sess_a');   // slot 0 홀더는 활성 → 건드리면 안 됨

    const c = await ctx.leaseWorktree('dev', 'sess_c');
    expect(c.path).toBe(b.path);
    expect(c.slot).toBe(1);
    expect(forgotten).toContain('sess_b');
    const owners = ctx.worktreeStats().leases.map((l) => l.sessionId).sort();
    expect(owners).toEqual(['sess_a', 'sess_c']);
  });

  it('해제 시 커밋 안 된 변경을 패치로 뽑고 디렉토리를 정리한다', async () => {
    ctx = makePool();
    await ctx.leaseWorktree('dev', 'sess_a');
    const b = await ctx.leaseWorktree('dev', 'sess_b');
    fs.writeFileSync(path.join(b.path, 'app.js'), 'export const v = 99;\n');
    fs.writeFileSync(path.join(b.path, 'new-file.js'), 'export const added = true;\n');

    const released = await ctx.releaseWorktree('sess_b', 'test');
    expect(released.slot).toBe(1);
    expect(released.patch).toBeTruthy();
    const patch = fs.readFileSync(released.patch, 'utf8');
    expect(patch).toContain('app.js');
    expect(patch).toContain('new-file.js');     // untracked 도 보존
    expect(patch.endsWith('\n')).toBe(true);    // git apply 가 먹는 형태

    expect(fs.existsSync(b.path)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(b.path);
    expect(ctx.worktreeStats().leases).toHaveLength(1);
  });

  it('detached HEAD 에 커밋한 작업도 패치에 담긴다', async () => {
    ctx = makePool();
    await ctx.leaseWorktree('dev', 'sess_a');
    const b = await ctx.leaseWorktree('dev', 'sess_b');
    fs.writeFileSync(path.join(b.path, 'app.js'), 'export const v = 42;\n');
    git(b.path, 'config', 'user.email', 'worker@example.com');
    git(b.path, 'config', 'user.name', 'worker');
    git(b.path, 'commit', '-qam', 'worker commit');

    const released = await ctx.releaseWorktree('sess_b', 'test');
    expect(released.patch).toBeTruthy();
    expect(fs.readFileSync(released.patch, 'utf8')).toContain('v = 42');
  });

  it('primary 슬롯 해제는 원본 트리를 건드리지 않는다', async () => {
    ctx = makePool();
    const a = await ctx.leaseWorktree('dev', 'sess_a');
    expect(a.path).toBe(repo);
    const released = await ctx.releaseWorktree('sess_a', 'test');
    expect(released.slot).toBe(0);
    expect(released.patch).toBeNull();
    expect(fs.existsSync(path.join(repo, 'app.js'))).toBe(true);
  });

  it('변경이 없으면 패치를 만들지 않는다', async () => {
    ctx = makePool();
    await ctx.leaseWorktree('dev', 'sess_a');
    await ctx.leaseWorktree('dev', 'sess_b');
    const released = await ctx.releaseWorktree('sess_b', 'test');
    expect(released.patch).toBeNull();
    expect(fs.existsSync(path.join(wtRoot, '_patches'))).toBe(false);
  });

  it('리스가 없는 세션 해제는 조용히 no-op', async () => {
    ctx = makePool();
    expect(await ctx.releaseWorktree('sess_nobody', 'test')).toBeNull();
  });
});

describe('worktree slot isolation — 위임 경로 연동', () => {
  /** executeDelegation 까지 태워, 워커 세션에 cwd 가 박히는지 확인한다. */
  function makeDelegationCtx(chatConfig = {}) {
    const sessions = new Map();
    let seq = 0;
    const agents = { dev: { name: 'dev', workingDir: repo, maxConcurrent: 2 } };
    const base = {
      sessionsStore: {
        create: async ({ agentId, title, ...extra }) => {
          const s = { id: `sess_${++seq}`, agentId, title, messages: [], ...extra };
          sessions.set(s.id, s);
          return s;
        },
        get: (id) => sessions.get(id) ?? null,
        update: async (id, patch) => { const s = sessions.get(id); if (s) Object.assign(s, patch); },
        appendMessage: async (id, msg) => { const s = sessions.get(id); if (s) s.messages.push(msg); }
      },
      configStore: { getAgent: (id) => agents[id] ?? null, getAgents: () => agents },
      metadataStore: { getAgent: () => ({}) },
      eventBus: createEventBus(),
      delegationTracker: createDelegationTracker({
        filePath: path.join(dir, 'delegations.json'),
        reportsDir: path.join(dir, 'reports')
      }),
      pushStore: null,
      failureReEntryCounters: new Map(),
      MAX_FAILURE_REENTRY: 1,
      isSessionBusy: () => false,
      dispatch: vi.fn(),
      webConfig: { chat: { worktreeIsolation: true, worktreeRoot: wtRoot, ...chatConfig } }
    };
    base.sessions = sessions;
    Object.assign(base, createQueue(base));
    Object.assign(base, createWorkerPool(base));
    Object.assign(base, createWorktreePool(base));
    Object.assign(base, createDelegation(base));
    return base;
  }

  it('동시에 발주된 위임 둘이 서로 다른 워킹트리를 받는다', async () => {
    const dctx = makeDelegationCtx();
    await dctx.executeDelegation('lead', 'dev', 'task A', '{}');
    await dctx.executeDelegation('lead2', 'dev', 'task B', '{}');

    const workers = [...dctx.sessions.values()].filter((s) => s.agentId === 'dev');
    expect(workers).toHaveLength(2);
    const paths = workers.map((s) => s.worktreePath ?? repo);
    expect(new Set(paths).size).toBe(2);
    expect(paths).toContain(repo);
    const isolated = workers.find((s) => s.worktreePath && s.worktreePath !== repo);
    expect(isolated.worktreeSlot).toBe(1);
    expect(fs.existsSync(isolated.worktreePath)).toBe(true);
  });

  it('isolation 이 꺼져 있으면 세션에 cwd 를 박지 않는다', async () => {
    const dctx = makeDelegationCtx({ worktreeIsolation: false });
    await dctx.executeDelegation('lead', 'dev', 'task A', '{}');
    const worker = [...dctx.sessions.values()].find((s) => s.agentId === 'dev');
    expect(worker.worktreePath).toBeUndefined();
  });

  it('위임이 중단되면 슬롯이 정리된다', async () => {
    const dctx = makeDelegationCtx();
    await dctx.executeDelegation('lead', 'dev', 'task A', '{}');
    await dctx.executeDelegation('lead2', 'dev', 'task B', '{}');
    const isolated = [...dctx.sessions.values()].find((s) => s.worktreePath && s.worktreePath !== repo);
    expect(fs.existsSync(isolated.worktreePath)).toBe(true);

    await dctx.abandonDelegation(isolated.id, '테스트 중단');
    expect(fs.existsSync(isolated.worktreePath)).toBe(false);
    expect(dctx.worktreeStats().leases.map((l) => l.sessionId)).not.toContain(isolated.id);
  });
});
