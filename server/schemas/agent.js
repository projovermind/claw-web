import { z } from 'zod';

// child 프로세스 환경을 오염시키면 러너의 인증/실행 경로가 통째로 깨지는 키들.
// PATH/HOME 은 CLI 탐색, NODE_OPTIONS 는 임의 코드 주입, CLAUDE_CONFIG_DIR 은
// 계정 격리를 각각 무너뜨린다.
export const FORBIDDEN_ENV_KEYS = new Set(['PATH', 'HOME', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR']);

export const agentEnvSchema = z
  .record(z.string().max(2000))
  .refine((obj) => Object.keys(obj).length <= 32, { message: 'at most 32 env vars' })
  .refine((obj) => Object.keys(obj).every((k) => /^[A-Z_][A-Z0-9_]*$/.test(k)), {
    message: 'env keys must match ^[A-Z_][A-Z0-9_]*$'
  })
  .refine((obj) => Object.keys(obj).every((k) => !FORBIDDEN_ENV_KEYS.has(k)), {
    message: `env keys ${[...FORBIDDEN_ENV_KEYS].join('/')} are not allowed`
  });

export const agentPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  avatar: z.string().max(16).optional(),
  systemPrompt: z.string().max(50000).optional(),
  model: z.string().max(64).optional(),
  // 모델 "급" (backends.json tiers.order 의 한 항목). 지정되면 model 보다 우선하고,
  // 백엔드마다 tierModels 로 실제 모델 ID 가 풀린다. null = 지정 해제.
  modelTier: z.string().max(32).nullable().optional(),
  workingDir: z.string().max(500).optional(),
  // 이 에이전트를 실행할 인스턴스 id (instances.json). 없거나 selfId 면 로컬 실행.
  // workingDir 와 같은 "기계별 값" 이라 sync-agents.mjs 가 덮어쓰지 않는다.
  host: z.string().max(64).nullable().optional(),
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
  // CLI 2.1.259 --permission-mode choices. 'auto' = 분류기가 위험 행동만 차단.
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto']).nullable().optional(),
  env: agentEnvSchema.optional(),
  backendId: z.string().max(64).nullable().optional(),
  accountId: z.string().max(64).nullable().optional(), // deprecated: use backendId
  thinkingEffort: z.enum(['auto', 'low', 'medium', 'high', 'max']).optional(),
  // 이 에이전트가 동시에 받을 수 있는 위임 수. 초과분은 agentQueue 에서 대기한다.
  maxConcurrent: z.number().int().min(1).max(10).optional(),
  // Phase 1: auto-injected working context
  pinnedFiles: z.array(z.string().max(500)).max(20).optional(),
  gitDiffAutoAttach: z.boolean().optional(),
  // Phase 5: VS Code bridge auto-inject
  bridgeAutoAttach: z.boolean().optional()
}).strict();

// Which fields live in config.json (bot territory) vs web-metadata.json
export const CONFIG_FIELDS = new Set([
  'name', 'avatar', 'systemPrompt', 'model', 'modelTier', 'workingDir', 'host',
  'allowedTools', 'disallowedTools', 'planMode', 'permissionMode', 'env', 'backendId', 'thinkingEffort',
  'maxConcurrent',
  'pinnedFiles', 'gitDiffAutoAttach', 'bridgeAutoAttach'
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
