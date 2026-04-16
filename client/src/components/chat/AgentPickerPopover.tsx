import { useState, useMemo, useEffect, useRef } from 'react';
import { Search, ChevronDown, Crown, Boxes, Inbox } from 'lucide-react';
import type { Agent, Project } from '../../lib/types';

interface Props {
  agents: Agent[];
  projects: Project[];
  currentId: string | null;
  onSelect: (id: string) => void;
}

export default function AgentPickerPopover({ agents, projects, currentId, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = agents.find((a) => a.id === currentId) ?? null;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Focus search on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.id.toLowerCase().includes(q) ||
        (a.name ?? '').toLowerCase().includes(q) ||
        (a.model ?? '').toLowerCase().includes(q) ||
        (a.projectId ?? '').toLowerCase().includes(q)
    );
  }, [agents, search]);

  // Grouped: main, per-project, unassigned
  const groups = useMemo(() => {
    const main = filtered.filter((a) => a.tier === 'main');
    const byProject = new Map<string, Agent[]>();
    for (const p of projects) byProject.set(p.id, []);
    for (const a of filtered) {
      if ((a.tier === 'project' || a.tier === 'addon') && a.projectId) {
        if (!byProject.has(a.projectId)) byProject.set(a.projectId, []);
        byProject.get(a.projectId)!.push(a);
      }
    }
    // Sort each sub-list by the user-set order (from agent hierarchy drag)
    const byOrd = (x: Agent, y: Agent) => {
      const xo = typeof x.order === 'number' ? x.order : 9999;
      const yo = typeof y.order === 'number' ? y.order : 9999;
      return xo !== yo ? xo - yo : (x.id ?? '').localeCompare(y.id ?? '');
    };
    main.sort(byOrd);
    for (const list of byProject.values()) list.sort(byOrd);
    const unassigned = filtered
      .filter((a) => !a.tier || (a.tier !== 'main' && a.tier !== 'project' && a.tier !== 'addon'))
      .sort(byOrd);

    return { main, byProject, unassigned };
  }, [filtered, projects]);

  const handleSelect = (id: string) => {
    onSelect(id);
    setOpen(false);
    setSearch('');
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm flex items-center gap-2 hover:border-zinc-700"
      >
        {current ? (
          <>
            <span className="text-lg">{current.avatar ?? '🤖'}</span>
            <div className="flex-1 min-w-0 text-left">
              <div className="font-semibold truncate">{current.name}</div>
              <div className="text-[11px] text-zinc-500 font-mono truncate">{current.id}</div>
            </div>
          </>
        ) : (
          <span className="text-zinc-500">— 에이전트 선택 —</span>
        )}
        <ChevronDown size={14} className="text-zinc-500" />
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 right-0 z-50 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[500px]">
          <div className="flex items-center gap-2 p-2 border-b border-zinc-800">
            <Search size={14} className="text-zinc-500" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="이름 / id / 모델 / 프로젝트 검색"
              className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-zinc-600"
              style={{ fontSize: '14px' }}
            />
            <div className="text-[11px] text-zinc-600 font-mono">{filtered.length}</div>
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {groups.main.length > 0 && (
              <Group icon={<Crown size={12} className="text-amber-400" />} label="Main">
                {groups.main.map((a) => (
                  <AgentRow key={a.id} agent={a} active={a.id === currentId} onSelect={handleSelect} />
                ))}
              </Group>
            )}

            {projects.map((p) => {
              const list = groups.byProject.get(p.id) ?? [];
              if (list.length === 0) return null;
              return (
                <Group
                  key={p.id}
                  icon={<span className="w-1.5 h-1.5 rounded-full block" style={{ background: p.color ?? '#666' }} />}
                  label={p.name}
                >
                  {list.map((a) => (
                    <AgentRow key={a.id} agent={a} active={a.id === currentId} onSelect={handleSelect} />
                  ))}
                </Group>
              );
            })}

            {groups.unassigned.length > 0 && (
              <Group icon={<Inbox size={12} className="text-zinc-500" />} label="Unassigned">
                {groups.unassigned.map((a) => (
                  <AgentRow key={a.id} agent={a} active={a.id === currentId} onSelect={handleSelect} />
                ))}
              </Group>
            )}

            {filtered.length === 0 && (
              <div className="text-[11px] text-zinc-600 italic px-3 py-8 text-center">결과 없음</div>
            )}
          </div>

          <div className="px-3 py-1.5 border-t border-zinc-800 text-[11px] text-zinc-600 flex items-center gap-2">
            <Boxes size={10} />
            <span>{agents.length}개 에이전트 · {projects.length}개 프로젝트</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Group({
  icon,
  label,
  children
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-1 pb-1">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-wider text-zinc-500">
        {icon}
        <span>{label}</span>
      </div>
      <div>{children}</div>
    </div>
  );
}

function AgentRow({
  agent,
  active,
  onSelect
}: {
  agent: Agent;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(agent.id)}
      className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 text-sm ${
        active ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:bg-zinc-800/60'
      }`}
    >
      <span className="text-base">{agent.avatar ?? '🤖'}</span>
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{agent.name}</div>
        <div className="text-[11px] text-zinc-500 font-mono truncate">
          {agent.id}
          {agent.model && ` · ${agent.model}`}
          {agent.lightweightMode && ' · ⚡'}
        </div>
      </div>
    </button>
  );
}
