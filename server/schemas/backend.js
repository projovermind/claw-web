import { z } from 'zod';

export const ClaudeCliBackendSchema = z.object({
  type: z.literal('claude-cli'),
  label: z.string(),
  configDir: z.string().nullable().optional(),
  status: z.enum(['active', 'cooldown', 'disabled', 'needs-relogin']).default('active'),
  lastUsedAt: z.number().nullable().default(null),
  usage: z.object({
    windowStart: z.number().nullable().default(null),
    messagesUsed: z.number().default(0),
  }).default({ windowStart: null, messagesUsed: 0 }),
  priority: z.number().default(50),
  cooldownUntil: z.number().nullable().default(null),
  models: z.record(z.string()).default({}),
  envKey: z.string().nullable().optional(),
  fallback: z.string().nullable().optional(),
});

export const OpenAICompatibleBackendSchema = z.object({
  type: z.literal('openai-compatible'),
  label: z.string(),
  baseURL: z.string(),
  envKey: z.string().nullable().optional(),
  secret: z.string().nullable().optional(),
  models: z.record(z.string()).default({}),
  fallback: z.string().nullable().optional(),
});

export const BackendSchema = z.discriminatedUnion('type', [
  ClaudeCliBackendSchema,
  OpenAICompatibleBackendSchema,
]);
