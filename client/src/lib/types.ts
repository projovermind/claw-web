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
  /** 모델 티어 키 (HIGH/MIDDLE/LOW 또는 커스텀). 백엔드의 tierModels 로 실제 모델이 결정된다.
   *  null/undefined → 티어 미사용, `model` 에 고정된 모델을 그대로 쓴다. */
  modelTier?: string | null;
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
  /** 동시에 처리할 수 있는 위임 수 (1~5, 기본 1). */
  maxConcurrent?: number;
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
  /** True while a delegation started by this session is still awaiting its reply. */
  delegating?: boolean;
  /** Per-session model alias override. null/undefined → follow the agent's model. */
  model?: string | null;
  /** Id of the first session in a compaction chain. Absent on legacy/never-compacted sessions. */
  compactRoot?: string;
  /** Compaction generation within the chain — root is 0, each compaction increments. */
  compactGen?: number;
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
  /** True while a delegation started by this session is still awaiting its reply. */
  delegating?: boolean;
  /** Id of the first session in a compaction chain. Absent on legacy/never-compacted sessions. */
  compactRoot?: string;
  /** Compaction generation within the chain — root is 0, each compaction increments. */
  compactGen?: number;
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
  /** 서버가 계산해 내려주는 프로젝트 전체 세션 기준 최근 활동 시각 (실시간 세션 스캔의 폴백 기준선). */
  lastActivityAt?: string | null;
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
      /** 티어 키 → 이 백엔드에서 그 티어가 쓸 실제 모델 id. 빈 티어는 키 자체가 없다. */
      tierModels?: Record<string, string>;
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
      /** 티어 키 → 이 백엔드에서 그 티어가 쓸 실제 모델 id. 빈 티어는 키 자체가 없다. */
      tierModels?: Record<string, string>;
      status: 'active' | 'cooldown' | 'disabled' | 'needs-relogin';
      lastUsedAt: number;
      usage?: { windowStart: string | null; messagesUsed: number };
      priority: number;
      cooldownUntil?: number | null;
      cooldownRemaining?: number;
      /** 이 백엔드가 실패했을 때 대신 쓸 백엔드 id. 전역 fallbackBackend 보다 우선. */
      fallback?: string | null;
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

/** 백엔드 한도 창 하나 (5시간 / 주간). utilization 은 0~100 퍼센트. */
export interface BackendUsageWindow {
  utilization: number;
  /** ISO 시각 — 이 창이 초기화되는 시점 */
  resetsAt: string | null;
}

/**
 * GET /api/backends/usage 의 백엔드 1개분.
 * - ok: 게이지 표시
 * - expired: 토큰 만료 → '재인증 필요'
 * - unauthorized: 401/403 → '권한 없음'
 * - no-credentials: configDir 에 자격증명 없음(또는 조회 스코프 없는 setup-token) → '한도 조회 불가'
 * - token-only: configDir 토큰은 없/만료지만 저장된 OAuth 토큰으로는 동작 → '한도 조회 불가'(중립,
 *   '재인증 필요' 아님) — 토큰은 유효하나 조회 스코프가 없다는 뜻
 * - unsupported: 한도 개념 없는 백엔드 / error: 조회 실패 → 둘 다 숨김
 */
export interface BackendUsage {
  status: 'ok' | 'expired' | 'unauthorized' | 'no-credentials' | 'token-only' | 'unsupported' | 'error';
  fiveHour?: BackendUsageWindow | null;
  sevenDay?: BackendUsageWindow | null;
  extraUsage?: { enabled: boolean; usedCredits: number; monthlyLimit: number } | null;
  account?: { email: string | null; tier: string | null; organization?: string | null } | null;
  /** 같은 Anthropic 계정을 쓰는 백엔드끼리 동일. 한도 공유 판별용. (서버 추가 예정) */
  accountUuid?: string | null;
  /** 'shared' = 다른 백엔드와 같은 계정 토큰을 쓴다 → 한도를 나눠 쓴다. (서버 추가 예정) */
  tokenSource?: 'self' | 'shared' | 'managed';
  /** 실패 사유(사람이 읽는 문장). ok 에는 없다. */
  reason?: string;
  /** error/unauthorized 일 때의 HTTP 상태코드. */
  httpStatus?: number;
  /**
   * 이번 조회는 실패했지만 fiveHour/sevenDay 는 직전 성공 때의 수치라는 뜻.
   * 일시적 429 등으로 행이 사라지지 않도록, 클라이언트는 흐리게 표시하고 '갱신 실패'를 알린다.
   */
  stale?: boolean;
  /** 이 수치를 실제로 받아온 시각. stale 이면 마지막 성공 시각. */
  fetchedAt?: string;
}

/** GET /api/backends/usage — 서버가 아직 라우트를 안 올렸으면 404. */
export interface BackendUsageState {
  backends: Record<string, BackendUsage>;
}

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

