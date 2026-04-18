import { useState, useRef, useEffect } from 'react';
import { Server, KeyRound, ToggleRight, Webhook, Plug, Clock, Palette, Bell, ChevronRight } from 'lucide-react';
import { BackendsTab } from '../components/settings/BackendsTab';
import { AccessTab } from '../components/settings/AccessTab';
import { FeaturesTab } from '../components/settings/FeaturesTab';
import { HooksTab } from '../components/settings/HooksTab';
import { McpServersTab } from '../components/settings/McpServersTab';
import { SchedulesTab } from '../components/settings/SchedulesTab';
import { AppearanceTab } from '../components/settings/AppearanceTab';
import { NotificationsTab } from '../components/settings/NotificationsTab';
import { useT } from '../lib/i18n';

type Tab = 'appearance' | 'backends' | 'access' | 'features' | 'hooks' | 'mcp' | 'schedules' | 'notifications';

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('appearance');
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    check();
    el.addEventListener('scroll', check);
    window.addEventListener('resize', check);
    return () => { el.removeEventListener('scroll', check); window.removeEventListener('resize', check); };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      <h2 className="text-2xl font-semibold">{t('nav.settings')}</h2>

      <div className="relative">
      <div ref={scrollRef} className="flex gap-1 border-b border-zinc-800 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        <TabButton label={t('settings.tab.appearance')} icon={<Palette size={14} />} active={tab === 'appearance'} onClick={() => setTab('appearance')} />
        <TabButton label={t('settings.tab.backends')} icon={<Server size={14} />} active={tab === 'backends'} onClick={() => setTab('backends')} />
        <TabButton label={t('settings.tab.access')} icon={<KeyRound size={14} />} active={tab === 'access'} onClick={() => setTab('access')} />
        <TabButton label={t('settings.tab.features')} icon={<ToggleRight size={14} />} active={tab === 'features'} onClick={() => setTab('features')} />
        <TabButton label={t('settings.tab.hooks')} icon={<Webhook size={14} />} active={tab === 'hooks'} onClick={() => setTab('hooks')} />
        <TabButton label={t('settings.tab.mcp')} icon={<Plug size={14} />} active={tab === 'mcp'} onClick={() => setTab('mcp')} />
        <TabButton label={t('settings.tab.schedules')} icon={<Clock size={14} />} active={tab === 'schedules'} onClick={() => setTab('schedules')} />
        <TabButton label="알림" icon={<Bell size={14} />} active={tab === 'notifications'} onClick={() => setTab('notifications')} />
      </div>
      {/* 오른쪽 더 있음 표시 — 모바일에서만 */}
      {canScrollRight && (
        <div className="lg:hidden absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-zinc-950 to-transparent pointer-events-none flex items-center justify-end pr-1">
          <ChevronRight size={14} className="text-zinc-500" />
        </div>
      )}
      </div>

      <div className="pt-2">
        {tab === 'appearance' && <AppearanceTab />}
        {tab === 'backends' && <BackendsTab />}
        {tab === 'access' && <AccessTab />}
        {tab === 'features' && <FeaturesTab />}
        {tab === 'hooks' && <HooksTab />}
        {tab === 'mcp' && <McpServersTab />}
        {tab === 'schedules' && <SchedulesTab />}
        {tab === 'notifications' && <NotificationsTab />}
      </div>
    </div>
  );
}

function TabButton({ label, icon, active, onClick }: { label: string; icon: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm flex items-center gap-2 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
        active
          ? 'border-emerald-500 text-white'
          : 'border-transparent text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
