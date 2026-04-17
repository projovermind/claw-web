import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Star, Download, CheckSquare, Square, X, ChevronDown } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useChatStore } from '../../store/chat-store';
import type { Session, Agent, Project, BackendsState } from '../../lib/types';

/** 실제 호출되는 모델명을 해석해서 뱃지로 표시 */
function ModelBadge({ agent, backends }: { agent: Agent; backends?: BackendsState | null }) {
  const bid = (agent as { backendId?: string }).backendId;
  const backendModels = bid ? backends?.backends?.[bid]?.models : null;
  const resolved = backendModels?.[agent.model ?? ''] ?? agent.model;
  return (
    <span className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono text-[10px]">
      {bid && bid !== 'claude' && <span className="text-emerald-400 mr-1">{bid}</span>}
      {resolved}
    </span>
  );
}

/**
 * Chat sidebar — project-centric design.
 *
 * Instead of picking an agent first, the user picks a PROJECT.
 * The system automatically selects the project's lead agent (기획자).
 * Sessions are grouped under the selected project.
 *
 * Global agents (hivemind, general, etc.) appear in a separate "Global" group.
 */
export function ChatSidebar({
  agents,
  projects,
  sessions,
  currentAgentId,
  currentSessionId,
  setCurrentAgent,
  setCurrentSession,
  createSession,
  deleteSession
}: {
  agents: Agent[];
  projects: Project[];
  sessions: Session[];
  currentAgentId: string | null;
  currentSessionId: string | null;
  setCurrentAgent: (id: string) => void;
  setCurrentSession: (id: string | null) => void;
  createSession: { mutate: () => void; isPending?: boolean };
  deleteSession: { mutate: (id: string) => void };
}) {
  const qc = useQueryClient();
  const t = useT();
  const unread = useChatStore((s) => s.unread);
  const { data: backendsState } = useQuery({ queryKey: ['backends'], queryFn: api.backends });
  const { data: allSessionsData } = useQuery({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    refetchInterval: 3000
  });
  const runningSessions = useMemo(() => {
    const all = allSessionsData?.sessions ?? [];
    return all.filter((s: Session) => s.isRunning);
  }, [allSessionsData]);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);

  // Find the current agent's project
  const currentAgent = agents.find((a) => a.id === currentAgentId);
  const currentProject = currentAgent?.projectId
    ? projects.find((p) => p.id === currentAgent.projectId)
    : null;

  // Group: projects with their leads + global agents
  const projectsWithLeads = useMemo(() => {
    return projects.map((p) => {
      const lead = agents.find(
        (a) => a.projectId === p.id && a.tier === 'project'
      );
      return { project: p, lead };
    });
  }, [projects, agents]);

  const globalAgents = useMemo(
    () => agents.filter((a) => a.tier === 'main' || (!a.projectId && !a.tier)),
    [agents]
  );

  // Select a project → auto-connect to its lead
  const selectProject = (project: Project) => {
    const lead = agents.find(
      (a) => a.projectId === project.id && a.tier === 'project'
    );
    if (lead) {
      setCurrentAgent(lead.id);
    } else {
      // No lead — pick first agent in project
      const first = agents.find((a) => a.projectId === project.id);
      if (first) setCurrentAgent(first.id);
    }
    setCurrentSession(null);
    setProjectPickerOpen(false);
  };

  const selectGlobalAgent = (agent: Agent) => {
    setCurrentAgent(agent.id);
    setCurrentSession(null);
    setProjectPickerOpen(false);
  };

  const pinSession = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.pinSession(id, pinned),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] })
  });

  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => api.bulkDeleteSessions(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', currentAgentId] });
      if (currentSessionId && selectedIds.has(currentSessionId))
        setCurrentSession(null);
      setSelectMode(false);
      setSelectedIds(new Set());
    }
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportSession = async (id: string) => {
    try {
      await api.downloadSessionExport(id, 'md');
    } catch (err) {
      alert(`${t('chat.sidebar.exportFailed')}: ${(err as Error).message}`);
    }
  };

  // Display name for current context
  const contextLabel = currentProject
    ? currentProject.name
    : currentAgent
      ? currentAgent.name
      : t('chat.sidebar.selectProject');
  const contextColor = currentProject?.color ?? '#666';
  const contextSubLabel = currentAgent
    ? `${currentAgent.avatar ?? '🤖'} ${currentAgent.name}`
    : '';

  return (
    <aside className="hidden lg:flex w-64 shrink-0 border-r border-zinc-700/50 bg-zinc-900/50 flex-col">
      {/* Project/Agent picker */}
      <div className="p-3 border-b border-zinc-800 relative">
        <label className="text-[11px] uppercase tracking-wider text-zinc-500 block mb-1">
          {t('chat.sidebar.project')}
        </label>
        <button
          onClick={() => setProjectPickerOpen((v) => !v)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm flex items-center gap-2 hover:border-zinc-700"
        >
          <div
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: contextColor }}
          />
          <div className="flex-1 min-w-0 text-left">
            <div className="font-semibold truncate">{contextLabel}</div>
            {contextSubLabel && (
              <div className="text-[11px] text-zinc-500 truncate">
                → {contextSubLabel}
              </div>
            )}
          </div>
          <ChevronDown size={14} className="text-zinc-500 shrink-0" />
        </button>

        {/* Dropdown: main agents first, then projects */}
        {projectPickerOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden max-h-[500px] overflow-y-auto mx-3">
            {/* Running sessions — 최상단 */}
            {runningSessions.length > 0 && (
              <>
                <div className="px-2 py-1.5 text-[11px] uppercase tracking-wider text-amber-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  {t('dashboard.stat.running')} ({runningSessions.length})
                </div>
                {runningSessions.map((s: Session) => {
                  const agent = agents.find((a) => a.id === s.agentId);
                  return (
                    <button
                      key={s.id}
                      onClick={() => {
                        setCurrentAgent(s.agentId);
                        setCurrentSession(s.id);
                        setProjectPickerOpen(false);
                        // 에이전트가 바뀌면 세션 목록 즉시 갱신
                        qc.invalidateQueries({ queryKey: ['sessions', s.agentId] });
                        qc.invalidateQueries({ queryKey: ['session', s.id] });
                      }}
                      className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-zinc-800/60 ${
                        currentSessionId === s.id ? 'bg-zinc-800 text-white' : 'text-zinc-300'
                      }`}
                    >
                      <span className="text-base">{agent?.avatar ?? '🤖'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate">{s.title}</div>
                        <div className="text-[11px] text-zinc-500 truncate">{agent?.name ?? s.agentId}</div>
                      </div>
                      <span className="text-[10px] text-amber-400 shrink-0 animate-pulse">● running</span>
                    </button>
                  );
                })}
                <div className="border-b border-zinc-800" />
              </>
            )}

            {/* Main / Global agents — shown first */}
            {globalAgents.length > 0 && (
              <>
                <div className="px-2 py-1.5 text-[11px] uppercase tracking-wider text-zinc-500">
                  {t('chat.picker.main')}
                </div>
                {globalAgents.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => selectGlobalAgent(a)}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-zinc-800/60 ${
                      currentAgentId === a.id && !currentProject
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-300'
                    }`}
                  >
                    <span className="text-base">{a.avatar ?? '🤖'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">{a.name}</div>
                      <div className="text-[11px] text-zinc-500 font-mono flex items-center gap-1.5">
                        <span>{a.id}</span>
                        {a.model && <ModelBadge agent={a} backends={backendsState} />}
                      </div>
                    </div>
                  </button>
                ))}
              </>
            )}

            {/* Projects */}
            <div className="border-t border-zinc-800 px-2 py-1.5 text-[11px] uppercase tracking-wider text-zinc-500 mt-1">
              {t('nav.projects')}
            </div>
            {projectsWithLeads.map(({ project: p, lead }) => (
              <button
                key={p.id}
                onClick={() => selectProject(p)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-zinc-800/60 ${
                  currentProject?.id === p.id ? 'bg-zinc-800 text-white' : 'text-zinc-300'
                }`}
              >
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: p.color ?? '#666' }}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{p.name}</div>
                  <div className="text-[11px] text-zinc-500 truncate flex items-center gap-1.5">
                    <span>→ {lead?.name ?? lead?.id ?? t('chat.picker.noLead')}</span>
                    {lead?.model && <ModelBadge agent={lead} backends={backendsState} />}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Session list header */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">
          {t('chat.sidebar.sessions')}
        </span>
        {selectMode ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const ids = Array.from(selectedIds);
                if (ids.length === 0) return;
                if (confirm(t('chat.sidebar.deleteCountConfirm', { count: ids.length })))
                  bulkDelete.mutate(ids);
              }}
              disabled={selectedIds.size === 0}
              className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-40 flex items-center gap-1"
            >
              <Trash2 size={11} /> {t('chat.sidebar.deleteCount', { count: selectedIds.size })}
            </button>
            <button
              onClick={() => {
                setSelectMode(false);
                setSelectedIds(new Set());
              }}
              className="text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              <X size={11} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectMode(true)}
              className="text-[11px] text-zinc-500 hover:text-zinc-300"
              title={t('chat.sidebar.multiSelect')}
            >
              <CheckSquare size={11} />
            </button>
            <button
              onClick={() => createSession.mutate()}
              disabled={!currentAgentId}
              className="text-xs text-zinc-400 hover:text-white disabled:opacity-40 flex items-center gap-1"
            >
              <Plus size={12} /> {t('common.new')}
            </button>
          </div>
        )}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <div className="text-[11px] text-zinc-600 italic px-2 py-1">
            {t('chat.sidebar.noSessions')}
          </div>
        )}
        {sessions
          .slice()
          .sort((a, b) => {
            // 1순위: 안 읽음
            const au = unread[a.id] ? 1 : 0;
            const bu = unread[b.id] ? 1 : 0;
            if (au !== bu) return bu - au;
            // 2순위: 핀
            const ap = a.pinned ? 1 : 0;
            const bp = b.pinned ? 1 : 0;
            if (ap !== bp) return bp - ap;
            // 3순위: 최신
            return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
          })
          .map((s) => {
            const isSelected = selectedIds.has(s.id);
            const isDelegated = s.title?.startsWith('[위임]');
            const isUnread = !!unread[s.id];
            return (
              <div
                key={s.id}
                className={`group rounded px-2 py-1.5 mb-1 text-xs cursor-pointer flex items-center gap-1.5 ${
                  selectMode
                    ? isSelected
                      ? 'bg-emerald-900/30 text-emerald-100'
                      : 'text-zinc-400 hover:bg-zinc-900'
                    : currentSessionId === s.id
                      ? 'bg-zinc-800 text-white'
                      : 'text-zinc-400 hover:bg-zinc-900'
                }`}
                onClick={() => {
                  if (selectMode) toggleSelect(s.id);
                  else setCurrentSession(s.id);
                }}
              >
                {selectMode && (
                  <span className="shrink-0">
                    {isSelected ? (
                      <CheckSquare size={11} className="text-emerald-400" />
                    ) : (
                      <Square size={11} className="text-zinc-600" />
                    )}
                  </span>
                )}
                {!selectMode && isUnread && (
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0 animate-pulse" title="안 읽음" />
                )}
                {!selectMode && !isUnread && s.isRunning && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 animate-pulse" title="실행 중" />
                )}
                {!selectMode && s.pinned && (
                  <Star size={10} className="text-amber-400 shrink-0" fill="currentColor" />
                )}
                {!selectMode && isDelegated && (
                  <span className="text-[11px] text-sky-400 shrink-0">↗</span>
                )}
                <span className="flex-1 truncate">{s.title}</span>
                {!selectMode && (
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        pinSession.mutate({ id: s.id, pinned: !s.pinned });
                      }}
                      className={`p-0.5 rounded hover:bg-zinc-800 ${
                        s.pinned
                          ? 'text-amber-400'
                          : 'text-zinc-500 hover:text-amber-400'
                      }`}
                    >
                      <Star size={10} fill={s.pinned ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        exportSession(s.id);
                      }}
                      className="p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-sky-400"
                    >
                      <Download size={10} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(t('chat.sidebar.deleteConfirm', { title: s.title })))
                          deleteSession.mutate(s.id);
                      }}
                      className="p-0.5 rounded hover:bg-red-900/40 text-zinc-500 hover:text-red-400"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </aside>
  );
}