/** 원클릭 백엔드 프리셋 (GET /api/backends/presets). */
export interface BackendPreset {
  id: string;
  label: string;
  desc: string;
  warn?: string;
  installed: boolean;
  backend: {
    type: string;
    label: string;
    baseURL: string;
    envKey: string;
    models: Record<string, string>;
  };
}

/**
 * 모델 티어 정의 — GET /api/backends 응답 루트의 `tiers`.
 * order 는 표시 순서(강한 것 → 약한 것), labels 는 티어 키 → 사람이 읽는 이름.
 * POST /api/backends/tiers 로 { order, labels } 를 통째로 덮어쓴다.
 */
export interface ModelTiers {
  order: string[];
  labels: Record<string, string>;
  /**
   * 티어 → 그 티어를 실행할 백엔드 id. null/키 없음 = 전역 백엔드를 따름.
   * 실제 결정 우선순위: agent.backendId(개별 지정) > 절약 모드 > 이 값 > 전역 activeBackend.
   */
  backends?: Record<string, string | null>;
}

export interface BackendsState {
  activeBackend: string;
  austerityMode: boolean;
  austerityBackend: string;
  /** 에이전트에 백엔드가 지정되지 않았을 때 쓰는 백엔드. null 이면 설정 안 함. */
  fallbackBackend?: string | null;
  backends: Record<string, BackendPublic>;
  /** 서버가 아직 티어를 안 올렸으면 undefined — 클라이언트가 기본 3티어로 폴백한다. */
  tiers?: ModelTiers;
}

/** POST /api/backends/apply-to-agents 응답 — previous 를 그대로 restore 로 돌려보내면 되돌려짐. */
export interface ApplyBackendToAgentsResult {
  updated: number;
  previous: Record<string, string | null>;
  /** 티어 되돌리기용 이전 상태 — { agentId: modelTier|null }. 그대로 restoreTiers 로 되쏜다. */
  previousTiers?: Record<string, string | null>;
  /** 적용한 백엔드 id 또는 'restore'. */
  applied?: string | null;
  /** 적용한 티어 키 또는 'restore'. */
  appliedTier?: string | null;
  scope?: string;
  total?: number;
  changed?: string[];
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

export interface DelegationTierStatsRow {
  tier: string;
  delegationCount: number;
  /** 워커가 <escalate> 를 남기고 완료된 건수 — 이 티어로는 실제로 모자랐다는 신호. */
  escalatedCount: number;
  escalationRate: number;
  /** 위임 JSON 이 티어를 명시적으로 지정한 건수 — 요청일 뿐 에스컬레이션과는 다른 축. */
  tierSpecifiedCount: number;
  totalTokens: number;
}

export interface DelegationTierStats {
  tiers: DelegationTierStatsRow[];
  totals: {
    delegationCount: number;
    escalatedCount: number;
    escalationRate: number;
    tierSpecifiedCount: number;
    totalTokens: number;
  };
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

/** data/user/calendar.json 의 이벤트 한 건 (docs/calendar-spec.md §1). */
export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Recurrence {
  freq: RecurrenceFreq;
  interval: number;
  /** 'YYYY-MM-DD', null 이면 무한 반복. */
  until: string | null;
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** allDay=true 면 'YYYY-MM-DD', 아니면 ISO8601(+09:00). */
  start: string;
  end: string | null;
  allDay: boolean;
  notes: string;
  location: string;
  color: string | null;
  tags: string[];
  projectId: string | null;
  agentId: string | null;
  source: 'user' | 'agent';
  recurrence: Recurrence | null;
  /** 반복에서 제외할 발생일 'YYYY-MM-DD'. */
  exdates: string[];
  /** 알림을 보낼 '시작 N분 전' 목록. 0 = 정시. */
  remindMinutes: number[];
  /** 서버가 전개한 반복 발생분이면 붙는다 — id 는 `masterId@YYYY-MM-DD`. */
  masterId?: string;
  isOccurrence?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST/PATCH /api/calendar 에 보낼 수 있는 필드들. */
export type CalendarEventInput = Partial<
  Pick<
    CalendarEvent,
    | 'title' | 'start' | 'end' | 'allDay' | 'notes' | 'location' | 'color'
    | 'tags' | 'projectId' | 'source' | 'recurrence' | 'remindMinutes'
  >
>;

export interface Holiday {
  /** 'YYYY-MM-DD' */
  date: string;
  name: string;
  /** 대체공휴일 여부. */
  substitute: boolean;
}

/** 예약 전송 대기 중인 메시지. runAt 이 되면 서버가 해당 세션으로 보낸다. */
export interface ScheduledMessage {
  id: string;
  sessionId: string;
  content: string;
  /** ISO 8601 — 전송 예정 시각. */
  runAt: string;
  status: 'pending' | 'sent' | 'canceled' | 'failed';
  createdAt: string;
}
