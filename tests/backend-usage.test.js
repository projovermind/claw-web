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
  createBackendUsageReader
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
