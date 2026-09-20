import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import request from 'supertest';

import { createInstancesStore } from '../server/lib/instances-store.js';
import { createDelegationTracker } from '../server/lib/delegation-tracker.js';
import { createEventBus } from '../server/lib/event-bus.js';
import { createAuthMiddleware } from '../server/middleware/auth.js';
import { errorHandler } from '../server/middleware/error-handler.js';
import { createFederationRouter } from '../server/routes/federation.js';
import { createInstancesRouter } from '../server/routes/instances.js';
import { createHealthRouter } from '../server/routes/health.js';
import { createDelegation } from '../server/routes/chat/delegation.js';
import { createRemoteReport } from '../server/routes/chat/remote-report.js';
import { createFederationInbound } from '../server/routes/chat/federation-inbound.js';
import {
  compareVersions, supportsFederation, postCallback, CALLBACK_RETRY_DELAYS_MS
} from '../server/lib/federation-client.js';
import { getAppVersion } from '../server/lib/app-version.js';

/**
 * 크로스호스트 위임(인스턴스 연합) — docs/plans/cross-host-delegation.md 6절의
 * 성공 판정 1~6 을 그대로 고정한다.
 *
 * 핵심은 3번 **루프백**: selfPublicUrl 을 자기 자신으로 두고 인스턴스를 등록하면
 * 윈도우 기계 없이도 origin→remote→콜백 전 경로가 한 프로세스에서 검증된다.
 */

const UI_TOKEN = '930214';
const FED_TOKEN = 'fed-secret-token';

let dir;
let server;
let baseUrl;
let harness;

/** 아무도 듣지 않는 포트 — "원격이 죽어 있다" 를 만들기 위한 값. */
async function findClosedPort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 한 프로세스 안에 완전한 인스턴스 하나를 세운다. 위임 경로(delegation.js),
 * 회신 경로(remote-report.js), 접수 경로(federation-inbound.js), HTTP 표면이
 * 모두 실제 코드다. 가짜는 "워커 실행" 하나뿐이다.
 */
async function buildInstance({ workerReply = '작업 완료했습니다.', workerDelayMs = 5 } = {}) {
  const instancesStore = await createInstancesStore(path.join(dir, 'instances.json'));
  const delegationTracker = createDelegationTracker({
    filePath: path.join(dir, 'delegations.json'),
    reportsDir: path.join(dir, 'reports')
  });
  const eventBus = createEventBus();

  const sessions = new Map();
  let seq = 0;
  const sessionsStore = {
    create: async ({ agentId, title, ...extra }) => {
      const s = { id: `sess_${++seq}`, agentId, title, messages: [], ...extra };
      sessions.set(s.id, s);
      return s;
    },
    get: (id) => sessions.get(id) ?? null,
    update: async (id, patch) => { const s = sessions.get(id); if (s) Object.assign(s, patch); },
    appendMessage: async (id, msg) => { const s = sessions.get(id); if (s) s.messages.push(msg); }
  };

  const agents = {
    cw_lead: { name: 'lead' },
    cw_local: { name: 'local worker' },
    cw_remote: { name: 'remote worker', host: 'peer' },
    cw_nowhere: { name: 'broken', host: 'ghost' }
  };

  const dispatched = [];
  const ctx = {
    sessionsStore,
    configStore: { getAgent: (id) => agents[id] ?? null, getAgents: () => agents },
    metadataStore: { getAgent: () => ({}) },
    backendsStore: { getRaw: () => ({ tiers: { order: ['high', 'middle', 'low'] } }) },
    eventBus,
    delegationTracker,
    instancesStore,
    pushStore: null,
    agentQueue: new Map(),
    reEntryCounters: new Map(),
    MAX_REENTRY: 30,
    failureReEntryCounters: new Map(),
    MAX_FAILURE_REENTRY: 3,
    dequeueNextAgent: () => {},
    isSessionBusy: () => false,
    dispatch: (sessionId, item) => {
      dispatched.push({ sessionId, ...item });
      // 원격이 접수한 워커 세션이면 "워커가 돌아서 응답을 냈다" 를 흉내 낸다.
      // 실제 러너가 하듯 chat.done 을 쏘면 federation-inbound 가 콜백을 건다.
      if (item.kind === 'task' && sessions.get(sessionId)?.title?.startsWith('[원격위임]')) {
        setTimeout(() => eventBus.publish('chat.done', { sessionId, text: workerReply }), workerDelayMs);
      }
      return { queued: false, queueLength: 0 };
    }
  };

  const delegation = createDelegation(ctx);
  Object.assign(ctx, delegation);
  Object.assign(ctx, createRemoteReport(ctx));
  Object.assign(ctx, createFederationInbound(ctx));

  const webConfig = { auth: { enabled: true, token: UI_TOKEN } };
  const app = express();
  app.use(express.json());
  const hooks = {
    acceptRemoteDelegation: ctx.acceptRemoteDelegation,
    deliverRemoteResult: ctx.deliverRemoteResult
  };
  // 순서가 핵심: 연합 라우터가 UI 인증보다 **앞**이라 UI 토큰으로는 못 들어온다.
  app.use('/api/federation', createFederationRouter({ instancesStore, hooks }));
  app.use('/api', createAuthMiddleware({ webConfig }));
  // 진짜 헬스 라우터를 쓴다 — `federation: true` 선언이 빠지면 상대 인스턴스가
  // 우리를 연합 미지원으로 판정한다. 가짜로 덮으면 그 회귀를 못 잡는다.
  app.use('/api/health', createHealthRouter({ healthCheck: { check: async () => ({ ok: true }) } }));
  app.use('/api/instances', createInstancesRouter({ instancesStore, eventBus }));
  app.use(errorHandler);

  return { app, ctx, instancesStore, delegationTracker, sessionsStore, sessions, dispatched, eventBus };
}

