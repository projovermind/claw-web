import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';

const createSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().max(200).optional()
}).strict();

const updateSchema = z.object({
  title: z.string().max(200).optional(),
  claudeSessionId: z.string().nullable().optional(),
  pinned: z.boolean().optional()
}).strict();

const loopStartSchema = z.object({
  prompt: z.string().min(1).max(50000),
  maxIterations: z.number().min(1).max(100).optional().default(10),
  completionPromise: z.string().max(200).optional().default('DONE')
}).strict();

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(200)
}).strict();

export function createSessionsRouter({ sessionsStore, configStore, runner, eventBus }) {
  const router = Router();

  router.get('/', (req, res) => {
    const { agentId } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const all = sessionsStore.list(typeof agentId === 'string' ? agentId : undefined);
    // 최신 세션이 잘리지 않도록 updatedAt DESC 로 정렬 후 페이징.
    // (store 내부 Object.values 는 삽입 순서 = 생성 순. 세션이 limit 초과하면
    //  최근 세션들이 오래된 100개에 밀려 응답에서 완전히 누락되는 버그 방지.)
    all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const total = all.length;
    const paged = all.slice(offset, offset + limit);
    res.json({
      sessions: paged.map((s) => ({ ...s, isRunning: runner.isRunning(s.id) })),
      activeIds: runner.activeIds(),
      total,
      limit,
      offset,
    });
  });

  router.get('/:id', (req, res, next) => {
    const s = sessionsStore.get(req.params.id);
    if (!s) return next(new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND'));
    res.json({ ...s, isRunning: runner.isRunning(s.id) });
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
      if (runner.isRunning(req.params.id)) runner.abort(req.params.id);
      await sessionsStore.remove(req.params.id);
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
        if (runner.isRunning(id)) runner.abort(id);
        await sessionsStore.remove(id);
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
  // Creates a summary of the current session's messages, saves to a file,
  // then creates a new session with the summary as the first message.
  // This dramatically reduces token usage when context gets large.
  router.post('/:id/compact', async (req, res, next) => {
    try {
      const session = sessionsStore.get(req.params.id);
      if (!session) throw new HttpError(404, 'Session not found', 'SESSION_NOT_FOUND');
      if (!session.messages || session.messages.length === 0) {
        throw new HttpError(400, 'No messages to compact', 'EMPTY_SESSION');
      }

      // Build a compact summary from messages
      const msgs = session.messages;
      const lines = [];
      lines.push(`# 세션 요약 (${session.title})`);
      lines.push(`원본 세션: ${session.id}`);
      lines.push(`에이전트: ${session.agentId}`);
      lines.push(`메시지 수: ${msgs.length}`);
      lines.push(`기간: ${msgs[0]?.ts ?? '?'} ~ ${msgs[msgs.length - 1]?.ts ?? '?'}`);
      lines.push('');
      lines.push('## 대화 요약');
      lines.push('');

      // Include last N messages in full (most relevant recent context)
      const RECENT = 6;
      const older = msgs.slice(0, -RECENT);
      const recent = msgs.slice(-RECENT);

      // Older messages → compressed summary (just role + first 200 chars)
      if (older.length > 0) {
        lines.push(`### 이전 대화 (${older.length}개 메시지, 압축됨)`);
        for (const m of older) {
          const role = m.role === 'user' ? '👤' : '🤖';
          const content = (m.content ?? '').replace(/\n/g, ' ').slice(0, 200);
          lines.push(`- ${role} ${content}${(m.content ?? '').length > 200 ? '...' : ''}`);
        }
        lines.push('');
      }

      // Recent messages → kept in full
      lines.push(`### 최근 대화 (${recent.length}개 메시지, 전문)`);
      lines.push('');
      for (const m of recent) {
        const role = m.role === 'user' ? '👤 User' : '🤖 Assistant';
        lines.push(`#### ${role}`);
        lines.push(m.content ?? '');
        lines.push('');
      }

      // Key decisions / tool calls summary
      const toolCalls = msgs.flatMap((m) => m.toolCalls ?? []);
      if (toolCalls.length > 0) {
        lines.push('### 사용된 도구');
        const toolCounts = {};
        for (const tc of toolCalls) {
          toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
        }
        for (const [name, count] of Object.entries(toolCounts)) {
          lines.push(`- ${name}: ${count}회`);
        }
        lines.push('');
      }

      const summary = lines.join('\n');

      // Estimate token savings
      const originalChars = msgs.reduce((s, m) => s + (m.content ?? '').length, 0);
      const compactChars = summary.length;
      const savings = Math.round((1 - compactChars / Math.max(originalChars, 1)) * 100);

      // Create new session with the summary as first message
      const newSession = await sessionsStore.create({
        agentId: session.agentId,
        title: `${session.title} (compact)`
      });

      // Persist the summary as the first assistant message in the new session
      await sessionsStore.appendMessage(newSession.id, {
        role: 'user',
        content: `[이전 세션에서 이어짐]\n\n${summary}\n\n위는 이전 대화의 요약입니다. 이 맥락을 바탕으로 이어서 작업해주세요.`
      });

      // Copy the Claude session ID so the new session can --resume
      if (session.claudeSessionId) {
        // Don't copy — start fresh. The summary IS the context.
        // This is the whole point: avoid loading the full conversation.
      }

      if (eventBus) {
        eventBus.publish('session.compacted', {
          originalSessionId: session.id,
          newSessionId: newSession.id,
          originalMessages: msgs.length,
          compactChars,
          savings
        });
      }

      res.json({
        newSessionId: newSession.id,
        originalMessages: msgs.length,
        compactChars,
        originalChars,
        savings: `${savings}%`
      });
    } catch (err) {
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
      if (runner.isRunning(req.params.id)) runner.abort(req.params.id);
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
