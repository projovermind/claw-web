import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { compactSession } from '../lib/compact.js';

const createSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().max(200).optional()
}).strict();

const updateSchema = z.object({
  title: z.string().max(200).optional(),
  claudeSessionId: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
  // 세션별 모델 별칭 오버라이드. null → 에이전트 기본 모델을 따름.
  model: z.string().max(64).nullable().optional()
}).strict();

const loopStartSchema = z.object({
  prompt: z.string().min(1).max(50000),
  maxIterations: z.number().min(1).max(100).optional().default(10),
  completionPromise: z.string().max(200).optional().default('DONE')
}).strict();

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(200)
}).strict();

export function createSessionsRouter({ sessionsStore, configStore, runner, eventBus, approvalBroker, abortDispatch, abandonDelegation }) {
  const router = Router();

  /**
   * Stop a session for good: kill the current turn *and* drop whatever the
   * dispatch queue still has pending, or the queue would immediately start the
   * next item on a session the user just deleted/stopped.
   */
  function lastActivityIso(sessionId) {
    const ms = runner.lastActivityAt?.(sessionId);
    return ms ? new Date(ms).toISOString() : null;
  }

  function stopSession(sessionId, reason) {
    if (runner.isRunning(sessionId)) runner.abort(sessionId);
    abandonDelegation?.(sessionId, reason);
    abortDispatch?.(sessionId, reason);
  }

  // GET /api/sessions — meta only (no messages). Returns messageCount and
  // recent24hCount per session so the dashboard can render activity without
  // downloading every message. Response size stays in KB even with hundreds
  // of sessions (previously: tens of MB).
  router.get('/', (req, res) => {
    const { agentId } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const all = sessionsStore.list(typeof agentId === 'string' ? agentId : undefined);
    // 최신 세션이 잘리지 않도록 updatedAt DESC 로 정렬 후 페이징.
    all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const total = all.length;
    const paged = all.slice(offset, offset + limit);
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    const sessions = paged.map((s) => {
      // eslint-disable-next-line no-unused-vars
      const { messages, ...meta } = s;
      const msgs = Array.isArray(messages) ? messages : [];
      let recent24hCount = 0;
      for (const m of msgs) {
        if (!m?.ts) continue;
        const t = new Date(m.ts).getTime();
        if (!Number.isNaN(t) && t >= cutoff24h) recent24hCount += 1;
      }
      return {
        ...meta,
        messageCount: msgs.length,
        recent24hCount,
        isRunning: runner.isRunning(s.id),
        lastActivityAt: lastActivityIso(s.id),
      };
    });
    res.json({
      sessions,
      activeIds: runner.activeIds(),
      total,
      limit,
      offset,
    });
  });

  // GET /api/sessions/:id?limit=<n>
  // Returns the session with only the most recent `limit` messages (default 50).
  // `hasMoreBefore` signals the client that older messages are available via
  // GET /api/sessions/:id/messages?before=<ts>.
  router.get('/:id', (req, res, next) => {
    const s = sessionsStore.get(req.params.id);
    if (!s) return next(new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND'));
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const all = Array.isArray(s.messages) ? s.messages : [];
    const sliced = all.slice(-limit);
    const hasMoreBefore = sliced.length < all.length;
    // Token totals aggregated across ALL messages (not just the sliced tail) so
    // the header badge stays accurate after pagination.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const m of all) {
      totalInputTokens += m?.usage?.inputTokens ?? 0;
      totalOutputTokens += m?.usage?.outputTokens ?? 0;
    }
    res.json({
      ...s,
      messages: sliced,
      hasMoreBefore,
      totalMessageCount: all.length,
      totalInputTokens,
      totalOutputTokens,
      isRunning: runner.isRunning(s.id),
      lastActivityAt: lastActivityIso(s.id),
    });
  });

  // GET /api/sessions/:id/messages?before=<ts>&limit=<n>
  // Returns up to `limit` messages strictly older than `before` (ISO ts).
  // Used by the chat UI's infinite-scroll-up to load earlier history.
  router.get('/:id/messages', (req, res, next) => {
    const s = sessionsStore.get(req.params.id);
    if (!s) return next(new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND'));
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const all = Array.isArray(s.messages) ? s.messages : [];
    const older = before ? all.filter((m) => (m?.ts ?? '') < before) : all;
    const sliced = older.slice(-limit);
    const hasMoreBefore = sliced.length < older.length;
    res.json({ messages: sliced, hasMoreBefore });
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = createSchema.parse(req.body);
      if (!configStore.getAgent(data.agentId)) {
        throw new HttpError(404, `Agent ${data.agentId} not found`, 'AGENT_NOT_FOUND');
      }
      const session = await sessionsStore.create(data);
      if (eventBus) eventBus.publish('session.created', { session });
      res.status(201).json(session);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const data = updateSchema.parse(req.body);
      if (!sessionsStore.get(req.params.id)) {
        throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      }
      const updated = await sessionsStore.update(req.params.id, data);
      if (eventBus) eventBus.publish('session.updated', { session: updated });
      res.json(updated);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (!sessionsStore.get(req.params.id)) {
        throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      }
      stopSession(req.params.id, 'session deleted');
      await sessionsStore.remove(req.params.id);
      approvalBroker?.clearAllowlistForSession?.(req.params.id);
      if (eventBus) eventBus.publish('session.deleted', { sessionId: req.params.id });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Bulk delete: POST /api/sessions/bulk-delete { ids: [...] }
  // Aborts any running runs, removes each session, returns counts. Unknown IDs
  // are ignored (reported as skipped) rather than failing the whole batch.
  router.post('/bulk-delete', async (req, res, next) => {
    try {
      const { ids } = bulkDeleteSchema.parse(req.body);
      let deleted = 0;
      let skipped = 0;
      for (const id of ids) {
        if (!sessionsStore.get(id)) {
          skipped += 1;
          continue;
        }
        stopSession(id, 'session deleted');
        await sessionsStore.remove(id);
        approvalBroker?.clearAllowlistForSession?.(id);
        if (eventBus) eventBus.publish('session.deleted', { sessionId: id });
        deleted += 1;
      }
      res.json({ deleted, skipped, total: ids.length });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // Export: GET /api/sessions/:id/export?format=md|json
  // Returns the session rendered as markdown or as raw JSON.
  router.get('/:id/export', (req, res, next) => {
    try {
      const session = sessionsStore.get(req.params.id);
      if (!session) {
        throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      }
      const format = req.query.format === 'md' ? 'md' : 'json';
      const safeTitle = (session.title ?? session.id)
        .replace(/[^a-zA-Z0-9가-힣\-_\s]/g, '')
        .slice(0, 60)
        .trim() || session.id;

      if (format === 'md') {
        const lines = [];
        lines.push(`# ${session.title ?? session.id}`);
        lines.push('');
        lines.push(`- Session ID: \`${session.id}\``);
        lines.push(`- Agent: \`${session.agentId}\``);
        lines.push(`- Created: ${session.createdAt}`);
        lines.push(`- Updated: ${session.updatedAt}`);
        if (session.claudeSessionId) {
          lines.push(`- Claude session: \`${session.claudeSessionId}\``);
        }
        lines.push('');
        lines.push('---');
        lines.push('');
        for (const msg of session.messages ?? []) {
          const role = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
          lines.push(`## ${role}${msg.model ? ` (${msg.model})` : ''}`);
          if (msg.ts) lines.push(`_${msg.ts}_`);
          lines.push('');
          lines.push(msg.content ?? '');
          if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
            lines.push('');
            lines.push('**Tool calls:**');
            for (const tc of msg.toolCalls) {
              lines.push(`- \`${tc.name}\``);
            }
          }
          lines.push('');
          lines.push('---');
          lines.push('');
        }
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${safeTitle}.md"`
        );
        res.send(lines.join('\n'));
      } else {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${safeTitle}.json"`
        );
        res.send(JSON.stringify(session, null, 2));
      }
    } catch (err) {
      next(err);
    }
  });

  // ── Compact: compress conversation context ──
  // POST /api/sessions/:id/compact
  // Summarizes the session's messages into a brand-new session seeded with that
  // summary. Shared with the chat route's automatic compaction (lib/compact.js).
  router.post('/:id/compact', async (req, res, next) => {
    try {
      const session = sessionsStore.get(req.params.id);
      if (!session) throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      const result = await compactSession({ session, sessionsStore, eventBus });
      res.json({ ...result, savings: `${result.savings}%` });
    } catch (err) {
      if (err.code === 'EMPTY_SESSION') {
        return next(new HttpError(400, 'No messages to compact', 'EMPTY_SESSION'));
      }
      next(err);
    }
  });

  // ── Ralph Loop: start/stop autonomous iteration ──

  // POST /api/sessions/:id/loop — start a Ralph Loop
  // Stores loop config in session metadata. The chat route's onResult callback
  // checks this config and auto-sends the next iteration if the completion
  // promise hasn't been detected.
  router.post('/:id/loop', async (req, res, next) => {
    try {
      const session = sessionsStore.get(req.params.id);
      if (!session) throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      const config = loopStartSchema.parse(req.body);
      await sessionsStore.update(req.params.id, {
        loop: {
          enabled: true,
          prompt: config.prompt,
          maxIterations: config.maxIterations,
          completionPromise: config.completionPromise,
          currentIteration: 0,
          startedAt: new Date().toISOString()
        }
      });
      if (eventBus) eventBus.publish('session.loop.started', { sessionId: req.params.id });
      res.json({ sessionId: req.params.id, loop: 'started', maxIterations: config.maxIterations });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // DELETE /api/sessions/:id/loop — stop an active Ralph Loop
  router.delete('/:id/loop', async (req, res, next) => {
    try {
      const session = sessionsStore.get(req.params.id);
      if (!session) throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      const loop = session.loop;
      await sessionsStore.update(req.params.id, { loop: null });
      stopSession(req.params.id, 'loop stopped');
      if (eventBus) eventBus.publish('session.loop.stopped', {
        sessionId: req.params.id,
        iterations: loop?.currentIteration ?? 0
      });
      res.json({ sessionId: req.params.id, loop: 'stopped', iterations: loop?.currentIteration ?? 0 });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
