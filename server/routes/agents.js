import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { agentPatchSchema, splitPatch } from '../schemas/agent.js';

const createSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, 'id must be alphanumeric / - / _'),
  name: z.string().min(1).max(80),
  avatar: z.string().max(16).optional(),
  systemPrompt: z.string().max(50000).optional(),
  model: z.string().max(64).optional(),
  workingDir: z.string().max(500).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional()
}).strict();

const cloneSchema = z.object({
  newId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, 'id must be alphanumeric / - / _'),
  newName: z.string().min(1).max(80).optional(),
  copyMetadata: z.boolean().optional() // default: true (preserve tier/projectId/skillIds)
}).strict();

export function createAgentsRouter({ configStore, metadataStore, projectsStore, eventBus }) {
  const router = Router();

  function merge(id, configAgent) {
    const meta = metadataStore?.getAgent(id) ?? {};
    return { id, ...configAgent, ...meta };
  }

  router.get('/', (req, res) => {
    const agents = configStore.getAgents();
    const list = Object.entries(agents)
      .map(([id, data]) => merge(id, data))
      // Sort by metadata order (drag-reorder value) so every consumer —
      // AgentHierarchy, ChatPage picker, CommandPalette — sees the same
      // sequence the user set up.
      .sort((a, b) => {
        const ao = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
        const bo = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return (a.id ?? '').localeCompare(b.id ?? '');
      });
    res.json({ agents: list });
  });

  router.get('/:id', (req, res, next) => {
    const agent = configStore.getAgent(req.params.id);
    if (!agent) return next(new HttpError(404, `Agent ${req.params.id} not found`, 'AGENT_NOT_FOUND'));
    res.json(merge(req.params.id, agent));
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = createSchema.parse(req.body);
      const { id, ...fields } = data;
      const created = await configStore.createAgent(id, fields);
      if (eventBus) eventBus.publish('agent.created', { agentId: id });
      res.status(201).json(merge(id, created));
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (err.code === 'DUPLICATE') return next(new HttpError(409, err.message, 'DUPLICATE'));
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const parsed = agentPatchSchema.parse(req.body);
      const id = req.params.id;
      if (!configStore.getAgent(id)) {
        throw new HttpError(404, `Agent ${id} not found`, 'AGENT_NOT_FOUND');
      }

      // Concurrent-edit protection: if the client provides If-Match-UpdatedAt
      // header, compare against the current metadata token. If someone else
      // saved in between, return 409 so the client can show a merge dialog.
      const ifMatch = req.headers['if-match-updatedat'];
      if (ifMatch && metadataStore) {
        const currentMeta = metadataStore.getAgent(id);
        const currentToken = currentMeta?.updatedAt ?? null;
        if (currentToken && currentToken !== ifMatch) {
          throw new HttpError(
            409,
            `Agent was modified by another session (expected ${ifMatch}, got ${currentToken})`,
            'UPDATEDAT_CONFLICT'
          );
        }
      }

      const { configPatch, metaPatch } = splitPatch(parsed);

      // Auto-sync workingDir when projectId changes and projectsStore is available
      if (metaPatch.projectId !== undefined && projectsStore) {
        if (metaPatch.projectId) {
          const proj = projectsStore.getById(metaPatch.projectId);
          if (proj?.path) {
            configPatch.workingDir = proj.path;
          }
        }
        // projectId=null (unassigned) → keep existing workingDir (no-op)
      }

      if (Object.keys(configPatch).length) {
        await configStore.updateAgent(id, configPatch);
      }
      if (Object.keys(metaPatch).length && metadataStore) {
        await metadataStore.updateAgent(id, metaPatch);
      } else if (metadataStore) {
        // Config-only patch: still bump the concurrency token so the next
        // If-Match-UpdatedAt check reflects this save.
        await metadataStore.touchAgent(id);
      }
      if (eventBus) eventBus.publish('agent.updated', { agentId: id, patch: parsed });
      res.json(merge(id, configStore.getAgent(id)));
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid patch', 'INVALID_PATCH'));
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!configStore.getAgent(id)) {
        throw new HttpError(404, `Agent ${id} not found`, 'AGENT_NOT_FOUND');
      }
      await configStore.deleteAgent(id);
      if (metadataStore) await metadataStore.deleteAgent(id);
      if (eventBus) eventBus.publish('agent.deleted', { agentId: id });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Clone: duplicate an existing agent with a new id. Copies config fields and
  // (by default) metadata overlay (tier, projectId, skillIds, lightweightMode, etc.).
  // Does NOT copy: createdAt/updatedAt (set fresh), order (set to MAX so it appears last)
  router.post('/:id/clone', async (req, res, next) => {
    try {
      const data = cloneSchema.parse(req.body);
      const sourceId = req.params.id;
      const source = configStore.getAgent(sourceId);
      if (!source) {
        throw new HttpError(404, `Agent ${sourceId} not found`, 'AGENT_NOT_FOUND');
      }
      if (configStore.getAgent(data.newId)) {
        throw new HttpError(409, `Agent ${data.newId} already exists`, 'DUPLICATE');
      }

      // Clone config fields (strip id, inject new name if provided)
      const { ...configFields } = source;
      const newConfig = {
        ...configFields,
        name: data.newName ?? `${source.name ?? sourceId} (copy)`
      };
      const created = await configStore.createAgent(data.newId, newConfig);

      // Clone metadata overlay (default true)
      const copyMeta = data.copyMetadata !== false;
      if (copyMeta && metadataStore) {
        const sourceMeta = metadataStore.getAgent(sourceId);
        if (sourceMeta) {
          const metaPatch = { ...sourceMeta };
          delete metaPatch.createdAt;
          delete metaPatch.updatedAt;
          // Bump order so clone appears after source in the same list
          if (typeof metaPatch.order === 'number') {
            metaPatch.order = metaPatch.order + 1;
          }
          await metadataStore.updateAgent(data.newId, metaPatch);
        }
      }

      if (eventBus) eventBus.publish('agent.cloned', { sourceId, newId: data.newId });
      res.status(201).json({ id: data.newId, ...created });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  return router;
}
