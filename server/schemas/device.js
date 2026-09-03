import { z } from 'zod';

const httpUrl = z.string().url().max(500).refine(
  (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } },
  'url must be http or https'
);

export const deviceCreateSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/i, 'id must be alphanumeric or hyphen'),
  name: z.string().min(1).max(80),
  url: httpUrl,
  note: z.string().max(200).optional(),
  order: z.number().optional(),
}).strict();

export const deviceUpdateSchema = deviceCreateSchema.partial().omit({ id: true }).strict();
