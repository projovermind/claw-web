import { Router } from 'express';
import { execFileSync } from 'node:child_process';
import { HttpError } from '../middleware/error-handler.js';
import { projectCreateSchema, projectUpdateSchema } from '../schemas/project.js';
import { appendDeployLog, recentDeployLog } from '../lib/deploy-log-store.js';

// Best-effort short HEAD commit for a working dir (null if not a git repo).
function headCommit(workingDir) {
  if (!workingDir) return null;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: workingDir, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

export function createProjectsRouter({ projectsStore, configStore, metadataStore, eventBus }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ projects: projectsStore.getAll() });
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = projectCreateSchema.parse(req.body);
      const created = await projectsStore.create(data);
      if (eventBus) eventBus.publish('project.created', { project: created });
      res.status(201).json(created);
    } catch (err) {
      if (err.name === 'ZodError') {
        const first = err.issues?.[0];
        const msg = first ? `${first.path.join('.') || 'field'}: ${first.message}` : 'Invalid project';
        return next(new HttpError(400, msg, 'INVALID_PROJECT'));
      }
      if (err.code === 'DUPLICATE') return next(new HttpError(409, err.message, 'DUPLICATE'));
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const data = projectUpdateSchema.parse(req.body);
      const existing = projectsStore.getById(req.params.id);
      if (!existing) {
        throw new HttpError(404, `Project ${req.params.id} not found`, 'PROJECT_NOT_FOUND');
      }
      const updated = await projectsStore.update(req.params.id, data);

      // Cascade: if path changed, update workingDir of all agents placed in this project
      if (data.path && data.path !== existing.path && configStore && metadataStore) {
        const allMetaAgents = metadataStore.getAll().agents ?? {};
        const affectedIds = Object.entries(allMetaAgents)
          .filter(([, meta]) => meta.projectId === req.params.id)
          .map(([id]) => id)
          .filter((id) => configStore.getAgent(id));
        for (const id of affectedIds) {
          await configStore.updateAgent(id, { workingDir: data.path });
        }
      }

      if (eventBus) eventBus.publish('project.updated', { project: updated });
      res.json(updated);
    } catch (err) {
      if (err.name === 'ZodError') {
        const first = err.issues?.[0];
        const msg = first ? `${first.path.join('.') || 'field'}: ${first.message}` : 'Invalid patch';
        return next(new HttpError(400, msg, 'INVALID_PATCH'));
      }
      next(err);
    }
  });

  // ── Dashboard API (에이전트가 직접 호출 가능) ──

  // 목표 카드 추가
  router.post('/:id/goals', async (req, res, next) => {
    try {
      const project = projectsStore.getById(req.params.id);
      if (!project) return next(new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND'));
      const { title, status, description } = req.body;
      if (!title) return next(new HttpError(400, 'title required', 'INVALID_BODY'));
      const dashboard = project.dashboard ?? { notes: '', goals: [], widgets: [] };
      const card = {
        id: `goal_${Date.now().toString(36)}`,
        title,
        status: status || 'todo',
        description: description || '',
        createdAt: new Date().toISOString()
      };
      dashboard.goals = [...dashboard.goals, card];
      await projectsStore.update(req.params.id, { dashboard });
      if (eventBus) eventBus.publish('project.updated', { project: { ...project, dashboard } });
      res.json(card);
    } catch (err) { next(err); }
  });

  // 목표 카드 상태 변경
  router.patch('/:id/goals/:goalId', async (req, res, next) => {
    try {
      const project = projectsStore.getById(req.params.id);
      if (!project) return next(new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND'));
      const dashboard = project.dashboard ?? { notes: '', goals: [], widgets: [] };
      const goal = dashboard.goals.find(g => g.id === req.params.goalId);
      if (!goal) return next(new HttpError(404, 'Goal not found', 'GOAL_NOT_FOUND'));
      if (req.body.status) goal.status = req.body.status;
      if (req.body.title) goal.title = req.body.title;
      if (req.body.description !== undefined) goal.description = req.body.description;
      await projectsStore.update(req.params.id, { dashboard });
      if (eventBus) eventBus.publish('project.updated', { project: { ...project, dashboard } });
      res.json(goal);
    } catch (err) { next(err); }
  });

  // 커스텀 위젯 추가
  router.post('/:id/widgets', async (req, res, next) => {
    try {
      const project = projectsStore.getById(req.params.id);
      if (!project) return next(new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND'));
      const { type, title, value } = req.body;
      if (!title || !value) return next(new HttpError(400, 'title and value required', 'INVALID_BODY'));
      const dashboard = project.dashboard ?? { notes: '', goals: [], widgets: [] };
      const widget = {
        id: `w_${Date.now().toString(36)}`,
        type: type || 'text',
        title,
        value
      };
      dashboard.widgets = [...dashboard.widgets, widget];
      await projectsStore.update(req.params.id, { dashboard });
      if (eventBus) eventBus.publish('project.updated', { project: { ...project, dashboard } });
      res.json(widget);
    } catch (err) { next(err); }
  });

  // 프로젝트 메모리 읽기 (에이전트/UI 공용)
  router.get('/:id/memory', (req, res, next) => {
    try {
      const project = projectsStore.getById(req.params.id);
      if (!project) return next(new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND'));
      res.json({ memory: project.dashboard?.memory ?? '' });
    } catch (err) { next(err); }
  });

  // 프로젝트 메모리 업데이트 (에이전트 curl 직접 호출용)
  router.put('/:id/memory', async (req, res, next) => {
    try {
      const project = projectsStore.getById(req.params.id);
      if (!project) return next(new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND'));
      const dashboard = project.dashboard ?? { notes: '', goals: [], widgets: [] };
      dashboard.memory = req.body.memory ?? '';
      await projectsStore.update(req.params.id, { dashboard });
      if (eventBus) eventBus.publish('project.updated', { project: { ...project, dashboard } });
      res.json({ memory: dashboard.memory });
    } catch (err) { next(err); }
  });

  // 메모 업데이트
  router.put('/:id/notes', async (req, res, next) => {
    try {
      const project = projectsStore.getById(req.params.id);
      if (!project) return next(new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND'));
      const dashboard = project.dashboard ?? { notes: '', goals: [], widgets: [] };
      dashboard.notes = req.body.notes ?? '';
      await projectsStore.update(req.params.id, { dashboard });
      if (eventBus) eventBus.publish('project.updated', { project: { ...project, dashboard } });
      res.json({ notes: dashboard.notes });
    } catch (err) { next(err); }
  });

  // 배포 이력 조회 — 프로젝트 워킹트리 기준 (모든 세션 공유)
  router.get('/:id/deploy-log', (req, res, next) => {
    try {
      const project = projectsStore.getById(req.params.id);
      if (!project) return next(new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND'));
      res.json({ entries: recentDeployLog(project.path) });
    } catch (err) { next(err); }
  });

  // 배포 이력 기록 (에이전트 curl 직접 호출용) — 세션 간 롤백 방지 원장
  router.post('/:id/deploy-log', async (req, res, next) => {
    try {
      const project = projectsStore.getById(req.params.id);
      if (!project) return next(new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND'));
      if (!project.path) return next(new HttpError(400, 'Project has no working path', 'NO_PATH'));
      const entry = await appendDeployLog(project.path, {
        target: req.body?.target,
        note: req.body?.note,
        session: req.body?.session,
        commit: req.body?.commit ?? headCommit(project.path),
      });
      res.status(201).json({ entry });
    } catch (err) { next(err); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (!projectsStore.getById(req.params.id)) {
        throw new HttpError(404, `Project ${req.params.id} not found`, 'PROJECT_NOT_FOUND');
      }
      await projectsStore.remove(req.params.id);
      if (eventBus) eventBus.publish('project.deleted', { projectId: req.params.id });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return router;
}
