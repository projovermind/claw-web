import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  keychainServiceName,
  fetchBackendUsage,
  createBackendUsageReader,
  buildCredentialPool
} from '../server/lib/backend-usage.js';
import { createBackendsStore } from '../server/lib/backends-store.js';
import { createBackendsRouter } from '../server/routes/backends.js';
import { errorHandler } from '../server/middleware/error-handler.js';

const API_BODY = {
  five_hour: { utilization: 74.0, resets_at: '2026-09-17T06:40:00.119863+00:00' },
  seven_day: { utilization: 59.0, resets_at: '2026-09-21T01:00:00.119883+00:00' },
  extra_usage: {
    is_enabled: false,
    monthly_limit: 2000,
    used_credits: 0.0,
    utilization: 0.0,
    currency: 'USD'
  }
};

function okFetch(body = API_BODY) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

/** configDir 에 .credentials.json + .claude.json 을 심는다. */
function makeConfigDir(creds, oauthAccount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-usage-'));
  if (creds) {
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: creds }));
  }
  if (oauthAccount) {
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount }));
  }
  return dir;
}

const FUTURE = Date.now() + 3600_000;
const PAST = Date.now() - 3600_000;
const liveCreds = { accessToken: 'sk-ant-oat01-SECRET', expiresAt: FUTURE, subscriptionType: 'max' };

describe('keychainServiceName', () => {
  const home = process.env.HOME;
  afterEach(() => { process.env.HOME = home; });

  it('기본 설정 디렉터리(~/.claude)는 접미사가 없다', () => {
    process.env.HOME = '/Users/tester';
    expect(keychainServiceName('/Users/tester/.claude')).toBe('Claude Code-credentials');
  });

  it('그 외 configDir 은 sha256 앞 8자를 붙인다', () => {
    process.env.HOME = '/Users/tester';
    const dir = '/Users/tester/.claude-claw/account-b';
    const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
    expect(keychainServiceName(dir)).toBe(`Claude Code-credentials-${hash}`);
  });

  it('configDir 이 다르면 서비스명도 다르다 (계정 격리)', () => {
    expect(keychainServiceName('/a')).not.toBe(keychainServiceName('/b'));
  });
});

describe('fetchBackendUsage', () => {
  const dirs = [];
  const mk = (...a) => { const d = makeConfigDir(...a); dirs.push(d); return d; };
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it('claude-cli 가 아닌 백엔드는 unsupported', async () => {
    const fetchImpl = okFetch();
    const r = await fetchBackendUsage('zai', { type: 'anthropic-compatible' }, { fetchImpl });
    expect(r.status).toBe('unsupported');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('응답을 정규화하고 토큰은 노출하지 않는다', async () => {
    const configDir = mk(liveCreds, { emailAddress: 'a@b.com', organizationName: 'Org' });
    const fetchImpl = okFetch();
    const r = await fetchBackendUsage('acc', { type: 'claude-cli', configDir }, { fetchImpl });

    expect(r.status).toBe('ok');
    expect(r.fiveHour).toEqual({ utilization: 74, resetsAt: '2026-09-17T06:40:00.119863+00:00' });
    expect(r.sevenDay).toEqual({ utilization: 59, resetsAt: '2026-09-21T01:00:00.119883+00:00' });
    expect(r.extraUsage).toEqual({
      enabled: false, utilization: 0, usedCredits: 0, monthlyLimit: 2000, currency: 'USD'
    });
    expect(r.account).toEqual({ email: 'a@b.com', organization: 'Org', tier: 'max' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('oauth beta 헤더와 Bearer 토큰으로 호출한다', async () => {
    const configDir = mk(liveCreds);
    const fetchImpl = okFetch();
    await fetchBackendUsage('acc', { type: 'claude-cli', configDir }, { fetchImpl });

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(opts.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(opts.headers.authorization).toBe('Bearer sk-ant-oat01-SECRET');
  });

  it('만료된 토큰은 갱신을 시도하지 않고 expired 를 반환한다', async () => {
    const configDir = mk({ ...liveCreds, expiresAt: PAST });
    const fetchImpl = okFetch();
    const r = await fetchBackendUsage('acc', { type: 'claude-cli', configDir }, { fetchImpl });

    expect(r.status).toBe('expired');
    expect(r.expiresAt).toBe(new Date(PAST).toISOString());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('자격증명이 없으면 no-credentials (키체인도 비었을 때)', async () => {
    const configDir = mk(null, null);
    const execFileAsync = vi.fn(async () => { throw new Error('not found'); });
    const r = await fetchBackendUsage('acc', { type: 'claude-cli', configDir }, {
      fetchImpl: okFetch(), execFileAsync, platform: 'darwin'
    });
    expect(r.status).toBe('no-credentials');
  });

  it('credentials.json 이 없으면 configDir 기반 키체인 항목을 읽는다', async () => {
    const configDir = mk(null, null);
    const execFileAsync = vi.fn(async () => ({
      stdout: JSON.stringify({ claudeAiOauth: liveCreds })
    }));
    const r = await fetchBackendUsage('acc', { type: 'claude-cli', configDir }, {
      fetchImpl: okFetch(), execFileAsync, platform: 'darwin'
    });

    expect(r.status).toBe('ok');
    const [bin, args] = execFileAsync.mock.calls[0];
    expect(bin).toBe('/usr/bin/security');
    expect(args.slice(0, 2)).toEqual(['find-generic-password', '-s']);
    expect(args[2]).toBe(keychainServiceName(configDir));
    expect(args).toContain('-w');
  });

  it('기본 디렉터리 계정은 ~/.claude.json 에서 메타를 읽는다 (레거시 레이아웃)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-home-'));
    dirs.push(home);
    const configDir = path.join(home, '.claude');
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: liveCreds }));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'legacy@b.com', organizationName: 'Legacy Org' }
    }));

    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await fetchBackendUsage('claude', { type: 'claude-cli', configDir }, { fetchImpl: okFetch() });
      expect(r.status).toBe('ok');
      expect(r.account.email).toBe('legacy@b.com');
      expect(r.account.organization).toBe('Legacy Org');
    } finally {
      process.env.HOME = prev;
    }
  });

  it('403 은 unauthorized (setup-token 은 user:profile 스코프가 없다)', async () => {
    const configDir = mk(liveCreds);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    const r = await fetchBackendUsage('acc', { type: 'claude-cli', configDir }, { fetchImpl });
    expect(r.status).toBe('unauthorized');
    expect(r.httpStatus).toBe(403);
  });

  it('네트워크 오류는 throw 하지 않고 error 로 내려간다', async () => {
    const configDir = mk(liveCreds);
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await fetchBackendUsage('acc', { type: 'claude-cli', configDir }, { fetchImpl });
    expect(r.status).toBe('error');
    expect(r.reason).toContain('ECONNREFUSED');
  });
});

