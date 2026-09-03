export interface Agent {
  id: string;
  name: string;
  avatar?: string;
  model?: string;
  systemPrompt?: string;
  workingDir?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  planMode?: boolean;
  thinkingEffort?: 'auto' | 'low' | 'medium' | 'high' | 'max';
  backendId?: string | null;
  accountId?: string | null; // deprecated: use backendId
  // web-metadata overlay
  projectId?: string | null;
  tier?: 'main' | 'project' | 'addon' | null;
  parentId?: string | null;
  order?: number;
  favorite?: boolean;
  skillIds?: string[];
  lightweightMode?: boolean;
  // Phase 1: auto-injected working context
  pinnedFiles?: string[];
  gitDiffAutoAttach?: boolean;
  // Phase 5: VS Code bridge auto-inject
  bridgeAutoAttach?: boolean;
  /** CLI --permission-mode 로 그대로 전달. */
  permissionMode?: PermissionMode;
  /** 러너 spawn 시 프로세스 env 에 병합 (에이전트 값이 우선). */
  env?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    totalTokens: number;
    /** 마지막 LLM call 의 prompt 크기 (input + cache_read + cache_creation).
     *  CLI `result.usage` 의 input/cache_read 는 도구 루프 내부 호출 합산이라
     *  컨텍스트 윈도우 부하 게이지에는 부적합. 이 필드가 있으면 게이지가 우선 사용. */
    contextTokens?: number | null;
  } | null;
}

export interface LoopConfig {
  enabled: boolean;
  prompt: string;
  maxIterations: number;
  completionPromise: string;
  currentIteration: number;
  paused?: boolean;
  escalateReason?: string;
  startedAt?: string;
}

export interface Session {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Runner heartbeat — advances on tool/stream activity, unlike updatedAt which only moves on message commit. */
  lastActivityAt?: string | null;
  claudeSessionId: string | null;
  messages: ChatMessage[];
  /** True iff there are older messages on the server not yet loaded. */
  hasMoreBefore?: boolean;
  /** Total message count on the server (messages.length may be less due to pagination). */
  totalMessageCount?: number;
  /** Aggregate token totals across ALL messages (not just the loaded slice). */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  isRunning?: boolean;
  pinned?: boolean;
  loop?: LoopConfig | null;
  isDelegation?: boolean;
  /** Per-session model alias override. null/undefined → follow the agent's model. */
  model?: string | null;
}

/** Lightweight session descriptor returned by GET /api/sessions (no messages). */
export interface SessionMeta {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  claudeSessionId: string | null;
  messageCount: number;
  recent24hCount: number;
  isRunning?: boolean;
  pinned?: boolean;
  loop?: LoopConfig | null;
  isDelegation?: boolean;
}

export interface GoalCard {
  id: string;
  title: string;
  status: 'todo' | 'progress' | 'done';
  description?: string;
  createdAt: string;
}

export interface CustomWidget {
  id: string;
  type: 'link' | 'text' | 'kv' | 'markdown';
  title: string;
  value: string;
}

export interface ProjectDashboard {
  notes: string;
  goals: GoalCard[];
  widgets: CustomWidget[];
  memory?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color?: string;
  order?: number;
  defaultSkillIds?: string[];
  defaultAllowedTools?: string[];
  defaultDisallowedTools?: string[];
  accountId?: string | null; // deprecated: use backendId
  backendId?: string | null;
  dashboard?: ProjectDashboard;
}

/** 이 claw-web 이 아는 다른 기계. 원격 조종이 아니라 "그 기계의 claw-web 으로 건너가는" 북마크. */
export interface Device {
  id: string;
  name: string;
  url: string;
  note?: string;
  order?: number;
}

export interface DevicePing {
  online: boolean;
  latencyMs: number;
  error?: string;
  health?: HealthStatus;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
  alwaysOn?: boolean;
  triggers?: string[];
  // System skills from ~/.claude/plugins/**/SKILL.md (read-only)
  system?: boolean;
  plugin?: string;
  source?: string;
  // Token metadata (from GET /api/skills)
  estimatedTokens?: number;
  mode?: 'always' | 'triggered' | 'manual';
}

export interface HealthStatus {
  botOnline: boolean;
  botPid: number | null;
  botConfigured?: boolean;
  webUptime: number;
  ts: string;
  /** package.json 버전 — 구버전 서버에는 없으므로 optional */
  version?: string;
}

/** GET /api/stats/usage 의 cost 블록 (비용 추적 도입 전 서버에는 없음) */
export interface UsageCost {
  window7d: number;
  window30d: number;
  byAgent: Record<string, number>;
  byDay: Record<string, number>;
  byAccount: Record<string, number>;
}

export interface WebSettings {
  port: number;
  features: Record<string, boolean>;
  auth: { enabled: boolean; token: string | null };
  appearance?: Record<string, unknown>;
  editor?: EditorConfig;
  chat?: ChatConfig;
  usage?: UsageConfig;
}

export interface ChatConfig {
  /** 컨텍스트 사용률이 이 %(0 = off) 를 넘으면 턴 종료 후 자동 compact. */
  autoCompactPct?: number;
}

