import { z } from 'zod';

export const agentPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  avatar: z.string().max(16).optional(),
  systemPrompt: z.string().max(50000).optional(),
  model: z.string().max(64).optional(),
  workingDir: z.string().max(500).optional(),
  projectId: z.string().max(64).nullable().optional(),
  tier: z.enum(['main', 'project', 'addon']).nullable().optional(),
  parentId: z.string().max(64).nullable().optional(),
  order: z.number().optional(),
  favorite: z.boolean().optional(),
  skillIds: z.array(z.string().max(64)).max(50).optional(),
  lightweightMode: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  planMode: z.boolean().optional(),
  backendId: z.string().max(64).nullable().optional(),
  accountId: z.string().max(64).nullable().optional(), // deprecated: use backendId
  thinkingEffort: z.enum(['auto', 'low', 'medium', 'high', 'max']).optional()
}).strict();

// Which fields live in config.json (bot territory) vs web-metadata.json
export const CONFIG_FIELDS = new Set([
  'name', 'avatar', 'systemPrompt', 'model', 'workingDir',
  'allowedTools', 'disallowedTools', 'planMode', 'backendId', 'thinkingEffort'
]);
export const METADATA_FIELDS = new Set([
  'projectId',
  'tier',
  'parentId',
  'order',
  'favorite',
  'skillIds',
  'lightweightMode'
]);

export function splitPatch(patch) {
  const configPatch = {};
  const metaPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (METADATA_FIELDS.has(k)) metaPatch[k] = v;
    else if (CONFIG_FIELDS.has(k)) configPatch[k] = v;
  }
  return { configPatch, metaPatch };
}
