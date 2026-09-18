import type {
  Agent,
  HealthStatus,
  WebSettings,
  Project,
  Device,
  DevicePing,
  Session,
  SessionMeta,
  ChatMessage,
  BackendsState,
  BackendPublic,
  BackendPreset,
  BackendUsageState,
  ApplyBackendToAgentsResult,
  ModelTiers,
  Skill,
  UsageCost,
  ActivityEntry,
  HookConfig,
  McpPreset,
  ClaudeMemoryList,
  UsageBudget,
  CalendarEvent,
  CalendarEventInput,
  Holiday,
  ScheduledMessage
} from './types';

const BASE = '/api';
const TOKEN_KEY = 'hivemind:auth-token';

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore storage errors */
  }
}

/**
 * Fired when any /api call returns 401 — UI listens for this to open a login dialog.
 */
export const authEvents = new EventTarget();

/** HTTP 상태코드를 보존하는 에러 — 409 등 분기가 필요한 호출부에서 사용. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined ?? {})
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    authEvents.dispatchEvent(new CustomEvent('unauthorized', { detail: { path } }));
  }
  if (!res.ok) {
    let body: { error?: string } | null = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw new ApiError(body?.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

const get = <T>(p: string) => req<T>(p);
const post = <T>(p: string, data: unknown) =>
  req<T>(p, { method: 'POST', body: JSON.stringify(data) });
const patch = <T>(p: string, data: unknown) =>
  req<T>(p, { method: 'PATCH', body: JSON.stringify(data) });
const del = <T>(p: string) => req<T>(p, { method: 'DELETE' });

export const api = {
  health: () => get<HealthStatus>('/health'),
  calendar: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return get<{ events: CalendarEvent[] }>(`/calendar${qs ? `?${qs}` : ''}`).then((r) => r.events);
  },
  calendarUpcoming: (days = 7) =>
    get<{ events: CalendarEvent[] }>(`/calendar/upcoming?days=${days}`).then((r) => r.events),
  createCalendarEvent: (data: CalendarEventInput) => post<{ event: CalendarEvent }>('/calendar', data).then((r) => r.event),
  patchCalendarEvent: (id: string, data: CalendarEventInput) =>
    patch<{ event: CalendarEvent }>(`/calendar/${encodeURIComponent(id)}`, data).then((r) => r.event),
  /** scope='occurrence' 면 반복 발생분 1회차만 제외(마스터의 exdates 에 추가). */
  deleteCalendarEvent: (id: string, scope?: 'occurrence' | 'series') =>
    del<{ ok: true }>(`/calendar/${encodeURIComponent(id)}${scope ? `?scope=${scope}` : ''}`),
  calendarHolidays: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return get<{ holidays: Holiday[] }>(`/calendar/holidays${qs ? `?${qs}` : ''}`).then((r) => r.holidays);
  },
  calendarChatSession: () => get<{ sessionId: string }>('/calendar/chat-session'),
  agents: () => get<{ agents: Agent[] }>('/agents').then((r) => r.agents),
  agent: (id: string) => get<Agent>(`/agents/${id}`),
  createAgent: (data: Partial<Agent> & { id: string; name: string }) => post<Agent>('/agents', data),
  patchAgent: (id: string, body: Partial<Agent>, opts: { ifMatchUpdatedAt?: string } = {}) =>
    req<Agent>(`/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: opts.ifMatchUpdatedAt ? { 'If-Match-UpdatedAt': opts.ifMatchUpdatedAt } : undefined
    }),
  deleteAgent: (id: string) => del<void>(`/agents/${id}`),
  cloneAgent: (id: string, newId: string, newName?: string) =>
    post<Agent>(`/agents/${id}/clone`, { newId, newName }),
  projects: () => get<{ projects: Project[] }>('/projects').then((r) => r.projects),
  createProject: (data: Project) => post<Project>('/projects', data),
  patchProject: (id: string, data: Partial<Project>) => patch<Project>(`/projects/${id}`, data),
  deleteProject: (id: string) => del<void>(`/projects/${id}`),
  devices: () => get<{ devices: Device[] }>('/devices').then((r) => r.devices),
  createDevice: (data: Device) => post<Device>('/devices', data),
  patchDevice: (id: string, data: Partial<Device>) => patch<Device>(`/devices/${id}`, data),
  deleteDevice: (id: string) => del<void>(`/devices/${id}`),
  pingDevice: (id: string) => get<DevicePing>(`/devices/${id}/ping`),
  readProjectMd: (id: string, filename = 'CLAUDE.md') =>
    get<{ filename: string; exists: boolean; size: number; mtimeMs: number; content: string; filePath: string }>(
      filename === 'CLAUDE.md' ? `/projects/${id}/md` : `/projects/${id}/md/${filename}`
    ),
  writeProjectMd: (
    id: string,
    content: string,
    opts: { ifMatchMtime?: number; filename?: string } = {}
  ) => {
    const filename = opts.filename ?? 'CLAUDE.md';
    const body: { content: string; ifMatchMtime?: number } = { content };
    if (opts.ifMatchMtime !== undefined) body.ifMatchMtime = opts.ifMatchMtime;
    return req<{ filename: string; exists: boolean; size: number; mtimeMs: number; filePath: string }>(
      filename === 'CLAUDE.md' ? `/projects/${id}/md` : `/projects/${id}/md/${filename}`,
      { method: 'PUT', body: JSON.stringify(body) }
    );
  },
  sessions: (agentId?: string) =>
    get<{ sessions: SessionMeta[]; activeIds: string[] }>(
      `/sessions${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`
    ).then((r) => r.sessions),
  allSessions: () =>
    get<{ sessions: SessionMeta[]; activeIds: string[] }>('/sessions'),
  session: (id: string, limit = 50) =>
    get<Session>(`/sessions/${id}?limit=${limit}`),
  /** Fetch up to `limit` messages strictly older than `before` (ISO ts). */
  olderMessages: (id: string, before: string, limit = 50) =>
    get<{ messages: ChatMessage[]; hasMoreBefore: boolean }>(
      `/sessions/${id}/messages?before=${encodeURIComponent(before)}&limit=${limit}`
    ),
  createSession: (agentId: string, title?: string) =>
    post<Session>('/sessions', { agentId, title }),
  renameSession: (id: string, title: string) => patch<Session>(`/sessions/${id}`, { title }),
  pinSession: (id: string, pinned: boolean) => patch<Session>(`/sessions/${id}`, { pinned }),
  setSessionModel: (id: string, model: string | null) =>
    patch<Session>(`/sessions/${id}`, { model }),
  deleteSession: (id: string) => del<void>(`/sessions/${id}`),
  bulkDeleteSessions: (ids: string[]) =>
    post<{ deleted: number; skipped: number; total: number }>(`/sessions/bulk-delete`, { ids }),
  /**
   * Download a session as .md or .json. Does a token-aware fetch (auth may be
   * on), then triggers a browser download via an ObjectURL.
   */
  downloadSessionExport: async (id: string, format: 'md' | 'json' = 'md') => {
    const token = getAuthToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE}/sessions/${id}/export?format=${format}`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const blob = await res.blob();
    // Try to recover filename from Content-Disposition, fall back to id
    const cd = res.headers.get('content-disposition') ?? '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] ?? `${id}.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  sendMessage: (sessionId: string, message: string, attachmentPaths: string[] = []) =>
    post<{ sessionId: string; status: string }>('/chat', { sessionId, message, attachmentPaths }),
  abortChat: (sessionId: string) => del<{ aborted: boolean }>(`/chat/${sessionId}`),
  deleteQueued: (sessionId: string, ts: string) =>
    del<{ sessionId: string; queueLength: number }>(`/chat/${sessionId}/queue/${encodeURIComponent(ts)}`),
  mergeQueued: (sessionId: string) =>
    post<{ sessionId: string; queueLength: number }>(`/chat/${sessionId}/queue/merge`, {}),
  approveTool: (
    sessionId: string,
    reqId: string,
    payload: {
      behavior: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>;
      message?: string;
      /** Legacy — `true` ⇔ scope:'always'. 신규 코드는 `scope` 사용. */
      remember?: boolean;
      /** 'once' (기본) | 'session' (이 세션 내 자동 허용) | 'always' (영구) */
      scope?: 'once' | 'session' | 'always';
    }
  ) => post<{ ok: boolean }>(`/chat/${sessionId}/approval/${reqId}`, payload),
  startLoop: (sessionId: string, prompt: string, maxIterations = 10, completionPromise = 'DONE') =>
    post<{ sessionId: string; loop: string }>(`/sessions/${sessionId}/loop`, {
      prompt,
      maxIterations,
      completionPromise
    }),
  stopLoop: (sessionId: string) => del<{ sessionId: string; loop: string }>(`/sessions/${sessionId}/loop`),
  // 예약 전송 — 서버가 runAt 에 해당 세션으로 메시지를 대신 보낸다.
  scheduledMessages: (sessionId: string) =>
    get<{ scheduled?: ScheduledMessage[] } | ScheduledMessage[]>(
      `/scheduled-messages?sessionId=${encodeURIComponent(sessionId)}`
    ).then((r) => (Array.isArray(r) ? r : r.scheduled ?? [])),
  createScheduledMessage: (sessionId: string, content: string, runAt: string) =>
    post<{ scheduled: ScheduledMessage }>('/scheduled-messages', { sessionId, content, runAt }).then(
      (r) => r.scheduled
    ),
  cancelScheduledMessage: (id: string) =>
    del<{ ok: true }>(`/scheduled-messages/${encodeURIComponent(id)}`),
  settings: () => get<WebSettings>('/settings'),
  getSettings: () => get<WebSettings>('/settings'),
  patchSettings: (patch: {
    features?: Record<string, boolean>;
    auth?: { enabled?: boolean; token?: string | null };
    appearance?: {
      appName?: string;
      userBubbleColor?: string;
      assistantBubbleColor?: string;
      soundEnabled?: boolean;
      soundVolume?: number;
    };
    editor?: {
      scheme?: 'off' | 'vscode' | 'cursor';
      pathMap?: Record<string, string>;
    };
    chat?: { autoCompactPct?: number };
    usage?: { budget5h?: number; budget7d?: number };
  }) =>
    patch === undefined ? Promise.reject(new Error('patch is required')) : req<WebSettings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  backends: () => get<BackendsState>('/backends'),
  createBackend: (data: {
    id: string;
    type: 'openai-compatible' | 'claude-cli';
    label: string;
    baseURL?: string;
    envKey?: string;
    models?: Record<string, string>;
    secret?: string;
    priority?: number;
  }) => post<BackendPublic>('/backends', data),
  patchBackend: (id: string, data: Partial<BackendPublic>) => patch<BackendPublic>(`/backends/${id}`, data),
  /** 백엔드별 잔여 한도. 서버에 라우트가 없으면 404 — 호출부에서 게이지 미표시로 처리. */
  backendsUsage: () => get<BackendUsageState>('/backends/usage'),
  setBackendSecret: (id: string, value: string | null) =>
    req<BackendPublic>(`/backends/${id}/secret`, {
      method: 'PUT',
      body: JSON.stringify({ value })
    }),
  revealBackendSecret: (id: string, password: string) =>
    post<{
      secret: { envKey: string; value: string } | null;
      oauthToken: string | null;
      claudeCreds: {
        source: 'credentials.json' | 'keychain';
        path?: string;
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: string;
        scopes?: string[];
        subscriptionType?: string;
      } | null;
      env: Record<string, string> | null;
    }>(`/backends/${id}/reveal`, { password }),
  deleteBackend: (id: string) => del<void>(`/backends/${id}`),
  backendPresets: () =>
    get<{ presets: BackendPreset[] }>('/backends/presets').then((r) => r.presets),
  applyBackendPreset: (id: string) => post<BackendPublic>(`/backends/presets/${id}/apply`, {}),
  setActiveBackend: (backendId: string) => post<{ activeBackend: string }>('/backends/active', { backendId }),
  setAusterity: (enabled: boolean, backendId?: string) =>
    post<{ austerityMode: boolean }>('/backends/austerity', { enabled, backendId }),
  /** 에이전트에 백엔드가 없을 때 쓰는 폴백. null 이면 설정 해제. */
  setFallbackBackend: (backendId: string | null) =>
    post<{ fallbackBackend: string | null }>('/backends/fallback', { backendId }),
  /**
   * 모든 에이전트의 backendId 를 일괄 변경. backendId: null 이면 전역 설정을 따르게 함.
   * 응답의 previous 를 { restore } 로 다시 보내면 되돌아간다.
   */
  applyBackendToAgents: (
    body:
      | { backendId: string | null; projectId?: string }
      | { modelTier: string | null; projectId?: string }
      | { restore: Record<string, string | null> }
      | { restoreTiers: Record<string, string | null> }
  ) => post<ApplyBackendToAgentsResult>('/backends/apply-to-agents', body),
  /**
   * 모델 티어 정의를 통째로 저장 (추가/이름변경/삭제 전부 이 한 번의 호출).
   * order 에서 빠진 티어는 삭제된 것으로 취급된다.
   */
  setBackendTiers: (body: {
    order: string[];
    labels: Record<string, string>;
    /** 티어 → 백엔드 id. 지정된 티어가 하나도 없으면 아예 보내지 않는다. */
    backends?: Record<string, string>;
  }) =>
    post<{ tiers: ModelTiers }>('/backends/tiers', body).then((r) => r.tiers),
  skills: () => get<{ skills: Skill[] }>('/skills').then((r) => r.skills),
  skill: (id: string) => get<Skill>(`/skills/${id}`),
  createSkill: (data: { name: string; description?: string; content?: string }) =>
    post<Skill>('/skills', data),
  /** GitHub 의 SKILL.md URL 을 그대로 넣어 스킬로 수입. 같은 이름이 있으면 409. */
  importSkillUrl: (data: { url: string; triggers?: string[]; alwaysOn?: boolean }) =>
    post<Skill>('/skills/import-url', data),
  patchSkill: (id: string, data: Partial<Omit<Skill, 'id'>>) => patch<Skill>(`/skills/${id}`, data),
  deleteSkill: (id: string) => del<void>(`/skills/${id}`),
  refreshSystemSkills: () => post<{ count: number }>('/skills/system/refresh', {}),
  assignSkillToAgents: (skillId: string, agentIds: string[]) =>
    post<{ skillId: string; assigned: number; agentIds: string[] }>(
      `/skills/${skillId}/assign`,
      { agentIds }
    ),
  unassignSkillFromAgents: (skillId: string, agentIds: string[]) =>
    post<{ skillId: string; unassigned: number; agentIds: string[] }>(
      `/skills/${skillId}/unassign`,
      { agentIds }
    ),
  activity: (limit = 50) =>
    get<{ entries: ActivityEntry[] }>(`/activity?limit=${limit}`).then((r) => r.entries),
  fsRoots: () => get<{ roots: { path: string; name: string }[] }>(`/fs/roots`),
  fsLs: (p: string) =>
    get<{
      path: string;
      parent: string | null;
      entries: { name: string; path: string }[];
    }>(`/fs/ls?path=${encodeURIComponent(p)}`),
  fsMkdir: (parent: string, name: string) =>
    post<{ path: string; name: string }>(`/fs/mkdir`, { path: parent, name }),
  fsSearch: (root: string, q: string, limit = 30) =>
    get<{
      root: string;
      results: { name: string; path: string; rel: string }[];
    }>(`/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&limit=${limit}`),
  fsTree: (p: string) =>
    get<{
      path: string;
      parent: string | null;
      entries: { name: string; path: string; kind: 'dir' | 'file'; size?: number; mtime?: string }[];
    }>(`/fs/tree?path=${encodeURIComponent(p)}`),
  agentStats: () =>
    get<{
      agents: {
        id: string;
        name: string;
        sessionCount: number;
        messageCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        lastActive: string | null;
      }[];
    }>('/stats/agents'),
  usageStats: () =>
    get<{
      window5h: { inputTokens: number; outputTokens: number; total: number };
      window7d: { inputTokens: number; outputTokens: number; total: number };
      /** 비용 추적 도입 전 서버는 이 필드를 보내지 않음 */
      cost?: UsageCost;
      /** 예산 도입 전 서버는 이 필드를 보내지 않음 */
      budget?: UsageBudget;
    }>('/stats/usage'),
  tunnelUrl: () => get<{ url: string | null; file: string }>(`/tunnel/url`),

  // Claude CLI 관리 (Admin)
  claudeStatus: () =>
    get<{ status: 'ok' | 'broken' | 'missing' | 'error'; bin: string | null; version: string | null; error: string | null; installing: boolean }>(`/admin/claude/status`),
  claudeInstall: (reinstall = false) =>
    post<{ ok: boolean; message: string; startedAt: string }>(`/admin/claude/install`, { reinstall }),
  claudeLogin: () =>
    post<{
      ok: boolean;
      message: string;
      manual?: boolean;
      command?: string;
      platform?: string;
      shell?: string;
      hint?: string;
    }>(`/admin/claude/login`, {}),
  /**
   * Upload a file (from drag-drop or clipboard paste) to the server's
   * /api/uploads endpoint. Base64-encodes the bytes and attaches the auth
   * token if one is stored. Returns the StagedUpload metadata.
   */
  // Background Tasks
  startTask: (command: string, sessionId?: string, cwd?: string) =>
    post<{ id: string; pid: number | null; status: string; startedAt: string }>('/tasks', { sessionId, command, cwd }),
  listTasks: () =>
    get<{ tasks: { id: string; sessionId: string | null; command: string; status: string; exitCode: number | null; startedAt: string; completedAt: string | null }[] }>('/tasks').then((r) => r.tasks),
  getTask: (id: string) =>
    get<{ id: string; sessionId: string | null; command: string; cwd: string; pid: number | null; status: string; stdout: string; stderr: string; exitCode: number | null; startedAt: string; completedAt: string | null }>(`/tasks/${id}`),
  killTask: (id: string) => del<{ killed: boolean; id: string }>(`/tasks/${id}`),

  // Hooks
  listHooks: () => get<{ hooks: HookConfig[] }>('/hooks').then((r) => r.hooks),
  createHook: (data: Omit<HookConfig, 'id' | 'enabled'> & { enabled?: boolean }) =>
    post<HookConfig>('/hooks', data),
  patchHook: (id: string, data: Partial<Omit<HookConfig, 'id'>>) =>
    patch<HookConfig>(`/hooks/${id}`, data),
  deleteHook: (id: string) => del<void>(`/hooks/${id}`),

  // MCP Servers
  getMcpServers: () =>
    get<{ mcpServers: Record<string, unknown>; path: string }>('/mcp/servers'),
  putMcpServers: (mcpServers: Record<string, unknown>) =>
    req<{ mcpServers: Record<string, unknown>; path: string }>('/mcp/servers', { method: 'PUT', body: JSON.stringify({ mcpServers }) }),
  /** 계약: 프리셋 배열을 그대로 반환. 래핑된 `{presets}` 응답도 받아들인다. */
  mcpPresets: (): Promise<McpPreset[]> =>
    get<McpPreset[] | { presets: McpPreset[] }>('/mcp/presets').then((r) =>
      Array.isArray(r) ? r : r?.presets ?? []
    ),
  /** 같은 키가 이미 있으면 409 (ApiError.status 로 분기). */
  applyMcpPreset: (id: string) =>
    post<{ mcpServers: Record<string, unknown> }>(`/mcp/presets/${id}/apply`, {}),

  // Claude 자동 메모리 (~/.claude/projects/<slug>/memory)
  claudeMemory: (projectId: string) =>
    get<ClaudeMemoryList>(`/projects/${projectId}/claude-memory`),
  claudeMemoryFile: (projectId: string, file: string) =>
    get<{ name?: string; content: string }>(
      `/projects/${projectId}/claude-memory/${encodeURIComponent(file)}`
    ),
  putClaudeMemoryFile: (projectId: string, file: string, content: string) =>
    req<{ name?: string; content: string }>(
      `/projects/${projectId}/claude-memory/${encodeURIComponent(file)}`,
      { method: 'PUT', body: JSON.stringify({ content }) }
    ),

  // Git Worktrees
  createWorktree: (projectId: string, branch: string) =>
    post<{ path: string; branch: string }>('/worktree/create', { projectId, branch }),
  listWorktrees: (projectId: string) =>
    get<{ worktrees: { path: string; branch: string; head: string; bare: boolean }[] }>(`/worktree/list?projectId=${encodeURIComponent(projectId)}`),
  removeWorktree: (worktreePath: string) =>
    del<{ removed: boolean }>(`/worktree/${encodeURIComponent(worktreePath)}`),

  // Scheduled Tasks
  listSchedules: () =>
    get<{ schedules: { id: string; name: string; cron: string; agentId: string; prompt: string; enabled: boolean; lastRunAt: string | null; lastStatus: string | null }[] }>('/schedules').then((r) => r.schedules),
  createSchedule: (data: { name: string; cron: string; agentId: string; prompt: string; enabled?: boolean }) =>
    post<{ id: string; name: string; cron: string; agentId: string; prompt: string; enabled: boolean; lastRunAt: string | null; lastStatus: string | null }>('/schedules', data),
  patchSchedule: (id: string, data: Record<string, unknown>) =>
    patch<{ id: string; name: string; cron: string; agentId: string; prompt: string; enabled: boolean; lastRunAt: string | null; lastStatus: string | null }>(`/schedules/${id}`, data),
  deleteSchedule: (id: string) => del<void>(`/schedules/${id}`),

  // LSP
  lspDefinition: (file: string, line: number, character: number, projectId: string) =>
    post<{ locations: { file: string; line: number; text: string }[] }>('/lsp/definition', { file, line, character, projectId }),
  lspReferences: (file: string, line: number, character: number, projectId: string) =>
    post<{ locations: { file: string; line: number; text: string }[] }>('/lsp/references', { file, line, character, projectId }),
  lspHover: (file: string, line: number, character: number, projectId: string) =>
    post<{ content: string; line: number }>('/lsp/hover', { file, line, character, projectId }),

  undoAction: () => req<{ description: string }>('/undo', { method: 'POST', body: JSON.stringify({}) }),

  // Push Notifications
  pushVapidPublicKey: () => get<{ publicKey: string }>('/push/vapid-public-key'),
  pushSubscribe: (sub: { endpoint: string; keys: Record<string, string> }) =>
    post<{ ok: boolean }>('/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) =>
    req<{ ok: boolean }>('/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }),
  pushActivity: () =>
    req<void>('/push/activity', { method: 'POST', body: JSON.stringify({}) }),
  pushSaveSettings: (data: { enabled?: boolean; idleThreshold?: number }) =>
    req<unknown>('/settings', { method: 'PATCH', body: JSON.stringify({ push: data }) }),

  // Accounts (multi-account)
  listAccounts: () =>
    get<{ accounts: import('./types').Account[] }>('/accounts').then((r) => r.accounts),
  createAccount: (data: { label: string; configDir?: string; priority?: number; models?: Record<string, string> }) =>
    post<import('./types').Account>('/accounts', data),
  patchAccount: (id: string, data: { label?: string; configDir?: string; status?: string; priority?: number; models?: Record<string, string> }) =>
    patch<import('./types').Account>(`/accounts/${id}`, data),
  deleteAccount: (id: string) =>
    del<void>(`/accounts/${id}`),
  testAccount: (id: string) =>
    post<{ ok: boolean; configDir: string; output?: string; error?: string; autoActivated?: boolean }>(`/accounts/${id}/test`, {}),
  loginAccount: (id: string) =>
    post<{
      ok: boolean;
      message?: string;
      command?: string;
      error?: string;
      manual?: boolean;
      /** node process.platform — 'darwin' | 'win32' | 'linux' | ... */
      platform?: string;
      /** 명령을 붙여넣을 셸 (예: 'zsh', 'powershell', 'bash') */
      shell?: string;
      /** 사람이 읽는 안내 문구. 있으면 클라이언트 기본 문구보다 우선. */
      hint?: string;
    }>(`/accounts/${id}/login`, {}),
  setAccountOAuthToken: (id: string, token: string | null) =>
    req<{ ok: boolean; hasToken: boolean; account: import('./types').Account }>(`/accounts/${id}/oauth-token`, {
      method: 'PUT',
      body: JSON.stringify({ token }),
    }),
  exportAccount: (id: string) =>
    get<{
      accountId: string; label: string; exportedAt: string;
      credentialsJson?: string; claudeJson?: string; managedOAuthToken?: string; warn?: string;
    }>(`/accounts/${id}/export`),
  importAccount: (id: string, data: { credentialsJson?: string; claudeJson?: string }) =>
    post<{ ok: boolean; written: string[]; account: import('./types').Account }>(`/accounts/${id}/import`, data),
  startHeadlessLogin: (id: string) =>
    post<{ ok: boolean; status: string; urls: string[]; output: string; ttyRequired: boolean }>(`/accounts/${id}/login/headless`, {}),
  pollHeadlessLogin: (id: string) =>
    get<{ ok: boolean; status: string; urls?: string[]; output?: string; exitCode?: number; error?: string }>(`/accounts/${id}/login/headless`),
  sendHeadlessLoginCode: (id: string, code: string) =>
    post<{ ok: boolean }>(`/accounts/${id}/login/headless/code`, { code }),
  abortHeadlessLogin: (id: string) =>
    del<{ ok: boolean }>(`/accounts/${id}/login/headless`),

  delegations: () => get<{ delegations: import('./types').DelegationEntry[] }>('/delegations').then(r => r.delegations),

  // Workspace layout sync — 뷰(viewId) 단위. 처음 보는 viewId 는 다른 뷰의
  // 레이아웃을 복제해 주지 않고 빈 결과를 내려준다(seeded 는 항상 false —
  // 복제 시드 기능이 사라진 뒤 남은 호환용 필드라 클라이언트는 쓰지 않는다).
  getWorkspaceLayout: (viewId: string) =>
    get<{
      viewId: string;
      seeded: boolean;
      workspaces: unknown[] | null;
      activeWorkspaceId: string | null;
      updatedAt: string | null;
      updatedBy: string | null;
    }>(`/workspace-layout?viewId=${encodeURIComponent(viewId)}`),
  setWorkspaceLayout: (data: {
    viewId: string;
    workspaces: unknown[];
    activeWorkspaceId: string;
    clientId: string;
  }) =>
    req<{
      viewId: string;
      workspaces: unknown[];
      activeWorkspaceId: string;
      updatedAt: string;
      updatedBy: string | null;
    }>('/workspace-layout', { method: 'PUT', body: JSON.stringify(data) }),

  uploadFile: async (file: File): Promise<{
    id: string;
    filename: string;
    contentType: string;
    size: number;
    path: string;
    createdAt: string;
  }> => {
    // Must match server/routes/uploads.js MAX_BYTES — any file type allowed.
    const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
    const UPLOAD_TIMEOUT_MS = 300_000;

    const name = file.name || 'pasted-image.png';
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      throw new Error(`파일이 너무 큽니다 (${mb}MB, 최대 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`);
    }

    // Send the raw binary directly (no base64) so large zip/exe/installers
    // transfer efficiently and bypass the JSON body-size limit.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const token = getAuthToken();
      // Always octet-stream on the wire so the global express.json parser
      // never intercepts (e.g. uploading a .json file). True type goes in a
      // custom header for server-side image detection.
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Content-Type': file.type || 'application/octet-stream'
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${BASE}/uploads/raw?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers,
        body: file,
        signal: controller.signal
      });
      if (res.status === 401) {
        authEvents.dispatchEvent(new CustomEvent('unauthorized', { detail: { path: '/uploads/raw' } }));
      }
      if (!res.ok) {
        let body: { error?: string } | null = null;
        try { body = await res.json(); } catch { body = null; }
        throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`업로드 시간 초과 (${UPLOAD_TIMEOUT_MS / 1000}초)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
};
