import { Router } from 'express';
import { HttpError } from '../middleware/error-handler.js';
import { projectCreateSchema, projectUpdateSchema } from '../schemas/project.js';

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
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid project', 'INVALID_PROJECT'));
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
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid patch', 'INVALID_PATCH'));
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