export interface UsageConfig {
  /** 5시간 창 토큰 예산 (0 = 미설정). */
  budget5h?: number;
  /** 7일 창 토큰 예산 (0 = 미설정). */
  budget7d?: number;
}

export interface EditorConfig {
  /** 'off' disables the Open-in-Editor buttons */
  scheme: 'off' | 'vscode' | 'cursor';
  /** Prefix-based remapping for remote-server → local paths. { serverPrefix: localPrefix } */
  pathMap?: Record<string, string>;
}

export type BackendPublic =
  | {
      type: 'openai-compatible' | 'anthropic-compatible';
      id: string;
      label: string;
      baseURL: string | null;
      envKey: string | null;
      envStatus: 'set' | 'unset' | 'n/a';
      /** 'managed' = stored in secrets.json; 'shell' = pre-existing env; 'none' = not set */
      secretSource?: 'managed' | 'shell' | 'none';
      hasSecret?: boolean;
      secretTooShort?: boolean;
      models: Record<string, string>;
      /** Per-model context window in tokens (key = actual model id). */
      contextWindows?: Record<string, number>;
      active?: boolean;
      austerity?: boolean;
      fallback?: string | null;
    }
  | {
      type: 'claude-cli';
      id: string;
      label: string;
      configDir: string;
      /** True iff configDir was auto-created from the ~/.claude-claw/account-{id} fallback (user did not set it explicitly). */
      configDirAutoCreated?: boolean;
      models: Record<string, string>;
      /** Per-model context window in tokens (key = actual model id). */
      contextWindows?: Record<string, number>;
      status: 'active' | 'cooldown' | 'disabled' | 'needs-relogin';
      lastUsedAt: number;
      usage?: { windowStart: string | null; messagesUsed: number };
      priority: number;
      cooldownUntil?: number | null;
      cooldownRemaining?: number;
      /** 'ok' = configDir exists, 'missing' = not found */
      envStatus: 'ok' | 'missing';
      /** managed OAuth token 보유 여부 */
      oauthStatus?: 'set' | 'unset';
      oauthSource?: 'managed' | 'shell' | 'none';
      cred?: {
        has: boolean;
        source: 'credentials.json' | 'oauthAccount' | 'keychain' | 'managed' | 'shell' | 'none';
        expiresAt?: string;
        expiringSoon?: boolean;
        accountEmail?: string | null;
        keychainShared?: boolean;
      };
    };

export type ClaudeCliBackend = Extract<BackendPublic, { type: 'claude-cli' }>;
export type Backend = BackendPublic;

export interface ActivityEntry {
  ts: string;
  topic: string;
  [key: string]: unknown;
}

export interface Account {
  id: string;
  label: string;
  configDir: string;
  status: 'active' | 'cooldown' | 'disabled' | 'needs-relogin';
  priority: number;
  lastUsedAt: string | null;
  usage: { windowStart: string | null; messagesUsed: number };
  cooldownRemaining?: number | null;
  createdAt: string;
  updatedAt: string;
  cred?: {
    has: boolean;
    source: 'credentials.json' | 'oauthAccount' | 'keychain' | 'managed' | 'shell' | 'none';
    expiresAt?: string;
    expiringSoon?: boolean;
    accountEmail?: string | null;
    keychainShared?: boolean;
  };
}

export interface BackendsState {
  activeBackend: string;
  austerityMode: boolean;
  austerityBackend: string;
  backends: Record<string, BackendPublic>;
}

export interface DelegationEntry {
  id: string;
  originSessionId: string;
  targetSessionId: string;
  targetAgentId: string;
  task: string;
  loop: boolean;
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  completedAt: string | null;
  result: string | null;
}

/** CLI 권한 모드 — `auto` 는 분류기가 위험 행동만 차단 (CLI 2.1.259+). */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'SessionStart',
  'UserPromptSubmit'
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** hooks.json 항목 — 러너가 에이전트 실행 시 Claude settings 로 조립해 주입한다. */
export interface HookConfig {
  id: string;
  event: HookEvent | string;
  matcher: string;
  command: string;
  enabled: boolean;
  /** 레거시 필드 — 서버는 'shell' 만 사용. */
  action?: string;
  /** true 면 훅 완료를 기다리지 않음. */
  async?: boolean;
  /** 초 단위. 미지정이면 CLI 기본값. */
  timeout?: number;
  /** 비어있으면 전체 에이전트에 적용. */
  agentIds?: string[];
}

export interface McpPreset {
  id: string;
  name: string;
  desc?: string;
  config: Record<string, unknown>;
}

export interface ClaudeMemoryFile {
  name: string;
  size: number;
  mtime: string;
}

export interface ClaudeMemoryList {
  dir: string;
  files: ClaudeMemoryFile[];
  /** MEMORY.md 내용 — 파일이 없으면 null. */
  index: string | null;
}

/** GET /api/stats/usage 의 토큰 예산 (0 = 미설정). */
export interface UsageBudget {
  tokens5h: number;
  tokens7d: number;
}
