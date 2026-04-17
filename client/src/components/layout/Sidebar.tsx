import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
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
  X
} from 'lucide-react';
import { useI18nStore, useT } from '../../lib/i18n';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useChatStore } from '../../store/chat-store';

export default function Sidebar() {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const unread = useChatStore((s) => s.unread);
  const isChatActive = location.pathname.startsWith('/chat');
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    refetchInterval: 5000
  });
  // 채팅 탭에 있으면 nav 점 숨김 (이미 채팅 중)
  const hasUnread = !isChatActive && Object.keys(unread).length > 0;
  const hasRunning = !isChatActive && (sessionsData?.sessions ?? []).some((s) => s.isRunning);
  const chatDotColor = hasUnread ? 'bg-sky-400' : hasRunning ? 'bg-amber-400' : null;

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
          <h1 className="text-lg font-semibold tracking-tight flex-1">Claw Web</h1>
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
          <span className="flex-1 text-left">검색…</span>
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
                    <span className={`w-2 h-2 rounded-full ${chatDotColor} ${hasUnread ? 'animate-pulse' : hasRunning ? 'animate-pulse' : ''}`} />
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
        <div className="text-sm font-semibold tracking-tight">Claw Web</div>
        <button
          onClick={openPalette}
          className="ml-auto p-2 rounded hover:bg-zinc-800 text-zinc-400"
          aria-label="Search"
        >
          <Search size={16} />
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
