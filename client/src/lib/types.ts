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
}

export interface HealthStatus {
  botOnline: boolean;
  botPid: number | null;
  botConfigured?: boolean;
  webUptime: number;
  ts: string;
}

export interface WebSettings {
  port: number;
  features: Record<string, boolean>;
  auth: { enabled: boolean; token: string | null };
  appearance?: Record<string, unknown>;
  editor?: EditorConfig;
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
      active?: boolean;
      austerity?: boolean;
      fallback?: string | null;
    }
  | {
      type: 'claude-cli';
      id: string;
      label: string;
      configDir: string;
      models: Record<string, string>;
      status: 'active' | 'cooldown' | 'disabled';
      lastUsedAt: number;
      usage?: { windowStart: string | null; messagesUsed: number };
      priority: number;
      cooldownUntil?: number | null;
      cooldownRemaining?: number;
      /** 'ok' = configDir exists, 'missing' = not found */
      envStatus: 'ok' | 'missing';
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
  status: 'active' | 'cooldown' | 'disabled';
  priority: number;
  lastUsedAt: string | null;
  usage: { windowStart: string | null; messagesUsed: number };
  cooldownRemaining?: number | null;
  createdAt: string;
  updatedAt: string;
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
