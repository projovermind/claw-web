import { Router } from 'express';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/error-handler.js';

/**
 * Background tasks — long-running bash commands that run asynchronously.
 *
 * POST   /api/tasks        { sessionId, command, cwd? } → start task
 * GET    /api/tasks        → list running + recent tasks
 * GET    /api/tasks/:id    → task detail (stdout, stderr, status, exitCode)
 * DELETE /api/tasks/:id    → kill running task
 */
export function createTasksRouter({ eventBus }) {
  const router = Router();

  /** @type {Map<string, object>} */
  const tasks = new Map();

  // Trim completed tasks older than 1 hour every 5 minutes
  setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, t] of tasks) {
      if (t.status !== 'running' && t.completedAt && new Date(t.completedAt).getTime() < cutoff) {
        tasks.delete(id);
      }
    }
  }, 5 * 60 * 1000);

  // POST /  — start a new background task
  router.post('/', (req, res, next) => {
    try {
      const { sessionId, command, cwd } = req.body;
      if (!command || typeof command !== 'string') {
        throw new HttpError(400, 'command is required', 'MISSING_COMMAND');
      }

      const id = `task_${randomUUID().slice(0, 8)}`;
      const task = {
        id,
        sessionId: sessionId || null,
        command,
        cwd: cwd || process.cwd(),
        pid: null,
        status: 'running',
        stdout: '',
        stderr: '',
        exitCode: null,
        startedAt: new Date().toISOString(),
        completedAt: null
      };

      const child = spawn(command, {
        shell: true,
        cwd: task.cwd,
        env: { ...process.env }
      });

      task.pid = child.pid || null;
      tasks.set(id, task);

      child.stdout.on('data', (chunk) => {
        task.stdout += chunk.toString();
        // Cap stdout at 1MB
        if (task.stdout.length > 1024 * 1024) {
          task.stdout = task.stdout.slice(-512 * 1024);
        }
      });

      child.stderr.on('data', (chunk) => {
        task.stderr += chunk.toString();
        if (task.stderr.length > 1024 * 1024) {
          task.stderr = task.stderr.slice(-512 * 1024);
        }
      });

      child.on('close', (code) => {
        task.exitCode = code;
        task.status = code === 0 ? 'completed' : 'failed';
        task.completedAt = new Date().toISOString();
        if (eventBus) {
          eventBus.publish(task.status === 'completed' ? 'task.completed' : 'task.failed', {
            id: task.id,
            command: task.command,
            exitCode: task.exitCode
          });
        }
      });

      child.on('error', (err) => {
        task.status = 'failed';
        task.stderr += `\nProcess error: ${err.message}`;
        task.completedAt = new Date().toISOString();
        if (eventBus) {
          eventBus.publish('task.failed', {
            id: task.id,
            command: task.command,
            error: err.message
          });
        }
      });

      if (eventBus) {
        eventBus.publish('task.started', { id: task.id, command: task.command });
      }

      res.status(201).json({
        id: task.id,
        pid: task.pid,
        status: task.status,
        startedAt: task.startedAt
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /  — list all tasks
  router.get('/', (_req, res) => {
    const list = Array.from(tasks.values()).map((t) => ({
      id: t.id,
      sessionId: t.sessionId,
      command: t.command,
      status: t.status,
      exitCode: t.exitCode,
      startedAt: t.startedAt,
      completedAt: t.completedAt
    }));
    // Sort: running first, then by startedAt descending
    list.sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
    });
    res.json({ tasks: list });
  });

  // GET /:id  — get task detail
  router.get('/:id', (req, res, next) => {
    const task = tasks.get(req.params.id);
    if (!task) return next(new HttpError(404, 'Task not found', 'NOT_FOUND'));
    res.json(task);
  });

  // DELETE /:id  — kill running task
  router.delete('/:id', (req, res, next) => {
    const task = tasks.get(req.params.id);
    if (!task) return next(new HttpError(404, 'Task not found', 'NOT_FOUND'));
    if (task.status !== 'running') {
      return next(new HttpError(400, 'Task is not running', 'NOT_RUNNING'));
    }
    try {
      if (task.pid) process.kill(task.pid, 'SIGTERM');
      task.status = 'failed';
      task.exitCode = -1;
      task.completedAt = new Date().toISOString();
      task.stderr += '\n[killed by user]';
      if (eventBus) {
        eventBus.publish('task.failed', { id: task.id, command: task.command, killed: true });
      }
      res.json({ killed: true, id: task.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
