import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';

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
};

const createSchema = z.object(eventFields).strict();
const patchSchema = z.object({
  ...eventFields,
  title: eventFields.title.optional(),
  start: eventFields.start.optional(),
}).strict();

export function createCalendarRouter({ calendarStore, eventBus }) {
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

  router.delete('/:id', async (req, res, next) => {
    try {
      const event = calendarStore.get(req.params.id);
      const removed = await calendarStore.remove(req.params.id);
      if (!removed) throw new HttpError(404, `Event ${req.params.id} not found`, 'EVENT_NOT_FOUND');
      publish('delete', event);
      res.json({ ok: true });
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