describe('createBackendUsageReader 캐시', () => {
  let configDir;
  beforeEach(() => { configDir = makeConfigDir(liveCreds); });
  afterEach(() => { fs.rmSync(configDir, { recursive: true, force: true }); });

  const store = (backends) => ({ getRaw: () => ({ backends }) });

  it('60초 안에는 캐시로 응답하고 다시 호출하지 않는다', async () => {
    let t = 1_000_000;
    const fetchImpl = okFetch();
    const reader = createBackendUsageReader({
      backendsStore: store({ acc: { type: 'claude-cli', configDir } }),
      fetchImpl, now: () => t
    });

    expect((await reader.getAll()).acc.status).toBe('ok');
    t += 59_000;
    expect((await reader.getAll()).acc.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    t += 2_000; // ttl 초과
    await reader.getAll();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('force 는 캐시를 무시한다', async () => {
    const fetchImpl = okFetch();
    const reader = createBackendUsageReader({
      backendsStore: store({ acc: { type: 'claude-cli', configDir } }), fetchImpl
    });
    await reader.getAll();
    await reader.getAll({ force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('동시 호출은 한 번만 네트워크를 탄다', async () => {
    const fetchImpl = okFetch();
    const reader = createBackendUsageReader({
      backendsStore: store({ acc: { type: 'claude-cli', configDir } }), fetchImpl
    });
    await Promise.all([reader.getAll(), reader.getAll(), reader.getAll()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createBackendUsageReader 실패 폴백', () => {
  let configDir;
  beforeEach(() => { configDir = makeConfigDir(liveCreds); });
  afterEach(() => { fs.rmSync(configDir, { recursive: true, force: true }); });

  const store = (backends) => ({ getRaw: () => ({ backends }) });
  const noKeychain = () => vi.fn(async () => { throw new Error('not found'); });

  /** 첫 호출은 성공, 그 뒤부터는 주어진 실패 응답. */
  function okThen(fail) {
    let n = 0;
    return vi.fn(async () => (n++ === 0 ? { ok: true, status: 200, json: async () => API_BODY } : fail()));
  }

  const httpFail = (status, headers) => () => ({
    ok: false,
    status,
    ...(headers ? { headers: new Headers(headers) } : {})
  });

  function reader(fetchImpl, nowFn) {
    return createBackendUsageReader({
      backendsStore: store({ acc: { type: 'claude-cli', configDir } }),
      fetchImpl, execFileAsync: noKeychain(), now: nowFn
    });
  }

  it('에러 응답이 직전 ok 값을 덮어쓰지 않고 stale 로 유지된다', async () => {
    let t = 1_000_000;
    const fetchImpl = okThen(httpFail(500));
    const r = reader(fetchImpl, () => t);

    expect((await r.getAll()).acc.fiveHour.utilization).toBe(74);

    t += 61_000;
    const after = (await r.getAll()).acc;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(after.status).toBe('ok');
    expect(after.stale).toBe(true);
    expect(after.staleStatus).toBe('error');
    expect(after.fiveHour.utilization).toBe(74);
  });

  it('unauthorized 도 stale 로 가려진다', async () => {
    let t = 1_000_000;
    const r = reader(okThen(httpFail(401)), () => t);
    await r.getAll();
    t += 61_000;
    const after = (await r.getAll()).acc;
    expect(after.status).toBe('ok');
    expect(after.staleStatus).toBe('unauthorized');
  });

  it('실패는 10초만 캐시해서 빨리 재시도한다', async () => {
    let t = 1_000_000;
    const fetchImpl = okThen(httpFail(500));
    const r = reader(fetchImpl, () => t);
    await r.getAll();

    t += 61_000;
    await r.getAll();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    t += 9_000; // 아직 에러 ttl 안
    expect((await r.getAll()).acc.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    t += 2_000; // 10초 초과 → 재시도
    await r.getAll();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('429 는 Retry-After 만큼 기다린다', async () => {
    let t = 1_000_000;
    const fetchImpl = okThen(httpFail(429, { 'retry-after': '30' }));
    const r = reader(fetchImpl, () => t);
    await r.getAll();

    t += 61_000;
    await r.getAll();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    t += 20_000; // Retry-After 30초 안 → 재시도하지 않는다
    await r.getAll();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    t += 11_000;
    await r.getAll();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stale 이 15분을 넘으면 실패를 그대로 노출한다', async () => {
    let t = 1_000_000;
    const r = reader(okThen(httpFail(500)), () => t);
    await r.getAll();

    t += 16 * 60_000;
    const after = (await r.getAll()).acc;
    expect(after.status).toBe('error');
    expect(after.stale).toBeUndefined();
  });

  it('로그아웃(no-credentials) 은 stale 로 가리지 않는다', async () => {
    let t = 1_000_000;
    const r = reader(okFetch(), () => t);
    expect((await r.getAll()).acc.status).toBe('ok');

    fs.rmSync(path.join(configDir, '.credentials.json'));
    t += 61_000;
    const after = (await r.getAll()).acc;
    expect(after.status).toBe('no-credentials');
    expect(after.stale).toBeUndefined();
  });
});

describe('계정 공유 토큰 (accountUuid)', () => {
  const UUID = 'fbbcae4a-50f4-42da-8c09-869be421d0d0';
  const OTHER_UUID = '11111111-2222-3333-4444-555555555555';
  let home, prevHome;

  /** 키체인을 흉내낸다: 서비스명 → 자격증명 blob. 없는 서비스는 security 처럼 실패. */
  function fakeKeychain(entries) {
    const fn = vi.fn(async (_bin, args) => {
      const service = args[2];
      if (!(service in entries)) throw new Error('SecKeychainSearchCopyNext: not found');
      return { stdout: JSON.stringify({ claudeAiOauth: entries[service] }) };
    });
    return fn;
  }

  /** <home>/.claude-claw/account-<id> 를 만들고 oauthAccount 만 심는다(토큰은 키체인). */
  function accountDir(id, accountUuid) {
    const dir = path.join(home, '.claude-claw', `account-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    if (accountUuid) {
      fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
        oauthAccount: { accountUuid, emailAddress: 'a@b.com', organizationName: 'Org' }
      }));
    }
    return dir;
  }

  /** 기본 계정(~/.claude) — .claude.json 은 레거시 위치인 ~/.claude.json 이다. */
  function defaultDir(accountUuid) {
    const dir = path.join(home, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { accountUuid, emailAddress: 'a@b.com', organizationName: 'Org' }
    }));
    return dir;
  }

  const expiredCreds = { accessToken: 'EXPIRED-SECRET', expiresAt: PAST, subscriptionType: 'max' };
  const sharedCreds = { accessToken: 'SHARED-SECRET', expiresAt: FUTURE, subscriptionType: 'max', refreshToken: 'RT-SECRET' };

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-home-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('자기 토큰이 만료면 같은 계정의 기본 ~/.claude 토큰으로 조회한다', async () => {
    const dir = accountDir('acc_T1', UUID);
    const def = defaultDir(UUID);
    const execFileAsync = fakeKeychain({
      [keychainServiceName(dir)]: expiredCreds,
      [keychainServiceName(def)]: sharedCreds
    });
    const fetchImpl = okFetch();

    const r = await fetchBackendUsage('acc_T1', { type: 'claude-cli', configDir: dir }, {
      fetchImpl, execFileAsync, platform: 'darwin'
    });

    expect(r.status).toBe('ok');
    expect(r.tokenSource).toBe('shared');
    expect(r.tokenSourceDir).toBe(def);
    expect(r.accountUuid).toBe(UUID);
    expect(r.fiveHour.utilization).toBe(74);
    // 빌려온 토큰(기본 계정)으로 호출했는지
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer SHARED-SECRET');
    // 기본 계정의 키체인 항목은 접미사가 없다
    expect(execFileAsync.mock.calls.some((c) => c[1][2] === 'Claude Code-credentials')).toBe(true);
  });

  it('자기 configDir 에 토큰 항목 자체가 없어도 계정이 같으면 빌려온다', async () => {
    const dir = accountDir('acc_T1', UUID);
    const def = defaultDir(UUID);
    const execFileAsync = fakeKeychain({ [keychainServiceName(def)]: sharedCreds });

    const r = await fetchBackendUsage('acc_T1', { type: 'claude-cli', configDir: dir }, {
      fetchImpl: okFetch(), execFileAsync, platform: 'darwin'
    });

    expect(r.status).toBe('ok');
    expect(r.tokenSource).toBe('shared');
  });

  it('accountUuid 를 모르는 백엔드는 남의 토큰을 빌리지 않고 no-credentials', async () => {
    const dir = accountDir('acc_T1', null);   // 로그인 이력 없음
    const def = defaultDir(UUID);
    const execFileAsync = fakeKeychain({ [keychainServiceName(def)]: sharedCreds });
    const fetchImpl = okFetch();

    const r = await fetchBackendUsage('acc_T1', { type: 'claude-cli', configDir: dir }, {
      fetchImpl, execFileAsync, platform: 'darwin'
    });

    expect(r.status).toBe('no-credentials');
    expect(r.accountUuid).toBeNull();
    expect(r.tokenSource).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accountUuid 가 다르면 빌려오지 않고 expired 를 유지한다', async () => {
    const dir = accountDir('acc_T1', UUID);
    const def = defaultDir(OTHER_UUID);
    const execFileAsync = fakeKeychain({
      [keychainServiceName(dir)]: expiredCreds,
      [keychainServiceName(def)]: sharedCreds
    });
    const fetchImpl = okFetch();

    const r = await fetchBackendUsage('acc_T1', { type: 'claude-cli', configDir: dir }, {
      fetchImpl, execFileAsync, platform: 'darwin'
    });

    expect(r.status).toBe('expired');
    expect(r.accountUuid).toBe(UUID);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('자기 토큰이 유효하면 self 로 쓰고 다른 configDir 을 뒤지지 않는다', async () => {
    const dir = accountDir('acc_T1', UUID);
    defaultDir(UUID);
    const execFileAsync = fakeKeychain({ [keychainServiceName(dir)]: { ...sharedCreds, accessToken: 'OWN-SECRET' } });
    const fetchImpl = okFetch();

    const r = await fetchBackendUsage('acc_T1', { type: 'claude-cli', configDir: dir }, {
      fetchImpl, execFileAsync, platform: 'darwin'
    });

    expect(r.status).toBe('ok');
    expect(r.tokenSource).toBe('self');
    expect(r.tokenSourceDir).toBeUndefined();
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer OWN-SECRET');
    expect(execFileAsync).toHaveBeenCalledTimes(1);   // 자기 항목만 조회
  });

  it('토큰 refresh 를 시도하지 않는다 — usage 호출 1건, security 는 읽기 전용', async () => {
    const dir = accountDir('acc_T1', UUID);
    const def = defaultDir(UUID);
    const execFileAsync = fakeKeychain({
      [keychainServiceName(dir)]: expiredCreds,
      [keychainServiceName(def)]: sharedCreds
    });
    const fetchImpl = okFetch();

    await fetchBackendUsage('acc_T1', { type: 'claude-cli', configDir: dir }, {
      fetchImpl, execFileAsync, platform: 'darwin'
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.anthropic.com/api/oauth/usage');
    for (const [bin, args] of execFileAsync.mock.calls) {
      expect(bin).toBe('/usr/bin/security');
      expect(args[0]).toBe('find-generic-password');   // add/delete/update 아님
    }
  });

  it('공유 조회에서도 토큰이 응답에 새지 않는다', async () => {
    const dir = accountDir('acc_T1', UUID);
    const def = defaultDir(UUID);
    const r = await fetchBackendUsage('acc_T1', { type: 'claude-cli', configDir: dir }, {
      fetchImpl: okFetch(),
      execFileAsync: fakeKeychain({
        [keychainServiceName(dir)]: expiredCreds,
        [keychainServiceName(def)]: sharedCreds
      }),
      platform: 'darwin'
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain('SHARED-SECRET');
    expect(json).not.toContain('RT-SECRET');
    expect(json).not.toContain('EXPIRED-SECRET');
  });

  describe('buildCredentialPool', () => {
    it('만료 토큰은 담지 않고 같은 계정의 유효 토큰이 이긴다', async () => {
      const a = accountDir('a', UUID);
      const b = accountDir('b', UUID);
      const execFileAsync = fakeKeychain({
        [keychainServiceName(a)]: expiredCreds,
        [keychainServiceName(b)]: sharedCreds
      });

      const pool = await buildCredentialPool([a, b], { execFileAsync, platform: 'darwin' });
      expect(pool.get(UUID).configDir).toBe(b);
    });

    it('accountUuid 가 없는 디렉터리는 풀에 넣지 않는다', async () => {
      const anon = accountDir('anon', null);
      const execFileAsync = fakeKeychain({ [keychainServiceName(anon)]: sharedCreds });
      const pool = await buildCredentialPool([anon], { execFileAsync, platform: 'darwin' });
      expect(pool.size).toBe(0);
    });

    it('같은 configDir 을 두 번 줘도 키체인은 한 번만 읽는다', async () => {
      const a = accountDir('a', UUID);
      const execFileAsync = fakeKeychain({ [keychainServiceName(a)]: sharedCreds });
      await buildCredentialPool([a, a], { execFileAsync, platform: 'darwin' });
      expect(execFileAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('getAll 은 라운드당 풀을 한 번만 만든다', async () => {
    const d1 = accountDir('a', UUID);
    const d2 = accountDir('b', UUID);
    const def = defaultDir(UUID);
    const execFileAsync = fakeKeychain({ [keychainServiceName(def)]: sharedCreds });
    const backendsStore = { getRaw: () => ({ backends: {
      a: { type: 'claude-cli', configDir: d1 },
      b: { type: 'claude-cli', configDir: d2 }
    } }) };

    const reader = createBackendUsageReader({
      backendsStore, fetchImpl: okFetch(), execFileAsync, platform: 'darwin'
    });
    const out = await reader.getAll();

    expect(out.a.tokenSource).toBe('shared');
    expect(out.b.tokenSource).toBe('shared');
    // configDir 3개(a, b, 기본) 를 각각 1회씩만 조회
    expect(execFileAsync).toHaveBeenCalledTimes(3);
  });
});

describe('GET /api/backends/usage', () => {
  let app, backendsStore, tmpFile, configDir;

  beforeEach(async () => {
    configDir = makeConfigDir(liveCreds, { emailAddress: 'a@b.com' });
    tmpFile = path.join(os.tmpdir(), `backends-usage-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({
      version: 1,
      activeBackend: 'claude',
      backends: {
        claude: { type: 'claude-cli', label: 'Claude', configDir },
        zai: { type: 'anthropic-compatible', label: 'Z.AI', baseURL: 'https://api.z.ai', envKey: 'ZAI_API_KEY' }
      }
    }));
    backendsStore = await createBackendsStore(tmpFile);
    const usageReader = createBackendUsageReader({ backendsStore, fetchImpl: okFetch() });

    app = express();
    app.use(express.json());
    app.use('/api/backends', createBackendsRouter({ backendsStore, webConfig: {}, usageReader }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await backendsStore.close();
    try { fs.unlinkSync(tmpFile); } catch {}
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('백엔드별 정규화된 사용량을 반환한다', async () => {
    const res = await request(app).get('/api/backends/usage');
    expect(res.status).toBe(200);
    expect(res.body.backends.claude.status).toBe('ok');
    expect(res.body.backends.claude.fiveHour.utilization).toBe(74);
    expect(res.body.backends.zai.status).toBe('unsupported');
  });

  it('응답에 accessToken 이 새지 않는다', async () => {
    const res = await request(app).get('/api/backends/usage');
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
});
