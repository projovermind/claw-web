import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, X, TerminalSquare, FolderOpen } from 'lucide-react';
import { api } from '../lib/api';
import type { Agent } from '../lib/types';
import Terminal from '../components/terminal/Terminal';
import { nanoid } from 'nanoid';

interface Tab {
  id: string;
  title: string;
  cwd: string;
}

const STORAGE_KEY = 'terminal:tabs:v1';
const ACTIVE_KEY = 'terminal:active:v1';

function loadTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => t && typeof t.id === 'string' && typeof t.cwd === 'string');
  } catch {
    return [];
  }
}

function saveTabs(tabs: Tab[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs)); } catch { /* noop */ }
}

export default function TerminalPage() {
  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: api.agents });

  const [tabs, setTabs] = useState<Tab[]>(() => {
    const loaded = loadTabs();
    if (loaded.length > 0) return loaded;
    const home = '~';
    return [{ id: nanoid(), title: 'shell', cwd: home }];
  });
  const [activeId, setActiveId] = useState<string>(() => {
    try { return localStorage.getItem(ACTIVE_KEY) || tabs[0]?.id || ''; } catch { return tabs[0]?.id || ''; }
  });

  // Persist
  useEffect(() => { saveTabs(tabs); }, [tabs]);
  useEffect(() => {
    if (!activeId && tabs[0]) setActiveId(tabs[0].id);
    try { if (activeId) localStorage.setItem(ACTIVE_KEY, activeId); } catch { /* noop */ }
  }, [activeId, tabs]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  // Agent cwd suggestions
  const agentDirs = useMemo(() => {
    const list = (agentsQ.data ?? []) as Agent[];
    const seen = new Set<string>();
    const out: { label: string; cwd: string }[] = [];
    for (const a of list) {
      if (!a.workingDir || seen.has(a.workingDir)) continue;
      seen.add(a.workingDir);
      out.push({ label: `${a.name || a.id} — ${a.workingDir}`, cwd: a.workingDir });
    }
    return out;
  }, [agentsQ.data]);

  const addTab = (cwd = '~') => {
    const id = nanoid();
    const parts = cwd.split('/').filter(Boolean);
    const title = parts[parts.length - 1] || 'shell';
    setTabs((ts) => [...ts, { id, title, cwd }]);
    setActiveId(id);
  };

  const closeTab = (id: string) => {
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === activeId) {
        const fallback = next[idx - 1] || next[0];
        setActiveId(fallback?.id ?? '');
      }
      return next.length > 0 ? next : [{ id: nanoid(), title: 'shell', cwd: '~' }];
    });
  };

  const renameCwd = (id: string, newCwd: string) => {
    setTabs((ts) => ts.map((t) => {
      if (t.id !== id) return t;
      const parts = newCwd.split('/').filter(Boolean);
      return { ...t, cwd: newCwd, title: parts[parts.length - 1] || 'shell' };
    }));
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/40">
        <TerminalSquare size={16} className="text-zinc-400" />
        <div className="text-sm font-semibold text-zinc-200">터미널</div>
        <div className="flex items-center gap-1 flex-1 overflow-x-auto ml-3">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
              className={`group flex items-center gap-2 pl-3 pr-1.5 py-1 rounded text-xs cursor-pointer shrink-0 border ${
                tab.id === activeId
                  ? 'bg-zinc-800 border-zinc-700 text-zinc-100'
                  : 'bg-zinc-900/40 border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
              title={tab.cwd}
            >
              <span className="font-mono">{tab.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                className="p-0.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 opacity-0 group-hover:opacity-100"
                title="탭 닫기"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            onClick={() => addTab(activeTab?.cwd ?? '~')}
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
            title="새 터미널 탭"
          >
            <Plus size={14} />
          </button>
        </div>
        {/* Agent cwd dropdown */}
        {agentDirs.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const val = e.target.value;
              if (val) addTab(val);
              e.target.value = '';
            }}
            className="h-7 px-2 rounded bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 hover:text-zinc-200"
          >
            <option value="">에이전트 작업폴더로 열기…</option>
            {agentDirs.map((a) => (
              <option key={a.cwd} value={a.cwd}>{a.label}</option>
            ))}
          </select>
        )}
      </div>

      {/* CWD bar */}
      {activeTab && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-zinc-800 bg-zinc-900/20 text-xs">
          <FolderOpen size={12} className="text-zinc-500 shrink-0" />
          <span className="text-zinc-500 shrink-0">cwd:</span>
          <input
            value={activeTab.cwd}
            onChange={(e) => renameCwd(activeTab.id, e.target.value)}
            placeholder="~/some/path"
            className="flex-1 bg-transparent font-mono text-[12px] text-zinc-300 outline-none border-b border-transparent focus:border-zinc-700"
          />
          <span className="text-[10px] text-zinc-600">경로 변경 후 Enter 는 새 세션으로 재연결합니다 (탭 다시 열기)</span>
        </div>
      )}

      {/* Terminal area — render all tabs but only show active (preserves sessions) */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === activeId ? 'block' : 'none' }}
          >
            <Terminal cwd={tab.cwd} instanceKey={tab.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
