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
  accountId?: string | null;
  // web-metadata overlay
  projectId?: string | null;
  tier?: 'main' | 'project' | 'addon' | null;
  parentId?: string | null;
  order?: number;
  favorite?: boolean;
  skillIds?: string[];
  lightweightMode?: boolean;
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
  dashboard?: ProjectDashboard;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
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
}

export interface BackendPublic {
  id: string;
  type: 'claude-cli' | 'openai-compatible' | 'anthropic-compatible';
  label: string;
  baseURL: string | null;
  envKey: string | null;
  envStatus: 'set' | 'unset' | 'n/a';
  /** 'managed' = stored in secrets.json (UI-editable); 'shell' = pre-existing
   * process.env from shell; 'none' = not set */
  secretSource?: 'managed' | 'shell' | 'none';
  models: Record<string, string>;
  fallback?: string | null;
}

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
