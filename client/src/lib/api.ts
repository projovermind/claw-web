import type {
  Agent,
  HealthStatus,
  WebSettings,
  Project,
  Session,
  BackendsState,
  BackendPublic,
  Skill,
  ActivityEntry
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
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
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
    get<{ sessions: Session[]; activeIds: string[] }>(
      `/sessions${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`
    ).then((r) => r.sessions),
  allSessions: () =>
    get<{ sessions: Session[]; activeIds: string[] }>('/sessions'),
  session: (id: string) => get<Session>(`/sessions/${id}`),
  createSession: (agentId: string, title?: string) =>
    post<Session>('/sessions', { agentId, title }),
  renameSession: (id: string, title: string) => patch<Session>(`/sessions/${id}`, { title }),
  pinSession: (id: string, pinned: boolean) => patch<Session>(`/sessions/${id}`, { pinned }),
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
  startLoop: (sessionId: string, prompt: string, maxIterations = 10, completionPromise = 'DONE') =>
    post<{ sessionId: string; loop: string }>(`/sessions/${sessionId}/loop`, {
      prompt,
      maxIterations,
      completionPromise
    }),
  stopLoop: (sessionId: string) => del<{ sessionId: string; loop: string }>(`/sessions/${sessionId}/loop`),
  settings: () => get<WebSettings>('/settings'),
  getSettings: () => get<WebSettings>('/settings'),
  patchSettings: (patch: {
    features?: Record<string, boolean>;
    auth?: { enabled?: boolean; token?: string | null };
    appearance?: {
      appName?: string;
      userBubbleColor?: string;
      assistantBubbleColor?: string;
    };
  }) =>
    patch === undefined ? Promise.reject(new Error('patch is required')) : req<WebSettings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  backends: () => get<BackendsState>('/backends'),
  createBackend: (data: {
    id: string;
    type: 'openai-compatible';
    label: string;
    baseURL: string;
    envKey: string;
    models: Record<string, string>;
    secret?: string;
  }) => post<BackendPublic>('/backends', data),
  patchBackend: (id: string, data: Partial<BackendPublic>) => patch<BackendPublic>(`/backends/${id}`, data),
  setBackendSecret: (id: string, value: string | null) =>
    req<BackendPublic>(`/backends/${id}/secret`, {
      method: 'PUT',
      body: JSON.stringify({ value })
    }),
  deleteBackend: (id: string) => del<void>(`/backends/${id}`),
  setActiveBackend: (backendId: string) => post<{ activeBackend: string }>('/backends/active', { backendId }),
  setAusterity: (enabled: boolean, backendId?: string) =>
    post<{ austerityMode: boolean }>('/backends/austerity', { enabled, backendId }),
  skills: () => get<{ skills: Skill[] }>('/skills').then((r) => r.skills),
  skill: (id: string) => get<Skill>(`/skills/${id}`),
  createSkill: (data: { name: string; description?: string; content?: string }) =>
    post<Skill>('/skills', data),
  patchSkill: (id: string, data: Partial<Omit<Skill, 'id'>>) => patch<Skill>(`/skills/${id}`, data),
  deleteSkill: (id: string) => del<void>(`/skills/${id}`),
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
  tunnelUrl: () => get<{ url: string | null; file: string }>(`/tunnel/url`),
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
  listHooks: () =>
    get<{ hooks: { id: string; event: string; matcher: string; action: string; command: string; enabled: boolean }[] }>('/hooks').then((r) => r.hooks),
  createHook: (data: { event: string; matcher: string; action: string; command: string; enabled?: boolean }) =>
    post<{ id: string; event: string; matcher: string; action: string; command: string; enabled: boolean }>('/hooks', data),
  patchHook: (id: string, data: Record<string, unknown>) =>
    patch<{ id: string; event: string; matcher: string; action: string; command: string; enabled: boolean }>(`/hooks/${id}`, data),
  deleteHook: (id: string) => del<void>(`/hooks/${id}`),

  // MCP Servers
  getMcpServers: () =>
    get<{ mcpServers: Record<string, unknown>; path: string }>('/mcp/servers'),
  putMcpServers: (mcpServers: Record<string, unknown>) =>
    req<{ mcpServers: Record<string, unknown>; path: string }>('/mcp/servers', { method: 'PUT', body: JSON.stringify({ mcpServers }) }),

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

  uploadFile: async (file: File): Promise<{
    id: string;
    filename: string;
    contentType: string;
    size: number;
    path: string;
    createdAt: string;
  }> => {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const dataBase64 = btoa(binary);
    return post('/uploads', {
      filename: file.name || 'pasted-image.png',
      contentType: file.type || 'application/octet-stream',
      dataBase64
    });
  }
};