/** 조건이 참이 될 때까지 기다린다. 콜백 경로가 비동기라 폴링이 필요하다. */
async function waitFor(fn, { timeoutMs = 4000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-federation-'));
  harness = await buildInstance();
  server = http.createServer(harness.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  harness?.ctx?.closeFederationInbound?.();
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 판정 1 ─────────────────────────────────────────────
describe('판정 1 — 인스턴스 레지스트리 관리 API', () => {
  it('등록한 인스턴스가 GET /api/instances 에 1개 이상 나온다', async () => {
    const created = await request(harness.app)
      .post('/api/instances')
      .set('Authorization', `Bearer ${UI_TOKEN}`)
      .send({ id: 'peer', label: '윈도우', baseUrl, token: FED_TOKEN, inboundToken: FED_TOKEN });
    expect(created.status).toBe(201);

    const res = await request(harness.app).get('/api/instances').set('Authorization', `Bearer ${UI_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.instances.length).toBeGreaterThanOrEqual(1);
    expect(res.body.instances[0].id).toBe('peer');
    // 토큰 원문은 절대 나가지 않는다 — 설정 여부만.
    expect(res.body.instances[0].token).toBeUndefined();
    expect(res.body.instances[0].tokenSet).toBe(true);
    expect(res.body.instances[0].inboundTokenSet).toBe(true);
  });

  it('PATCH 로 enabled 를 끄고 DELETE 로 지운다 (인바운드 토큰도 함께 사라진다)', async () => {
    const auth = { Authorization: `Bearer ${UI_TOKEN}` };
    await request(harness.app).post('/api/instances').set(auth)
      .send({ id: 'peer', baseUrl, token: FED_TOKEN, inboundToken: FED_TOKEN });

    const patched = await request(harness.app).patch('/api/instances/peer').set(auth).send({ enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.enabled).toBe(false);

    expect(harness.instancesStore.verifyInbound('peer', FED_TOKEN)).toBe(true);
    await request(harness.app).delete('/api/instances/peer').set(auth).expect(200);
    expect(harness.instancesStore.verifyInbound('peer', FED_TOKEN)).toBe(false);
    const after = await request(harness.app).get('/api/instances').set(auth);
    expect(after.body.instances).toHaveLength(0);
  });
});

// ── 판정 2 ─────────────────────────────────────────────
describe('판정 2 — 즉시 헬스체크', () => {
  it('원격 /api/health 의 version 이 응답에 담긴다', async () => {
    const auth = { Authorization: `Bearer ${UI_TOKEN}` };
    await request(harness.app).post('/api/instances').set(auth)
      .send({ id: 'peer', baseUrl, token: FED_TOKEN, inboundToken: FED_TOKEN });

    const res = await request(harness.app).post('/api/instances/peer/health').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.health.ok).toBe(true);
    expect(res.body.health.version).toBe(getAppVersion());
    expect(res.body.health.federation).toBe(true);
    expect(typeof res.body.health.latencyMs).toBe('number');

    // 저장까지 돼야 위임 직전 게이트가 다시 찍지 않는다.
    expect(harness.instancesStore.getInstance('peer').health.version).toBe(getAppVersion());
  });

  it('연합 미지원(구버전) 인스턴스는 버전으로 걸러진다', () => {
    expect(compareVersions('1.21.0', '1.20.0')).toBe(1);
    expect(compareVersions('1.17.75', '1.21.0')).toBe(-1);
    // 윈도우 v1.17.75 — federation 필드 자체가 없는 구버전
    expect(supportsFederation({ ok: true, version: '1.17.75' })).toBe(false);
    expect(supportsFederation({ ok: true, version: '1.21.0' })).toBe(true);
    // 명시 선언이 있으면 버전과 무관하게 지원으로 본다
    expect(supportsFederation({ ok: true, version: '1.20.0', federation: true })).toBe(true);
    expect(supportsFederation({ ok: false, version: '2.0.0' })).toBe(false);
  });
});

// ── 판정 3 (핵심) ──────────────────────────────────────
describe('판정 3 — 루프백 연합 위임', () => {
  /** selfPublicUrl 을 자기 자신으로 두고 peer 인스턴스도 자기 자신을 가리키게 한다. */
  async function wireLoopback() {
    const auth = { Authorization: `Bearer ${UI_TOKEN}` };
    await request(harness.app).patch('/api/instances/_self').set(auth)
      .send({ selfId: 'mac', selfPublicUrl: baseUrl }).expect(200);
    await request(harness.app).post('/api/instances').set(auth)
      .send({ id: 'peer', label: '루프백', baseUrl, token: FED_TOKEN, inboundToken: FED_TOKEN }).expect(201);
    // 루프백에서는 origin 이 스스로를 'mac' 이라 부르므로(selfId) 인바운드 토큰도
    // 'mac' 으로 잡혀야 한다 — 등록한 인스턴스 id('peer')와 갈리는 유일한 경우.
    await request(harness.app).put('/api/instances/inbound-tokens/mac').set(auth)
      .send({ token: FED_TOKEN }).expect(200);
  }

  it('원격 경로를 타고 세션이 뜨고 콜백이 돌아와 보고 턴이 1회 열린다', async () => {
    await wireLoopback();
    const origin = await harness.sessionsStore.create({ agentId: 'cw_lead', title: 'plan' });

    await harness.ctx.executeDelegation(origin.id, 'cw_remote', '원격에서 빌드해 줘', '{}');

    // (a) 원격 경로를 탔다 — 트래커에 remote 레코드가 생긴다
    const entry = harness.delegationTracker.getByOrigin(origin.id)[0];
    expect(entry.kind).toBe('remote');
    expect(entry.remoteInstance).toBe('peer');
    expect(entry.targetSessionId).toMatch(/^rdel_/);

    // (b) 원격 쪽에 실제 워커 세션이 떴다
    const remoteSession = [...harness.sessions.values()].find((s) => s.title?.startsWith('[원격위임]'));
    expect(remoteSession).toBeTruthy();
    expect(remoteSession.agentId).toBe('cw_remote');
    expect(entry.remoteSessionId).toBe(remoteSession.id);
    // 파일 비공유 제약이 task 에 주입된다
    expect(remoteSession.messages[0].content).toContain('커밋·푸시로만 전달됩니다');

    // (c) 콜백이 돌아와 origin 에 보고 턴이 **1회** 열린다
    const reports = await waitFor(() => {
      const r = harness.dispatched.filter((d) => d.sessionId === origin.id && d.kind === 'report');
      return r.length ? r : null;
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].content).toContain('원격 위임 결과 보고');
    expect(reports[0].content).toContain('작업 완료했습니다.');

    // (d) 트래커가 완료로 닫혔다 — 대상 에이전트가 busy 로 남지 않는다
    const settled = harness.delegationTracker.listRecent(5)[0];
    expect(settled.status).toBe('completed');
    expect(harness.delegationTracker.isAgentBusy('cw_remote')).toBe(false);

    // 여유를 두고 다시 세도 여전히 1회 — 콜백이 중복 보고를 만들지 않는다
    await new Promise((r) => setTimeout(r, 120));
    expect(harness.dispatched.filter((d) => d.sessionId === origin.id && d.kind === 'report')).toHaveLength(1);
    // remote 측 대기 목록도 비워진다 — 안 비우면 세션마다 콜백 정보가 샌다
    expect(harness.ctx.pendingRemoteCount()).toBe(0);
  });

  it('워커의 <escalate> 는 원격 회신에서도 리드에게 그대로 전달된다', async () => {
    harness?.ctx?.closeFederationInbound?.();
    await new Promise((resolve) => server.close(resolve));
    harness = await buildInstance({ workerReply: '막혔습니다 <escalate>컨텍스트가 부족합니다</escalate>' });
    server = http.createServer(harness.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    await wireLoopback();

    const origin = await harness.sessionsStore.create({ agentId: 'cw_lead', title: 'plan' });
    await harness.ctx.executeDelegation(origin.id, 'cw_remote', '어려운 작업', '{}');

    const report = await waitFor(() =>
      harness.dispatched.find((d) => d.sessionId === origin.id && d.kind === 'report') ?? null
    );
    expect(report.content).toContain('에스컬레이션');
    expect(report.content).toContain('컨텍스트가 부족합니다');
    expect(harness.delegationTracker.listRecent(5)[0].escalated).toBe(true);
  });

  it('알 수 없는 에이전트로 들어온 연합 요청은 unknown_agent 로 거절된다', async () => {
    await wireLoopback();
    const res = await request(harness.app)
      .post('/api/federation/delegate')
      .set('Authorization', `Bearer ${FED_TOKEN}`)
      .set('X-Claw-Origin', 'peer')
      .send({ delegationId: 'rdel_x', agent: '존재하지_않음', task: 'x', callbackUrl: `${baseUrl}/api/federation/result` });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ accepted: false, error: 'unknown_agent' });
  });

  it('등록된 baseUrl 과 다른 곳으로 회신하라는 요청은 거절된다', async () => {
    await wireLoopback();
    const res = await request(harness.app)
      .post('/api/federation/delegate')
      .set('Authorization', `Bearer ${FED_TOKEN}`)
      .set('X-Claw-Origin', 'peer')
      .send({ delegationId: 'rdel_y', agent: 'cw_remote', task: 'x', callbackUrl: 'http://evil.example/api/federation/result' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_callback');
  });

  it('모르는 delegationId 콜백은 404 — 원격이 재시도를 멈춘다', async () => {
    await wireLoopback();
    const res = await request(harness.app)
      .post('/api/federation/result')
      .set('Authorization', `Bearer ${FED_TOKEN}`)
      .set('X-Claw-Origin', 'peer')
      .send({ delegationId: 'rdel_없는것', status: 'completed', result: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_delegation');
  });
});

// ── 판정 4 ─────────────────────────────────────────────
describe('판정 4 — host 없는 기존 위임은 동작이 변하지 않는다', () => {
  it('로컬 에이전트는 레지스트리를 거치지 않고 로컬 세션을 띄운다', async () => {
    const auth = { Authorization: `Bearer ${UI_TOKEN}` };
    await request(harness.app).patch('/api/instances/_self').set(auth)
      .send({ selfId: 'mac', selfPublicUrl: baseUrl }).expect(200);
    await request(harness.app).post('/api/instances').set(auth)
      .send({ id: 'peer', baseUrl, token: FED_TOKEN, inboundToken: FED_TOKEN }).expect(201);

    const origin = await harness.sessionsStore.create({ agentId: 'cw_lead', title: 'plan' });
    await harness.ctx.executeDelegation(origin.id, 'cw_local', '로컬 작업', '{}');

    const entry = harness.delegationTracker.getByOrigin(origin.id)[0];
    expect(entry.kind).toBe('local');
    expect(entry.remoteInstance).toBeNull();
    // 로컬 워커 세션이 생기고 task 가 디스패치된다 (기존 경로 그대로)
    const worker = harness.sessions.get(entry.targetSessionId);
    expect(worker.agentId).toBe('cw_local');
    expect(harness.dispatched.some((d) => d.sessionId === worker.id && d.kind === 'task')).toBe(true);
    // host 가 없으니 원격 제약 안내도 붙지 않는다
    expect(worker.messages[0].content).not.toContain('커밋·푸시로만');
  });

  it('host 가 selfId 와 같으면 로컬이다', async () => {
    await harness.instancesStore.setSelf({ selfId: 'peer' });
    expect(harness.ctx.resolveHost('cw_remote')).toEqual({ remote: false });
  });

  it('모르는 host 는 조용히 로컬 폴백하지 않고 실패로 회신된다', async () => {
    await harness.instancesStore.setSelf({ selfId: 'mac', selfPublicUrl: baseUrl });
    const origin = await harness.sessionsStore.create({ agentId: 'cw_lead', title: 'plan' });
    await harness.ctx.executeDelegation(origin.id, 'cw_nowhere', '어디로?', '{}');

    expect(harness.delegationTracker.getByOrigin(origin.id)).toHaveLength(0);
    const report = harness.dispatched.find((d) => d.sessionId === origin.id && d.kind === 'report');
    expect(report.content).toContain('원격 위임 실패');
    expect(report.content).toContain('unknown_host');
  });
});

// ── 판정 5 ─────────────────────────────────────────────
describe('판정 5 — 연합 엔드포인트는 UI 토큰을 받지 않는다', () => {
  const body = { delegationId: 'rdel_z', agent: 'cw_remote', task: 'x', callbackUrl: 'http://127.0.0.1/api/federation/result' };

  it('UI 토큰(930214)으로 /delegate 접근 → 401', async () => {
    const res = await request(harness.app)
      .post('/api/federation/delegate')
      .set('Authorization', `Bearer ${UI_TOKEN}`)
      .set('X-Claw-Origin', 'peer')
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('UI 토큰으로 /result 접근 → 401', async () => {
    const res = await request(harness.app)
      .post('/api/federation/result')
      .set('Authorization', `Bearer ${UI_TOKEN}`)
      .set('X-Claw-Origin', 'peer')
      .send({ delegationId: 'rdel_z', status: 'completed', result: 'x' });
    expect(res.status).toBe(401);
  });

  it('연합 토큰이 맞아도 X-Claw-Origin 이 없으면 401', async () => {
    await harness.instancesStore.createInstance('peer', { baseUrl, token: FED_TOKEN, inboundToken: FED_TOKEN });
    const res = await request(harness.app)
      .post('/api/federation/delegate')
      .set('Authorization', `Bearer ${FED_TOKEN}`)
      .send(body);
    expect(res.status).toBe(401);
  });

  it('X-Claw-Origin 이 등록되지 않은 인스턴스면 401', async () => {
    await harness.instancesStore.createInstance('peer', { baseUrl, token: FED_TOKEN, inboundToken: FED_TOKEN });
    const res = await request(harness.app)
      .post('/api/federation/delegate')
      .set('Authorization', `Bearer ${FED_TOKEN}`)
      .set('X-Claw-Origin', 'nobody')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('반대로 연합 토큰으로는 UI API 에 들어갈 수 없다', async () => {
    const res = await request(harness.app).get('/api/instances').set('Authorization', `Bearer ${FED_TOKEN}`);
    expect(res.status).toBe(401);
  });
});

// ── 판정 6 ─────────────────────────────────────────────
describe('판정 6 — 원격이 죽어 있으면 5초 이내 실패 회신', () => {
  it('무한 pending 없이 리드에게 실패가 돌아온다', async () => {
    const deadPort = await findClosedPort();
    await harness.instancesStore.setSelf({ selfId: 'mac', selfPublicUrl: baseUrl });
    await harness.instancesStore.createInstance('peer', {
      label: '죽은 기계',
      baseUrl: `http://127.0.0.1:${deadPort}`,
      token: FED_TOKEN
    });

    const origin = await harness.sessionsStore.create({ agentId: 'cw_lead', title: 'plan' });
    const startedAt = Date.now();
    await harness.ctx.executeDelegation(origin.id, 'cw_remote', '원격 작업', '{}');
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(5000);
    const report = harness.dispatched.find((d) => d.sessionId === origin.id && d.kind === 'report');
    expect(report).toBeTruthy();
    expect(report.content).toContain('원격 위임 실패');
    expect(report.content).toContain('unreachable');
    // running 으로 남지 않는다 — 대상 에이전트가 영영 busy 로 잡히면 안 된다
    expect(harness.delegationTracker.list()).toHaveLength(0);
    expect(harness.delegationTracker.isAgentBusy('cw_remote')).toBe(false);
  }, 10_000);

  it('selfPublicUrl 이 비어 있으면 아예 발주하지 않는다 (콜백 받을 주소가 없다)', async () => {
    await harness.instancesStore.setSelf({ selfId: 'mac', selfPublicUrl: null });
    await harness.instancesStore.createInstance('peer', { baseUrl, token: FED_TOKEN });

    const origin = await harness.sessionsStore.create({ agentId: 'cw_lead', title: 'plan' });
    await harness.ctx.executeDelegation(origin.id, 'cw_remote', '작업', '{}');

    const report = harness.dispatched.find((d) => d.sessionId === origin.id && d.kind === 'report');
    expect(report.content).toContain('no_self_public_url');
    expect(harness.delegationTracker.list()).toHaveLength(0);
  });

  it('비활성화된 인스턴스로는 위임하지 않는다', async () => {
    await harness.instancesStore.setSelf({ selfId: 'mac', selfPublicUrl: baseUrl });
    await harness.instancesStore.createInstance('peer', { baseUrl, token: FED_TOKEN, enabled: false });

    const origin = await harness.sessionsStore.create({ agentId: 'cw_lead', title: 'plan' });
    await harness.ctx.executeDelegation(origin.id, 'cw_remote', '작업', '{}');

    const report = harness.dispatched.find((d) => d.sessionId === origin.id && d.kind === 'report');
    expect(report.content).toContain('disabled');
  });
});

// ── 콜백 재시도 계약 ────────────────────────────────────
describe('콜백 재시도 — 5s / 30s / 120s, 최대 3회', () => {
  it('5xx 는 스펙 간격으로 3번 더 시도하고 포기한다', async () => {
    const slept = [];
    let calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { calls++; return new Response('{}', { status: 503 }); };
    try {
      const out = await postCallback({
        callbackUrl: 'http://127.0.0.1/api/federation/result',
        token: FED_TOKEN,
        originId: 'win',
        body: { delegationId: 'rdel_a', status: 'completed', result: 'x' },
        sleep: async (ms) => { slept.push(ms); }
      });
      expect(out.delivered).toBe(false);
      expect(calls).toBe(4); // 최초 1 + 재시도 3
      expect(slept).toEqual(CALLBACK_RETRY_DELAYS_MS);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('4xx 는 재시도하지 않는다 — 자격/대상 문제는 기다려도 안 바뀐다', async () => {
    let calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { calls++; return new Response('{}', { status: 404 }); };
    try {
      const out = await postCallback({
        callbackUrl: 'http://127.0.0.1/api/federation/result',
        token: FED_TOKEN,
        originId: 'win',
        body: { delegationId: 'rdel_b', status: 'completed', result: 'x' },
        sleep: async () => { throw new Error('재시도하면 안 된다'); }
      });
      expect(out.delivered).toBe(false);
      expect(out.error).toBe('HTTP 404');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
