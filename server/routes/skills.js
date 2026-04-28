import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { estimateSkillTokens, skillMode } from '../lib/skills-store.js';

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  content: z.string().max(100000).optional(),
  alwaysOn: z.boolean().optional(),
  triggers: z.array(z.string().min(1).max(80)).max(32).optional(),
  priority: z.number().int().min(0).max(1000).optional()
}).strict();

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  content: z.string().max(100000).optional(),
  alwaysOn: z.boolean().optional(),
  triggers: z.array(z.string().min(1).max(80)).max(32).optional(),
  priority: z.number().int().min(0).max(1000).optional()
}).strict();

const assignSchema = z.object({
  agentIds: z.array(z.string().min(1).max(64)).min(1).max(200)
}).strict();

export function createSkillsRouter({
  skillsStore,
  systemSkillsStore,
  metadataStore,
  eventBus
}) {
  const router = Router();

  router.get('/', (req, res) => {
    const custom = skillsStore.getAll();
    const system = systemSkillsStore ? systemSkillsStore.getAll() : [];
    const withMeta = (s) => ({
      ...s,
      estimatedTokens: estimateSkillTokens(s),
      mode: skillMode(s)
    });
    res.json({ skills: [...custom, ...system].map(withMeta) });
  });

  router.post('/system/refresh', async (req, res, next) => {
    try {
      if (!systemSkillsStore) return res.json({ count: 0 });
      const skills = await systemSkillsStore.refresh();
      if (eventBus) eventBus.publish('skills.refreshed', {});
      res.json({ count: skills.length });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', (req, res, next) => {
    const id = req.params.id;
    if (id.startsWith('sys:') && systemSkillsStore) {
      const s = systemSkillsStore.get(id);
      if (!s) return next(new HttpError(404, 'Skill not found', 'SKILL_NOT_FOUND'));
      return res.json(s);
    }
    const s = skillsStore.get(id);
    if (!s) return next(new HttpError(404, 'Skill not found', 'SKILL_NOT_FOUND'));
    res.json(s);
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = createSchema.parse(req.body);
      const created = await skillsStore.create(data);
      if (eventBus) eventBus.publish('skill.created', { skill: created });
      res.status(201).json(created);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const data = updateSchema.parse(req.body);
      if (req.params.id.startsWith('sys:')) {
        throw new HttpError(400, 'System skills are read-only', 'READ_ONLY');
      }
      if (!skillsStore.get(req.params.id)) {
        throw new HttpError(404, 'Skill not found', 'SKILL_NOT_FOUND');
      }
      const updated = await skillsStore.update(req.params.id, data);
      if (eventBus) eventBus.publish('skill.updated', { skill: updated });
      res.json(updated);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      if (req.params.id.startsWith('sys:')) {
        throw new HttpError(400, 'System skills are read-only', 'READ_ONLY');
      }
      if (!skillsStore.get(req.params.id)) {
        throw new HttpError(404, 'Skill not found', 'SKILL_NOT_FOUND');
      }
      await skillsStore.remove(req.params.id);
      if (eventBus) eventBus.publish('skill.deleted', { skillId: req.params.id });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Batch assign: adds the skill to each agent's skillIds (dedup)
  router.post('/:id/assign', async (req, res, next) => {
    try {
      const { agentIds } = assignSchema.parse(req.body);
      const skillId = req.params.id;
      // Verify skill exists (custom or system)
      const exists =
        skillsStore.get(skillId) ||
        (skillId.startsWith('sys:') && systemSkillsStore?.get(skillId));
      if (!exists) {
        throw new HttpError(404, 'Skill not found', 'SKILL_NOT_FOUND');
      }
      if (!metadataStore) {
        throw new HttpError(500, 'metadataStore not available', 'NO_STORE');
      }
      const updated = [];
      for (const agentId of agentIds) {
        const meta = metadataStore.getAgent(agentId) ?? {};
        const current = Array.isArray(meta.skillIds) ? meta.skillIds : [];
        if (current.includes(skillId)) continue; // already has
        await metadataStore.updateAgent(agentId, {
          skillIds: [...current, skillId]
        });
        updated.push(agentId);
      }
      if (eventBus) eventBus.publish('skill.bulkAssign', { skillId, agentIds: updated });
      res.json({ skillId, assigned: updated.length, agentIds: updated });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // Batch unassign: removes the skill from each agent's skillIds
  router.post('/:id/unassign', async (req, res, next) => {
    try {
      const { agentIds } = assignSchema.parse(req.body);
      const skillId = req.params.id;
      if (!metadataStore) {
        throw new HttpError(500, 'metadataStore not available', 'NO_STORE');
      }
      const updated = [];
      for (const agentId of agentIds) {
        const meta = metadataStore.getAgent(agentId) ?? {};
        const current = Array.isArray(meta.skillIds) ? meta.skillIds : [];
        if (!current.includes(skillId)) continue;
        await metadataStore.updateAgent(agentId, {
          skillIds: current.filter((id) => id !== skillId)
        });
        updated.push(agentId);
      }
      if (eventBus) eventBus.publish('skill.bulkUnassign', { skillId, agentIds: updated });
      res.json({ skillId, unassigned: updated.length, agentIds: updated });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  return router;
}
