import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createAccountScheduler, parseRateLimitExpiry } from '../server/lib/account-scheduler.js';
import { startClaudeRun } from '../server/runners/claude-cli-runner.js';

const WEEKLY_TEXT = "You've hit your weekly limit · resets Sep 21 at 10am (Asia/Seoul)";

describe('parseRateLimitExpiry — 주간 한도(날짜 포함) 문구', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T05:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('"resets Sep 21 at 10am (Asia/Seoul)" 를 KST 로 읽는다', () => {
    expect(new Date(parseRateLimitExpiry(WEEKLY_TEXT)).toISOString())
      .toBe('2026-09-21T01:00:00.000Z');
  });

  it('분과 pm 도 읽는다', () => {
    const at = parseRateLimitExpiry('weekly limit · resets Sep 21 at 10:30pm (Asia/Seoul)');
    expect(new Date(at).toISOString()).toBe('2026-09-21T13:30:00.000Z');
  });

  it('12am 은 자정으로 읽는다', () => {
    const at = parseRateLimitExpiry('weekly limit · resets Sep 22 at 12am (Asia/Seoul)');
    expect(new Date(at).toISOString()).toBe('2026-09-21T15:00:00.000Z');
  });

  it('연말에 다음 해 날짜가 오면 해를 넘긴다', () => {
    vi.setSystemTime(new Date('2026-12-30T05:00:00Z'));
    const at = parseRateLimitExpiry('weekly limit · resets Jan 3 at 9am (Asia/Seoul)');
    expect(new Date(at).toISOString()).toBe('2027-01-03T00:00:00.000Z');
  });

  it('서버 TZ 와 무관하게 같은 값을 준다', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'UTC';
    const utc = parseRateLimitExpiry(WEEKLY_TEXT);
    process.env.TZ = 'America/New_York';
    const ny = parseRateLimitExpiry(WEEKLY_TEXT);
    process.env.TZ = tz;
    expect(utc).toBe(ny);
    expect(new Date(utc).toISOString()).toBe('2026-09-21T01:00:00.000Z');
  });

  it('주간 한도인데 시각을 못 읽으면 기본값이 5시간이 아니라 24시간', () => {
    const at = parseRateLimitExpiry("You've hit your weekly limit for Claude");
    expect(at - Date.now()).toBe(24 * 3_600_000);
  });

  it('주간이 아닌 문구의 기본값은 그대로 5시간', () => {
    const at = parseRateLimitExpiry('Claude AI usage limit reached');
    expect(at - Date.now()).toBe(5 * 3_600_000);
  });

  it('"try again in N hours" 는 기존대로 우선한다', () => {
    const at = parseRateLimitExpiry('weekly limit reached, try again in 2 hours');
    expect(at - Date.now()).toBe(2 * 3_600_000);
  });

  it('시각만 있는 기존 형식은 영향받지 않는다', () => {
    const at = parseRateLimitExpiry("You've hit your session limit · resets 1:40am (Asia/Seoul)");
    expect(at).toBeGreaterThan(Date.now());
    expect(at - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
  });
});

/** update 호출을 기록하는 최소 accountsStore. */
function fakeAccountsStore(accounts) {
  const updates = [];
  return {
    updates,
    getAll: () => accounts,
    getById: (id) => accounts.find((a) => a.id === id) ?? null,
    update: async (id, patch) => { updates.push({ id, patch }); },
  };
}

const PAST = new Date(Date.now() - 3_600_000).toISOString();
const RESETS_AT = new Date(Date.now() + 40 * 3_600_000).toISOString();

const COOLING_ACCOUNT = {
  id: 'acc_weekly', status: 'cooldown', cooldownUntil: PAST, configDir: '/tmp/acc_weekly',
};

