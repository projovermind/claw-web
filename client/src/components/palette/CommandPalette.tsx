import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Users,
  Folder,
  Sparkles,
  MessageSquare,
  Settings,
  LayoutDashboard,
  Search,
  ArrowRight
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

type PaletteItem = {
  id: string;
  kind: 'nav' | 'agent' | 'project' | 'skill' | 'session';
  label: string;
  sublabel?: string;
  icon: LucideIcon;
  iconColor?: string;
  action: () => void;
  searchBlob: string; // lowercase haystack
};

/**
 * Command palette. Cmd/Ctrl-K anywhere to open.
 *
 * Sources:
 *  - Static nav items (Dashboard, Agents, Projects, ...)
 *  - All agents → navigate to /chat?agent=<id> (or /agents)
 *  - All projects → navigate to /projects (highlight on id; UI will pick it up if/when we add deep-linking)
 *  - All skills → navigate to /skills
 *  - All sessions → navigate to /chat?session=<id>
 *
 * Fuzzy match is a simple case-insensitive substring over `label + sublabel`.
 * Arrow keys cycle selection, Enter fires the action.
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const t = useT();

  // Global hotkey
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      // Next tick so the element is mounted
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Lazy queries — only fire when the palette opens, so initial page load stays light.
  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: api.agents,
    enabled: open
  });
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects,
    enabled: open
  });
  const { data: skills } = useQuery({
    queryKey: ['skills'],
    queryFn: api.skills,
    enabled: open
  });
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: api.allSessions,
    enabled: open
  });

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];

    // Static navigation
    const nav: { label: string; path: string; icon: LucideIcon; color: string }[] = [
      { label: 'Dashboard', path: '/', icon: LayoutDashboard, color: 'text-sky-400' },
      { label: 'Agents', path: '/agents', icon: Users, color: 'text-emerald-400' },
      { label: 'Projects', path: '/projects', icon: Folder, color: 'text-amber-400' },
      { label: 'Skills', path: '/skills', icon: Sparkles, color: 'text-purple-400' },
      { label: 'Chat', path: '/chat', icon: MessageSquare, color: 'text-pink-400' },
      { label: 'Settings', path: '/settings', icon: Settings, color: 'text-zinc-400' }
    ];
    for (const n of nav) {
      out.push({
        id: `nav:${n.path}`,
        kind: 'nav',
        label: n.label,
        sublabel: n.path,
        icon: n.icon,
        iconColor: n.color,
        action: () => navigate(n.path),
        searchBlob: `${n.label} ${n.path}`.toLowerCase()
      });
    }

    // Agents
    for (const a of agents ?? []) {
      out.push({
        id: `agent:${a.id}`,
        kind: 'agent',
        label: a.name || a.id,
        sublabel: `${t('palette.kind.agent')} · ${a.model ?? 'sonnet'} · ${a.id}`,
        icon: Users,
        iconColor: 'text-emerald-400',
        action: () => navigate(`/chat?agent=${encodeURIComponent(a.id)}`),
        searchBlob: `${a.name} ${a.id} ${a.model ?? ''}`.toLowerCase()
      });
    }

    // Projects
    for (const p of projects ?? []) {
      out.push({
        id: `project:${p.id}`,
        kind: 'project',
        label: p.name,
        sublabel: `${t('palette.kind.project')} · ${p.path}`,
        icon: Folder,
        iconColor: 'text-amber-400',
        action: () => navigate('/projects'),
        searchBlob: `${p.name} ${p.id} ${p.path}`.toLowerCase()
      });
    }

    // Skills
    for (const s of skills ?? []) {
      out.push({
        id: `skill:${s.id}`,
        kind: 'skill',
        label: s.name,
        sublabel: `${t('palette.kind.skill')}${s.system ? ' · system' : ''}${s.description ? ' · ' + s.description : ''}`,
        icon: Sparkles,
        iconColor: 'text-purple-400',
        action: () => navigate('/skills'),
        searchBlob: `${s.name} ${s.description ?? ''} ${s.id}`.toLowerCase()
      });
    }

    // Sessions (title + agentId) — carry both params so ChatPage can jump to
    // the right agent + session in one shot
    const sessions = sessionsData?.sessions ?? [];
    for (const sess of sessions) {
      out.push({
        id: `session:${sess.id}`,
        kind: 'session',
        label: sess.title || sess.id,
        sublabel: `${t('palette.kind.session')} · @${sess.agentId} · ${sess.updatedAt?.slice(0, 10) ?? ''}`,
        icon: MessageSquare,
        iconColor: 'text-pink-400',
        action: () =>
          navigate(
            `/chat?agent=${encodeURIComponent(sess.agentId)}&session=${encodeURIComponent(sess.id)}`
          ),
        searchBlob: `${sess.title ?? ''} ${sess.agentId}`.toLowerCase()
      });
    }

    return out;
  }, [agents, projects, skills, sessionsData, navigate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 40);
    const tokens = q.split(/\s+/).filter(Boolean);
    return items
      .filter((it) => tokens.every((tok) => it.searchBlob.includes(tok)))
      .slice(0, 40);
  }, [items, query]);

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[cursor];
      if (it) {
        it.action();
        setOpen(false);
      }
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center z-[90] p-4 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-xl shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
          <Search size={16} className="text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t('palette.placeholder')}
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-zinc-600"
          />
          <kbd className="text-[11px] text-zinc-500 px-1.5 py-0.5 rounded border border-zinc-700 font-mono">
            ESC
          </kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-zinc-600 italic">{t('palette.empty')}</div>
          ) : (
            filtered.map((it, i) => {
              const Icon = it.icon;
              const active = i === cursor;
              return (
                <button
                  key={it.id}
                  onClick={() => {
                    it.action();
                    setOpen(false);
                  }}
                  onMouseEnter={() => setCursor(i)}
                  className={`w-full text-left flex items-center gap-3 px-4 py-2.5 ${
                    active ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40'
                  }`}
                >
                  <Icon size={14} className={`${it.iconColor ?? 'text-zinc-400'} shrink-0`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-200 truncate">{it.label}</div>
                    {it.sublabel && (
                      <div className="text-[11px] text-zinc-500 truncate">{it.sublabel}</div>
                    )}
                  </div>
                  {active && <ArrowRight size={12} className="text-zinc-600 shrink-0" />}
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center gap-3 px-4 py-2 border-t border-zinc-800 text-[11px] text-zinc-600">
          <span><kbd className="font-mono">↑↓</kbd> {t('palette.hint.move')}</span>
          <span><kbd className="font-mono">Enter</kbd> {t('palette.hint.select')}</span>
          <span className="ml-auto">
            <kbd className="font-mono">⌘K</kbd> {t('palette.hint.toggle')}
          </span>
        </div>
      </div>
    </div>
  );
}
