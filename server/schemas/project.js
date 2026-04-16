import { z } from 'zod';

export const projectCreateSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/i, 'id must be alphanumeric or hyphen'),
  name: z.string().min(1).max(80),
  path: z.string().min(1).max(500),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  order: z.number().optional(),
  defaultSkillIds: z.array(z.string().max(64)).max(50).optional(),
  // Project-level tool defaults. Agents placed in this project inherit
  // these — the chat route unions them with the agent's own allowedTools/
  // disallowedTools before handing to Claude CLI.
  defaultAllowedTools: z.array(z.string().max(80)).max(50).optional(),
  defaultDisallowedTools: z.array(z.string().max(80)).max(50).optional()
}).strict();

export const projectUpdateSchema = projectCreateSchema.partial().omit({ id: true }).strict();