describe('autoRestoreCooldowns — 잔량 0 이면 복구하지 않는다', () => {
  it('sevenDay 100% + 미래 resetsAt 이면 그 시각까지 쿨다운 연장', async () => {
    const accountsStore = fakeAccountsStore([{ ...COOLING_ACCOUNT }]);
    const usageReader = {
      getOne: async () => ({ status: 'ok', sevenDay: { utilization: 100, resetsAt: RESETS_AT } }),
    };
    await createAccountScheduler({ accountsStore, usageReader }).autoRestoreCooldowns();
    expect(accountsStore.updates).toEqual([
      { id: 'acc_weekly', patch: { status: 'cooldown', cooldownUntil: RESETS_AT } },
    ]);
  });

  it('잔량이 남아 있으면 기존대로 active 로 복구', async () => {
    const accountsStore = fakeAccountsStore([{ ...COOLING_ACCOUNT }]);
    const usageReader = {
      getOne: async () => ({ status: 'ok', sevenDay: { utilization: 62, resetsAt: RESETS_AT } }),
    };
    await createAccountScheduler({ accountsStore, usageReader }).autoRestoreCooldowns();
    expect(accountsStore.updates).toEqual([
      { id: 'acc_weekly', patch: { status: 'active', cooldownUntil: null } },
    ]);
  });

  it('100% 라도 resetsAt 이 과거면 복구한다 (창이 이미 열렸다)', async () => {
    const accountsStore = fakeAccountsStore([{ ...COOLING_ACCOUNT }]);
    const usageReader = {
      getOne: async () => ({ status: 'ok', sevenDay: { utilization: 100, resetsAt: PAST } }),
    };
    await createAccountScheduler({ accountsStore, usageReader }).autoRestoreCooldowns();
    expect(accountsStore.updates[0].patch.status).toBe('active');
  });

  it('사용량 조회가 실패하면 막지 않고 복구한다', async () => {
    const accountsStore = fakeAccountsStore([{ ...COOLING_ACCOUNT }]);
    const usageReader = { getOne: async () => { throw new Error('401'); } };
    await createAccountScheduler({ accountsStore, usageReader }).autoRestoreCooldowns();
    expect(accountsStore.updates[0].patch.status).toBe('active');
  });

  it('usageReader 가 없으면 기존 동작 그대로', async () => {
    const accountsStore = fakeAccountsStore([{ ...COOLING_ACCOUNT }]);
    await createAccountScheduler({ accountsStore }).autoRestoreCooldowns();
    expect(accountsStore.updates[0].patch.status).toBe('active');
  });

  it('쿨다운이 아직 안 끝났으면 건드리지 않는다', async () => {
    const accountsStore = fakeAccountsStore([
      { ...COOLING_ACCOUNT, cooldownUntil: RESETS_AT },
    ]);
    const usageReader = { getOne: async () => { throw new Error('호출되면 안 됨'); } };
    await createAccountScheduler({ accountsStore, usageReader }).autoRestoreCooldowns();
    expect(accountsStore.updates).toEqual([]);
  });
});

/** 한도 메시지만 뱉고 끝나는 가짜 claude CLI. */
function mockSpawn({ stdout = [], stderr = [], exitCode = 0 }) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      for (const line of stdout) proc.stdout.emit('data', line + '\n');
      for (const line of stderr) proc.stderr.emit('data', line + '\n');
      proc.emit('close', exitCode);
    });
    return proc;
  };
}

/** setCooldown / updateBackend 호출을 기록하는 최소 backendsStore. */
function fakeBackendsStore({ oauthFor = null } = {}) {
  const cooldowns = [];
  const updates = [];
  return {
    cooldowns,
    updates,
    getBackend: () => ({ type: 'claude-cli' }),
    getOAuthToken: (id) => (id === oauthFor ? 'sk-managed' : null),
    markUsed: async () => {},
    setCooldown: async (id, expiresAt) => { cooldowns.push({ id, expiresAt }); },
    updateBackend: async (id, patch) => { updates.push({ id, patch }); },
  };
}

/** configDir 은 'claude' 계정이 주고, agent 는 다른 backendId 를 가리키는 상황. */
function splitScheduler() {
  return {
    pickAccount: () => ({ id: 'claude', configDir: '/tmp/claude' }),
    markUsed: async () => {},
    pickNextAccount: () => null,
    setCooldown: async () => {},
  };
}

const SPLIT_AGENT = {
  id: 'a', model: 'sonnet', workingDir: '/tmp', accountId: 'claude', backendId: 'acc_T1nxRYS',
};

