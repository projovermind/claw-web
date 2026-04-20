import { useEffect, useState } from 'react';
import { NavLink, useLocation, Link } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  FolderKanban,
  MessageSquare,
  Settings,
  Languages,
  Sparkles,
  Search,
  Menu,
  X,
  RotateCcw
} from 'lucide-react';
import { useI18nStore, useT } from '../../lib/i18n';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useChatStore } from '../../store/chat-store';
import { isSessionRunning } from '../../lib/visibility';
import { DEFAULT_APPEARANCE } from '../../hooks/useAppearance';

export default function Sidebar() {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const unread = useChatStore((s) => s.unread);
  const runtime = useChatStore((s) => s.runtime);
  // appName — settings 에서 커스텀 가능 (App 최상위 useAppearance 가 react-query 캐시에 적재)
  const settingsQ = useQuery({ queryKey: ['settings-appearance'], queryFn: api.getSettings, staleTime: 30_000 });
  const appName = (settingsQ.data as { appearance?: { appName?: string } } | undefined)?.appearance?.appName ?? DEFAULT_APPEARANCE.appName;
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    refetchInterval: 5000
  });
  // 유효한 unread 만 카운트: (존재하는 세션) ∧ (현재 열린 세션 아님)
  // 이 필터 없으면 삭제된 세션 / 열고 있는 세션의 유령 unread 로 파란점 상시 점등
  const validUnreadCount = (() => {
    const sessions = sessionsData?.sessions ?? [];
    if (sessions.length === 0) return 0;
    const valid = new Set(sessions.map((s) => s.id));
    let n = 0;
    for (const id of Object.keys(unread)) {
      if (id !== currentSessionId && valid.has(id)) n++;
    }
    return n;
  })();
  const hasUnread = validUnreadCount > 0;
  const hasError = (() => {
    const sessions = sessionsData?.sessions ?? [];
    if (sessions.length === 0) return false;
    const valid = new Set(sessions.map((s) => s.id));
    return Object.entries(unread).some(([id, u]) => u?.isError && valid.has(id) && id !== currentSessionId);
  })();
  const hasRunning = (sessionsData?.sessions ?? []).some((s) => isSessionRunning(s, runtime));
  const chatDotColor = hasError ? 'bg-red-400' : hasUnread ? 'bg-sky-400' : hasRunning ? 'bg-amber-400' : null;

  // Close drawer on route change (mobile)
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Three groups separated by dividers:
  //   1. 작업 공간  (대시보드, 채팅)
  //   2. 자산       (프로젝트, 에이전트, 스킬)
  //   3. 관리       (설정)
  const GROUPS: { items: { to: string; icon: typeof LayoutDashboard; label: string }[] }[] = [
    {
      items: [
        { to: '/', icon: LayoutDashboard, label: t('nav.dashboard') },
        { to: '/chat', icon: MessageSquare, label: t('nav.chat') }
      ]
    },
    {
      items: [
        { to: '/projects', icon: FolderKanban, label: t('nav.projects') },
        { to: '/agents', icon: Users, label: t('nav.agents') },
        { to: '/skills', icon: Sparkles, label: t('nav.skills') }
      ]
    },
    {
      items: [{ to: '/settings', icon: Settings, label: t('nav.settings') }]
    }
  ];

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  // Programmatically dispatch the palette hotkey (CommandPalette listens for ⌘/Ctrl-K)
  const openPalette = () => {
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true
    });
    window.dispatchEvent(event);
  };

  const sidebarContent = (
    <>
      <div className="px-5 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <Link
            to="/"
            onClick={() => setMobileOpen(false)}
            className="text-lg font-semibold tracking-tight flex-1 hover:text-sky-400 transition-colors"
          >{appName}</Link>
          {/* Mobile close button — only visible when the drawer is open */}
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1 rounded hover:bg-zinc-800 text-zinc-400"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>
        <button
          onClick={openPalette}
          className="mt-3 w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <Search size={12} />
          <span className="flex-1 text-left">{t('sidebar.searchPlaceholder')}</span>
          <kbd className="text-[11px] font-mono text-zinc-600">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      </div>
      <nav className="flex-1 p-2 overflow-y-auto">
        {GROUPS.map((group, gi) => (
          <div
            key={gi}
            className={`space-y-1 ${gi > 0 ? 'mt-4 pt-4 border-t border-zinc-800/60' : ''}`}
          >
            {group.items.map(({ to, icon: Icon, label }) => {
              const showChatDot = to === '/chat' && chatDotColor;
              return (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                      isActive
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
                    }`
                  }
                >
                  <Icon size={16} />
                  <span className="flex-1">{label}</span>
                  {showChatDot && (
                    <span className={`w-2 h-2 rounded-full ${chatDotColor} ${hasError || hasUnread || hasRunning ? 'animate-pulse' : ''}`} />
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      {/* Language toggle */}
      <div className="p-2 border-t border-zinc-800">
        <div className="flex items-center gap-1 text-[11px] text-zinc-500 mb-1 px-2">
          <Languages size={11} />
          <span>Language</span>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setLang('ko')}
            className={`flex-1 rounded px-2 py-1.5 text-xs transition-colors ${
              lang === 'ko' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:bg-zinc-900'
            }`}
          >
            한국어
          </button>
          <button
            onClick={() => setLang('en')}
            className={`flex-1 rounded px-2 py-1.5 text-xs transition-colors ${
              lang === 'en' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:bg-zinc-900'
            }`}
          >
            English
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar (visible on <lg) — hamburger + current page hint */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-30 h-12 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 flex items-center px-3 gap-2">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 rounded hover:bg-zinc-800 text-zinc-300"
          aria-label="Open menu"
        >
          <Menu size={18} />
        </button>
        <Link to="/" className="text-sm font-semibold tracking-tight hover:text-sky-400 transition-colors">{appName}</Link>
        <button
          onClick={openPalette}
          className="ml-auto p-2 rounded hover:bg-zinc-800 text-zinc-400"
          aria-label={t('sidebar.searchAria')}
        >
          <Search size={16} />
        </button>
        <button
          onClick={() => {
            if (!confirm('서버를 재시작할까요?')) return;
            fetch('/api/admin/restart', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(localStorage.getItem('hivemind:auth-token') ? { Authorization: `Bearer ${localStorage.getItem('hivemind:auth-token')}` } : {}) },
              body: JSON.stringify({ force: false })
            }).catch(() => {});
          }}
          className="p-2 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
          title="서버 재시작"
        >
          <RotateCcw size={15} />
        </button>
      </div>

      {/* Desktop sidebar — static, always visible on lg+ */}
      <aside className="w-60 shrink-0 border-r border-zinc-800 bg-zinc-950/80 hidden lg:flex lg:flex-col">
        {sidebarContent}
      </aside>

      {/* Mobile drawer — overlay + slide-in panel when mobileOpen */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative w-64 h-full bg-zinc-950 border-r border-zinc-800 flex flex-col shadow-2xl">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}
