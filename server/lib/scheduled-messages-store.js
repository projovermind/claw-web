/**
 * 메시지 예약 발송 — 20초마다 만기된 예약을 찾아 세션에 배달한다.
 *
 * 배달 자체는 chat 라우터가 소유한다. 같은 append→dispatch 경로를 타야 러너가
 * 깨어나기 때문인데, 그러면 store ← chat ← store 순환이 생긴다. 그래서 배달
 * 함수는 setDeliver() 로 늦게 묶는다.
 *
 * 서버가 꺼져 있는 동안 지나간 예약은 사라지지 않는다 — 만기 판정이
 * `runAt <= now` 라서 부팅 후 첫 tick 에 한꺼번에 나간다.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

const DEFAULT_INTERVAL_MS = 20 * 1000;

/** 사용자 입력을 항목 한 건으로 정규화. 잘못된 값이면 throw. */
function normalizeInput({ sessionId, content, runAt }) {
  const sid = String(sessionId ?? '').trim();
  if (!sid) throw new Error('sessionId is required');
  const body = String(content ?? '').trim();
  if (!body) throw new Error('content is required');
  const at = Date.parse(runAt);
  if (!Number.isFinite(at)) throw new Error(`runAt is not a valid date: ${runAt}`);
  return { sessionId: sid, content: body, runAt: new Date(at).toISOString() };
}

export function createScheduledMessagesStore({
  filePath,
  eventBus = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => Date.now(),
} = {}) {
  /** @type {Array<object>} */
  let items = [];
  /** @type {null | ((sessionId: string, content: string) => Promise<any>)} */
  let deliver = null;
  let timer = null;
  /** 이번 tick 이 느려도 다음 tick 이 같은 건을 또 집지 않게 하는 잠금. */
  const inFlight = new Set();
  let writeChain = Promise.resolve();

  function load() {
    try {
      if (!filePath || !fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed?.messages;
      items = Array.isArray(list) ? list.filter((m) => m?.id && m?.sessionId) : [];
    } catch (err) {
      logger.warn({ filePath, err: err.message }, 'scheduled-messages: state read failed');
      items = [];
    }
  }

  /** 쓰기를 직렬화한다 — 같은 tick 에서 여러 건이 끝나도 파일이 섞이지 않게. */
  function save() {
    if (!filePath) return writeChain;
    const snapshot = items.map((m) => ({ ...m }));
    writeChain = writeChain.then(async () => {
      try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify({ version: 1, messages: snapshot }, null, 2));
        await fsp.rename(tmp, filePath);
      } catch (err) {
        logger.warn({ filePath, err: err.message }, 'scheduled-messages: state write failed');
      }
    });
    return writeChain;
  }

  function publish(topic, payload) {
    try {
      eventBus?.publish?.(topic, payload);
    } catch (err) {
      logger.warn({ topic, err: err.message }, 'scheduled-messages: publish failed');
    }
  }

  load();

  /** 지금 시점에 나가야 할 pending 건. 지난 예약도 여기서 같이 잡힌다. */
  function due(nowMs) {
    return items
      .filter((m) => m.status === 'pending' && !inFlight.has(m.id) && Date.parse(m.runAt) <= nowMs)
      .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
  }

  async function sendOne(item, nowMs) {
    inFlight.add(item.id);
    try {
      if (!deliver) throw new Error('deliver is not wired');
      await deliver(item.sessionId, item.content);
      item.status = 'sent';
      item.sentAt = new Date(nowMs).toISOString();
      item.error = null;
      publish('scheduled.sent', { message: { ...item } });
      logger.info({ id: item.id, sessionId: item.sessionId }, 'scheduled-messages: sent');
    } catch (err) {
      item.status = 'failed';
      item.error = err?.message ?? String(err);
      publish('scheduled.sent', { message: { ...item } });
      logger.error(
        { id: item.id, sessionId: item.sessionId, err: item.error },
        'scheduled-messages: delivery failed'
      );
    } finally {
      inFlight.delete(item.id);
    }
  }

  async function runOnce(nowMs = now()) {
    const batch = due(nowMs);
    if (batch.length === 0) return { sent: 0, failed: 0, due: 0 };

    // 밀린 건들은 예약 시각 순으로 하나씩 — 같은 세션에 동시에 넣으면 순서가 뒤집힌다.
    for (const item of batch) await sendOne(item, nowMs);
    await save();

    const failed = batch.filter((m) => m.status === 'failed').length;
    return { sent: batch.length - failed, failed, due: batch.length };
  }

  return {
    list({ sessionId, status } = {}) {
      return items
        .filter((m) => (sessionId ? m.sessionId === sessionId : true))
        .filter((m) => (status ? m.status === status : true))
        .slice()
        .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
    },

    get(id) {
      return items.find((m) => m.id === id) ?? null;
    },

    async create(input) {
      const { sessionId, content, runAt } = normalizeInput(input);
      const item = {
        id: `sm_${randomUUID().slice(0, 8)}`,
        sessionId,
        content,
        runAt,
        status: 'pending',
        createdAt: new Date(now()).toISOString(),
        sentAt: null,
        error: null,
      };
      items.push(item);
      await save();
      publish('scheduled.updated', { action: 'create', message: { ...item } });
      return item;
    },

    /** 아직 안 나간 예약의 시각/본문만 고칠 수 있다. */
    async update(id, patch = {}) {
      const item = items.find((m) => m.id === id);
      if (!item) return null;
      if (item.status !== 'pending') throw new Error(`Cannot edit a ${item.status} message`);
      if (patch.runAt !== undefined) {
        const at = Date.parse(patch.runAt);
        if (!Number.isFinite(at)) throw new Error(`runAt is not a valid date: ${patch.runAt}`);
        item.runAt = new Date(at).toISOString();
      }
      if (patch.content !== undefined) {
        const body = String(patch.content).trim();
        if (!body) throw new Error('content is required');
        item.content = body;
      }
      await save();
      publish('scheduled.updated', { action: 'update', message: { ...item } });
      return item;
    },

    async cancel(id) {
      const item = items.find((m) => m.id === id);
      if (!item) return null;
      if (item.status !== 'pending') return item;
      item.status = 'canceled';
      await save();
      publish('scheduled.updated', { action: 'cancel', message: { ...item } });
      return item;
    },

    async remove(id) {
      const idx = items.findIndex((m) => m.id === id);
      if (idx === -1) return false;
      const [removed] = items.splice(idx, 1);
      await save();
      publish('scheduled.updated', { action: 'remove', message: { ...removed } });
      return true;
    },

    /** chat 라우터가 부팅 시 한 번 꽂는다. 이게 없으면 tick 이 전부 failed 로 떨어진다. */
    setDeliver(fn) {
      deliver = typeof fn === 'function' ? fn : null;
    },

    runOnce,

    start() {
      if (timer) return;
      timer = setInterval(() => {
        runOnce().catch((err) => logger.error({ err }, 'scheduled-messages: tick failed'));
      }, intervalMs);
      timer.unref?.();
      // 부팅 직후 한 번 — 서버가 꺼진 사이 지나간 예약을 여기서 흘려보낸다.
      runOnce().catch((err) => logger.error({ err }, 'scheduled-messages: boot tick failed'));
      logger.info({ intervalMs, pending: items.filter((m) => m.status === 'pending').length },
        'scheduled-messages: started');
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
