import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { parseOccurrenceId } from '../lib/calendar-recurrence.js';

/** 캘린더 채팅 패널이 붙는 전용 에이전트/세션. */
const CALENDAR_AGENT_ID = 'cw_calendar';
const CALENDAR_SESSION_TITLE = '📅 캘린더';

const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(1000).optional(),
  until: z.string().max(10).nullable().optional(),
}).strict().nullable();

const eventFields = {
  title: z.string().min(1).max(200),
  start: z.string().min(1).max(40),
  end: z.string().max(40).nullable().optional(),
  allDay: z.boolean().optional(),
  notes: z.string().max(5000).optional(),
  location: z.string().max(200).optional(),
  color: z.string().max(16).nullable().optional(),
  tags: z.array(z.string()).optional(),
  projectId: z.string().max(64).nullable().optional(),
  agentId: z.string().max(64).nullable().optional(),
  source: z.enum(['user', 'agent']).optional(),
  recurrence: recurrenceSchema.optional(),
  exdates: z.array(z.string().max(10)).max(500).optional(),
  remindMinutes: z.array(z.number()).max(10).optional(),
};

const createSchema = z.object(eventFields).strict();
const patchSchema = z.object({
  ...eventFields,
  title: eventFields.title.optional(),
  start: eventFields.start.optional(),
}).strict();

export function createCalendarRouter({ calendarStore, eventBus, holidaysKr = null, sessionsStore = null, configStore = null }) {
  const router = Router();

  const publish = (action, event) => {
    if (eventBus) eventBus.publish('calendar.changed', { action, event });
  };

  router.get('/', (req, res, next) => {
    try {
      const { from, to } = req.query;
      res.json({ events: calendarStore.list({ from, to }) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/upcoming', (req, res, next) => {
    try {
      // days 의 범위 보정(1..90)은 store 가 담당한다.
      res.json({ events: calendarStore.upcoming({ days: req.query.days ?? 7 }) });
    } catch (err) {
      next(err);
    }
  });

  // 기본 범위는 올해 1/1 ~ 내년 12/31 — 월간 그리드가 연도 단위로 캐시하기 좋게.
  router.get('/holidays', (req, res, next) => {
    try {
      if (!holidaysKr) return res.json({ holidays: [] });
      const year = new Date().getFullYear();
      const from = req.query.from ?? `${year}-01-01`;
      const to = req.query.to ?? `${year + 1}-12-31`;
      res.json({ holidays: holidaysKr.getHolidays({ from, to }) });
    } catch (err) {
      next(err);
    }
  });

  // 캘린더 하단 채팅 패널용 세션. cw_calendar 의 전용 세션 하나를 재사용한다.
  router.get('/chat-session', async (req, res, next) => {
    try {
      if (!sessionsStore || !configStore) {
        throw new HttpError(503, 'Chat session store unavailable', 'CHAT_UNAVAILABLE');
      }
      if (!configStore.getAgent(CALENDAR_AGENT_ID)) {
        throw new HttpError(404, `Agent ${CALENDAR_AGENT_ID} not found`, 'AGENT_NOT_FOUND');
      }
      const existing = sessionsStore
        .list(CALENDAR_AGENT_ID)
        .find((s) => s.title === CALENDAR_SESSION_TITLE);
      if (existing) return res.json({ sessionId: existing.id, created: false });

      const session = await sessionsStore.create({
        agentId: CALENDAR_AGENT_ID,
        title: CALENDAR_SESSION_TITLE,
      });
      if (eventBus) eventBus.publish('session.created', { session });
      res.json({ sessionId: session.id, created: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = createSchema.parse(req.body);
      const event = await calendarStore.create(data);
      publish('create', event);
      res.status(201).json({ event });
    } catch (err) {
      next(toHttpError(err));
    }
  });

  // 발생분 id(`cal_x@2026-03-02`)가 와도 시리즈 전체에 적용된다 — store 가 정규화.
  router.patch('/:id', async (req, res, next) => {
    try {
      const data = patchSchema.parse(req.body);
      const event = await calendarStore.update(req.params.id, data);
      if (!event) throw new HttpError(404, `Event ${req.params.id} not found`, 'EVENT_NOT_FOUND');
      publish('update', event);
      res.json({ event });
    } catch (err) {
      next(toHttpError(err));
    }
  });

  // ?scope=occurrence → 그 회차만 빼고(exdates), 그 외에는 시리즈 전체 삭제.
  router.delete('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (req.query.scope === 'occurrence' && parseOccurrenceId(id)) {
        const master = await calendarStore.excludeOccurrence(id);
        if (!master) throw new HttpError(404, `Event ${id} not found`, 'EVENT_NOT_FOUND');
        publish('update', master);
        return res.json({ ok: true, scope: 'occurrence', event: master });
      }
      const event = calendarStore.get(id);
      const removed = await calendarStore.remove(id);
      if (!removed) throw new HttpError(404, `Event ${id} not found`, 'EVENT_NOT_FOUND');
      publish('delete', event);
      res.json({ ok: true, scope: 'series' });
    } catch (err) {
      next(toHttpError(err));
    }
  });

  return router;
}

/** zod 실패와 store 의 정규화 실패를 모두 400 INVALID_BODY 로 모은다. */
function toHttpError(err) {
  if (err?.name === 'ZodError') return new HttpError(400, 'Invalid body', 'INVALID_BODY');
  if (err?.code === 'INVALID') return new HttpError(400, err.message, 'INVALID_BODY');
  return err;
}
