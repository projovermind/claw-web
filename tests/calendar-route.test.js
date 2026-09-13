import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCalendarStore } from '../server/lib/calendar-store.js';
import { createCalendarRouter } from '../server/routes/calendar.js';
import { createEventBus } from '../server/lib/event-bus.js';
import { errorHandler } from '../server/middleware/error-handler.js';

/** sessionsStore 중 캘린더 라우터가 실제로 쓰는 부분만. */
function fakeSessionsStore(seed = []) {
  const sessions = [...seed];
  let n = 0;
  return {
    sessions,
    list: (agentId) => sessions.filter((s) => !agentId || s.agentId === agentId),
    create: async ({ agentId, title }) => {
      const session = { id: `s_${++n}`, agentId, title };
      sessions.push(session);
      return session;
    },
  };
}

describe('calendar route', () => {
  let app, store, eventBus, dir, events, sessionsStore;

  const holidaysKr = {
    getHolidays: ({ from, to } = {}) => [
      { date: '2026-01-01', name: '신정', substitute: false },
      { date: '2027-03-02', name: '삼일절 대체공휴일', substitute: true },
    ].filter((h) => (!from || h.date >= from) && (!to || h.date <= to)),
  };

  const configStore = { getAgent: (id) => (id === 'cw_calendar' ? { name: 'cw_calendar' } : null) };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-route-'));
    store = createCalendarStore(path.join(dir, 'calendar.json'));
    eventBus = createEventBus();
    events = [];
    eventBus.subscribe((e) => events.push(e));
    sessionsStore = fakeSessionsStore();
    app = express();
    app.use(express.json());
    app.use('/api/calendar', createCalendarRouter({
      calendarStore: store, eventBus, holidaysKr, sessionsStore, configStore,
    }));
    app.use(errorHandler);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const create = (body) => request(app).post('/api/calendar').send(body);

  describe('GET /holidays', () => {
    it('filters by from/to', async () => {
      const res = await request(app).get('/api/calendar/holidays?from=2027-01-01&to=2027-12-31');
      expect(res.status).toBe(200);
      expect(res.body.holidays).toEqual([{ date: '2027-03-02', name: '삼일절 대체공휴일', substitute: true }]);
    });

    it('defaults to this year through next year', async () => {
      const res = await request(app).get('/api/calendar/holidays');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.holidays)).toBe(true);
    });

    it('returns an empty list when the holiday source is unavailable', async () => {
      const bare = express();
      bare.use(express.json());
      bare.use('/api/calendar', createCalendarRouter({ calendarStore: store, eventBus }));
      bare.use(errorHandler);
      const res = await request(bare).get('/api/calendar/holidays');
      expect(res.body).toEqual({ holidays: [] });
    });
  });

  describe('GET /chat-session', () => {
    it('creates the cw_calendar session once and reuses it', async () => {
      const first = await request(app).get('/api/calendar/chat-session');
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ sessionId: 's_1', created: true });
      expect(sessionsStore.sessions[0]).toMatchObject({ agentId: 'cw_calendar', title: '📅 캘린더' });
      expect(events.some((e) => e.topic === 'session.created')).toBe(true);

      const second = await request(app).get('/api/calendar/chat-session');
      expect(second.body).toEqual({ sessionId: 's_1', created: false });
      expect(sessionsStore.sessions).toHaveLength(1);
    });

    it('ignores other sessions of the same agent', async () => {
      sessionsStore.sessions.push({ id: 's_other', agentId: 'cw_calendar', title: '[위임] 뭔가' });
      const res = await request(app).get('/api/calendar/chat-session');
      expect(res.body.sessionId).not.toBe('s_other');
    });

    it('404s when the cw_calendar agent is missing', async () => {
      const noAgent = express();
      noAgent.use(express.json());
      noAgent.use('/api/calendar', createCalendarRouter({
        calendarStore: store, eventBus, sessionsStore, configStore: { getAgent: () => null },
      }));
      noAgent.use(errorHandler);
      const res = await request(noAgent).get('/api/calendar/chat-session');
      expect(res.status).toBe(404);
    });
  });

  describe('recurrence over HTTP', () => {
    it('accepts recurrence / remindMinutes and lists the occurrences', async () => {
      const created = await create({
        title: '개학', start: '2026-03-02', allDay: true,
        recurrence: { freq: 'yearly', interval: 1, until: null },
        remindMinutes: [0, 1440],
      });
      expect(created.status).toBe(201);
      expect(created.body.event.recurrence).toEqual({ freq: 'yearly', interval: 1, until: null });
      expect(created.body.event.remindMinutes).toEqual([0, 1440]);

      const list = await request(app).get('/api/calendar?from=2026-01-01&to=2028-12-31');
      expect(list.body.events.map((e) => e.start)).toEqual(['2026-03-02', '2027-03-02', '2028-03-02']);
      expect(list.body.events[1]).toMatchObject({ isOccurrence: true, masterId: created.body.event.id });
    });

    it('rejects an invalid recurrence with 400', async () => {
      const res = await create({ title: 'x', start: '2026-03-02', recurrence: { freq: 'hourly' } });
      expect(res.status).toBe(400);
    });

    it('PATCH on an occurrence id updates the whole series', async () => {
      const { body } = await create({
        title: '주간회의', start: '2026-03-02T09:00:00+09:00', recurrence: { freq: 'weekly' },
      });
      const res = await request(app)
        .patch(`/api/calendar/${body.event.id}@2026-03-09`)
        .send({ title: '주간회의(변경)' });
      expect(res.status).toBe(200);
      expect(res.body.event).toMatchObject({ id: body.event.id, title: '주간회의(변경)' });
      expect(store.all()).toHaveLength(1);
    });

    it('DELETE ?scope=occurrence only adds an exdate', async () => {
      const { body } = await create({
        title: '데일리', start: '2026-03-02T09:00:00+09:00',
        recurrence: { freq: 'daily', until: '2026-03-05' },
      });
      const res = await request(app)
        .delete(`/api/calendar/${body.event.id}@2026-03-03?scope=occurrence`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, scope: 'occurrence' });
      expect(store.get(body.event.id).exdates).toEqual(['2026-03-03']);

      const list = await request(app).get('/api/calendar?from=2026-03-01&to=2026-03-31');
      expect(list.body.events.map((e) => e.start.slice(0, 10)))
        .toEqual(['2026-03-02', '2026-03-04', '2026-03-05']);
      expect(events.at(-1)).toMatchObject({ topic: 'calendar.changed' });
      expect(events.at(-1).payload.action).toBe('update');
    });

    it('DELETE without scope removes the whole series', async () => {
      const { body } = await create({
        title: '데일리', start: '2026-03-02T09:00:00+09:00', recurrence: { freq: 'daily' },
      });
      const res = await request(app).delete(`/api/calendar/${body.event.id}@2026-03-03`);
      expect(res.body).toMatchObject({ ok: true, scope: 'series' });
      expect(store.all()).toEqual([]);
    });

    it('404s when the occurrence scope targets a missing master', async () => {
      const res = await request(app).delete('/api/calendar/cal_deadbeef@2026-03-03?scope=occurrence');
      expect(res.status).toBe(404);
    });
  });
});
