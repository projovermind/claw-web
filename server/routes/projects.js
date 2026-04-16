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
