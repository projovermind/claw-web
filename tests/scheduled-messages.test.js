import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScheduledMessagesStore } from '../server/lib/scheduled-messages-store.js';

const T = (s) => Date.parse(s);
const NOW = T('2026-09-17T12:00:00+09:00');

describe('createScheduledMessagesStore', () => {
  let dir;
  let filePath;
  let delivered;
  let published;
  let eventBus;

  function makeStore({ deliver, now = () => NOW } = {}) {
    const store = createScheduledMessagesStore({ filePath, eventBus, now });
    store.setDeliver(
      deliver ??
        (async (sessionId, content) => {
          delivered.push({ sessionId, content });
          return { queued: false, queueLength: 0 };
        })
    );
    return store;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-msg-'));
    filePath = path.join(dir, 'scheduled-messages.json');
    delivered = [];
    published = [];
    eventBus = { publish: (topic, payload) => published.push({ topic, payload }) };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('만기 판정', () => {
    it('만기된 건만 보내고 미래 건은 남긴다', async () => {
      const store = makeStore();
      const past = await store.create({
        sessionId: 'sess_a', content: '지금 보내', runAt: '2026-09-17T11:59:00+09:00',
      });
      const future = await store.create({
        sessionId: 'sess_b', content: '나중에', runAt: '2026-09-17T13:00:00+09:00',
      });

      const result = await store.runOnce(NOW);

      expect(result).toEqual({ sent: 1, failed: 0, due: 1 });
      expect(delivered).toEqual([{ sessionId: 'sess_a', content: '지금 보내' }]);
      expect(store.get(past.id).status).toBe('sent');
      expect(store.get(past.id).sentAt).toBe(new Date(NOW).toISOString());
      expect(store.get(future.id).status).toBe('pending');
    });

    it('정확히 runAt === now 면 보낸다', async () => {
      const store = makeStore();
      await store.create({ sessionId: 'sess_a', content: 'x', runAt: '2026-09-17T12:00:00+09:00' });
      expect((await store.runOnce(NOW)).sent).toBe(1);
    });

    it('이미 보낸 건은 다음 tick 에 다시 안 보낸다', async () => {
      const store = makeStore();
      await store.create({ sessionId: 'sess_a', content: 'x', runAt: '2026-09-17T11:00:00+09:00' });
      await store.runOnce(NOW);
      const second = await store.runOnce(NOW + 60_000);
      expect(second.due).toBe(0);
      expect(delivered).toHaveLength(1);
    });

    it('배달이 실패하면 failed + error 로 남고 재발송하지 않는다', async () => {
      const store = makeStore({
        deliver: async () => { throw new Error('Session not found'); },
      });
      const item = await store.create({
        sessionId: 'sess_gone', content: 'x', runAt: '2026-09-17T11:00:00+09:00',
      });

      const result = await store.runOnce(NOW);

      expect(result).toEqual({ sent: 0, failed: 1, due: 1 });
      expect(store.get(item.id).status).toBe('failed');
      expect(store.get(item.id).error).toBe('Session not found');
      expect((await store.runOnce(NOW + 60_000)).due).toBe(0);
    });

    it('scheduled.sent 이벤트를 쏜다', async () => {
      const store = makeStore();
      const item = await store.create({
        sessionId: 'sess_a', content: 'x', runAt: '2026-09-17T11:00:00+09:00',
      });
      await store.runOnce(NOW);
      const sent = published.filter((e) => e.topic === 'scheduled.sent');
      expect(sent).toHaveLength(1);
      expect(sent[0].payload.message.id).toBe(item.id);
      expect(sent[0].payload.message.status).toBe('sent');
    });
  });

  describe('취소', () => {
    it('취소한 예약은 만기가 와도 안 나간다', async () => {
      const store = makeStore();
      const item = await store.create({
        sessionId: 'sess_a', content: 'x', runAt: '2026-09-17T11:00:00+09:00',
      });
      await store.cancel(item.id);

      expect(store.get(item.id).status).toBe('canceled');
      expect((await store.runOnce(NOW)).due).toBe(0);
      expect(delivered).toHaveLength(0);
    });

    it('이미 보낸 건을 취소해도 sent 로 남는다', async () => {
      const store = makeStore();
      const item = await store.create({
        sessionId: 'sess_a', content: 'x', runAt: '2026-09-17T11:00:00+09:00',
      });
      await store.runOnce(NOW);
      const after = await store.cancel(item.id);
      expect(after.status).toBe('sent');
    });

    it('없는 id 는 null', async () => {
      const store = makeStore();
      expect(await store.cancel('sm_nope')).toBeNull();
    });
  });

  describe('영속', () => {
    it('새 인스턴스가 pending 예약을 그대로 읽는다', async () => {
      const first = makeStore();
      const item = await first.create({
        sessionId: 'sess_a', content: '살아남아라', runAt: '2026-09-17T13:00:00+09:00',
      });
      first.stop();

      const second = makeStore();
      expect(second.list({ sessionId: 'sess_a' })).toHaveLength(1);
      expect(second.get(item.id)).toMatchObject({
        sessionId: 'sess_a', content: '살아남아라', status: 'pending',
      });
    });

    it('발송 결과도 디스크에 남는다', async () => {
      const first = makeStore();
      const item = await first.create({
        sessionId: 'sess_a', content: 'x', runAt: '2026-09-17T11:00:00+09:00',
      });
      await first.runOnce(NOW);
      first.stop();

      expect(makeStore().get(item.id).status).toBe('sent');
    });

    it('sessionId 로 필터한다', async () => {
      const store = makeStore();
      await store.create({ sessionId: 'sess_a', content: 'a', runAt: '2026-09-17T13:00:00+09:00' });
      await store.create({ sessionId: 'sess_b', content: 'b', runAt: '2026-09-17T14:00:00+09:00' });
      expect(store.list({ sessionId: 'sess_a' }).map((m) => m.content)).toEqual(['a']);
      expect(store.list().map((m) => m.content)).toEqual(['a', 'b']);
    });

    it('깨진 파일은 빈 목록으로 뜬다', () => {
      fs.writeFileSync(filePath, '{ not json');
      expect(makeStore().list()).toEqual([]);
    });
  });

  describe('서버가 꺼진 사이 지나간 예약', () => {
    it('부팅 첫 tick 에 즉시 나간다', async () => {
      const before = makeStore({ now: () => T('2026-09-16T09:00:00+09:00') });
      await before.create({
        sessionId: 'sess_a', content: '어제 걸어둔 것', runAt: '2026-09-17T03:00:00+09:00',
      });
      before.stop();

      // 서버 재시작 — 만기가 9시간 지난 상태에서 올라온다.
      const after = makeStore();
      const result = await after.runOnce(NOW);

      expect(result.sent).toBe(1);
      expect(delivered).toEqual([{ sessionId: 'sess_a', content: '어제 걸어둔 것' }]);
    });

    it('밀린 여러 건을 예약 시각 순서대로 보낸다', async () => {
      const store = makeStore();
      await store.create({ sessionId: 's', content: '두번째', runAt: '2026-09-17T10:00:00+09:00' });
      await store.create({ sessionId: 's', content: '첫번째', runAt: '2026-09-17T09:00:00+09:00' });
      store.stop();

      const rebooted = makeStore();
      await rebooted.runOnce(NOW);
      expect(delivered.map((d) => d.content)).toEqual(['첫번째', '두번째']);
    });
  });

  describe('입력 검증', () => {
    it('빈 본문/잘못된 시각은 거부한다', async () => {
      const store = makeStore();
      await expect(store.create({ sessionId: 's', content: '  ', runAt: '2026-09-17T13:00:00+09:00' }))
        .rejects.toThrow('content is required');
      await expect(store.create({ sessionId: '', content: 'x', runAt: '2026-09-17T13:00:00+09:00' }))
        .rejects.toThrow('sessionId is required');
      await expect(store.create({ sessionId: 's', content: 'x', runAt: 'tomorrow-ish' }))
        .rejects.toThrow(/not a valid date/);
    });

    it('pending 은 시각을 고칠 수 있고, 보낸 건은 못 고친다', async () => {
      const store = makeStore();
      const item = await store.create({
        sessionId: 's', content: 'x', runAt: '2026-09-17T11:00:00+09:00',
      });
      const moved = await store.update(item.id, { runAt: '2026-09-17T18:00:00+09:00' });
      expect(moved.runAt).toBe(new Date(T('2026-09-17T18:00:00+09:00')).toISOString());
      expect((await store.runOnce(NOW)).due).toBe(0);

      await store.update(item.id, { runAt: '2026-09-17T11:00:00+09:00' });
      await store.runOnce(NOW);
      await expect(store.update(item.id, { content: 'y' })).rejects.toThrow('Cannot edit a sent message');
    });
  });
});