function runRateLimited({ agent, accountScheduler, backendsStore }) {
  return new Promise((resolve) => {
    let rateLimitEvent = null;
    startClaudeRun({
      agent,
      message: 'hi',
      accountScheduler,
      envOverrides: { _backendsStore: backendsStore },
      callbacks: {
        onRateLimit: (e) => { rateLimitEvent = e; },
        onError: () => {},
        onExit: () => resolve(rateLimitEvent),
      },
      spawn: mockSpawn({
        stdout: [JSON.stringify({
          type: 'result', is_error: true, result: WEEKLY_TEXT, session_id: 'c-1',
        })],
      }),
    });
  });
}

function runAuthExpired({ agent, accountScheduler, backendsStore }) {
  return new Promise((resolve) => {
    let authEvent = null;
    startClaudeRun({
      agent,
      message: 'hi',
      accountScheduler,
      envOverrides: { _backendsStore: backendsStore },
      callbacks: {
        onAuthExpired: (e) => { authEvent = e; },
        onError: () => {},
        onExit: () => resolve(authEvent),
      },
      spawn: mockSpawn({
        stderr: ['OAuth token has expired. Please run `claude login`.'],
        exitCode: 1,
      }),
    });
  });
}

describe('handleRateLimit — 실제 인증에 쓰인 백엔드에 쿨다운', () => {
  it('configDir 계정으로 돌았으면 backendId 가 아니라 그 계정에 건다', async () => {
    const backendsStore = fakeBackendsStore();
    const event = await runRateLimited({
      agent: SPLIT_AGENT, accountScheduler: splitScheduler(), backendsStore,
    });
    expect(backendsStore.cooldowns.map((c) => c.id)).toEqual(['claude']);
    expect(event.backendId).toBe('claude');
    // 주간 한도 문구 → 5시간 기본값이 아니라 파싱된 리셋 시각
    expect(backendsStore.cooldowns[0].expiresAt.endsWith('T01:00:00.000Z')).toBe(true);
  });

  it('managed 토큰이 실렸으면 그 백엔드에 건다', async () => {
    const backendsStore = fakeBackendsStore({ oauthFor: 'acc_T1nxRYS' });
    const event = await runRateLimited({
      agent: SPLIT_AGENT, accountScheduler: splitScheduler(), backendsStore,
    });
    expect(backendsStore.cooldowns.map((c) => c.id)).toEqual(['acc_T1nxRYS']);
    expect(event.backendId).toBe('acc_T1nxRYS');
  });
});

describe('handleAuthExpired — 실제 인증에 쓰인 백엔드에 needs-relogin', () => {
  it('configDir 계정으로 돌았으면 그 계정을 재로그인 대상으로 찍는다', async () => {
    const backendsStore = fakeBackendsStore();
    const event = await runAuthExpired({
      agent: SPLIT_AGENT, accountScheduler: splitScheduler(), backendsStore,
    });
    expect(backendsStore.updates).toEqual([
      { id: 'claude', patch: { status: 'needs-relogin' } },
    ]);
    expect(event).toEqual({ accountId: 'claude', backendId: 'claude' });
  });

  it('managed 토큰이 실렸으면 그 백엔드를 찍는다', async () => {
    const backendsStore = fakeBackendsStore({ oauthFor: 'acc_T1nxRYS' });
    const event = await runAuthExpired({
      agent: SPLIT_AGENT, accountScheduler: splitScheduler(), backendsStore,
    });
    expect(backendsStore.updates).toEqual([
      { id: 'acc_T1nxRYS', patch: { status: 'needs-relogin' } },
    ]);
    expect(event.backendId).toBe('acc_T1nxRYS');
  });

  it('한 번만 마킹한다 (같은 메시지가 여러 줄로 와도)', async () => {
    const backendsStore = fakeBackendsStore();
    await new Promise((resolve) => {
      startClaudeRun({
        agent: SPLIT_AGENT,
        message: 'hi',
        accountScheduler: splitScheduler(),
        envOverrides: { _backendsStore: backendsStore },
        callbacks: { onError: () => {}, onExit: resolve },
        spawn: mockSpawn({
          stderr: ['401 Unauthorized', 'Please re-authenticate'],
          exitCode: 1,
        }),
      });
    });
    expect(backendsStore.updates).toHaveLength(1);
  });
});
