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
  defaultDisallowedTools: z.array(z.string().max(80)).max(50).optional(),
  // Project-level Claude account override.
  // Priority: agent.accountId > project.accountId > round-robin
  // null = auto-select (least-recently-used active account)
  accountId: z.string().max(64).nullable().optional(),
  dashboard: z.object({
    notes: z.string().max(50000).optional().default(''),
    goals: z.array(z.object({
      id: z.string().max(64),
      title: z.string().max(200),
      status: z.enum(['todo', 'progress', 'done']),
      description: z.string().max(2000).optional(),
      createdAt: z.string()
    })).max(100).optional().default([]),
    widgets: z.array(z.object({
      id: z.string().max(64),
      type: z.enum(['link', 'text', 'kv', 'markdown']),
      title: z.string().max(100),
      value: z.string().max(5000)
    })).max(20).optional().default([])
  }).optional()
}).strict();

export const projectUpdateSchema = projectCreateSchema.partial().omit({ id: true }).strict();
