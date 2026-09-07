import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MonitorSmartphone } from 'lucide-react';
import { api } from '../../lib/api';
import type { Device } from '../../lib/types';

function isSelf(device: Device) {
  try { return new URL(device.url).origin === window.location.origin; } catch { return false; }
}

/**
 * 보고 있던 화면을 그대로 유지한 채 건너뛴다 — /chat 에서 눌렀으면 상대 기기의 /chat.
 * 세션 id 같은 쿼리는 기기마다 의미가 달라 경로만 옮기고 search/hash 는 버린다.
 */
function targetUrl(device: Device) {
  try {
    return new URL(window.location.pathname, device.url).toString();
  } catch {
    return device.url;
  }
}

/**
 * 등록된 기기로 건너뛰는 목록. claw-web 은 단일 기계 전제라 원격 조종이 아니라
 * 그 기계의 claw-web 을 여는 것 — 그래서 NavLink 가 아니라 통짜 이동(<a>)이다.
 * 기기가 없으면 아무것도 그리지 않아 1대 쓰는 사람에겐 변화가 없다.
 */
export default function DeviceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { data: devices } = useQuery({ queryKey: ['devices'], queryFn: api.devices, staleTime: 60_000 });

  // Alt+1~9 로 순번 전환. e.key 는 Option 조합에서 다른 문자가 되므로 e.code 로 본다.
  useEffect(() => {
    if (!devices?.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const m = /^Digit([1-9])$/.exec(e.code);
      if (!m) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const device = devices[Number(m[1]) - 1];
      if (!device || isSelf(device)) return;
      e.preventDefault();
      window.location.href = targetUrl(device);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [devices]);

  if (!devices || devices.length === 0) return null;

  return (
    <div className="mt-4 pt-4 border-t border-zinc-800/60 space-y-1">
      {!collapsed && (
        <div className="flex items-center gap-1 text-[0.6875rem] text-zinc-500 mb-1 px-3">
          <MonitorSmartphone size={11} />
          <span>기기</span>
        </div>
      )}
      {devices.map((d, i) => <DeviceLink key={d.id} device={d} num={i + 1} collapsed={collapsed} />)}
    </div>
  );
}

function DeviceLink({ device, num, collapsed }: { device: Device; num: number; collapsed: boolean }) {
  const self = isSelf(device);
  const { data: ping } = useQuery({
    queryKey: ['device-ping', device.id],
    queryFn: () => api.pingDevice(device.id),
    refetchInterval: 30_000,
    enabled: !self
  });

  const dot = self ? 'bg-sky-400' : ping == null ? 'bg-zinc-600' : ping.online ? 'bg-emerald-400' : 'bg-red-400';
  const hint = num <= 9 ? ` (Alt+${num})` : '';
  const title = collapsed
    ? `${device.name}${self ? ' (이 기기)' : ping && !ping.online ? ' — 응답 없음' : ''}${self ? '' : hint}`
    : self ? undefined : `${device.name}${hint}`;

  const body = (
    <>
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      {!collapsed && (
        <>
          <span className="flex-1 min-w-0 truncate whitespace-nowrap">{device.name}</span>
          {num <= 9 && (
            <span className="text-[0.625rem] font-mono text-zinc-600 shrink-0">{num}</span>
          )}
        </>
      )}
    </>
  );

  const cls = `relative flex items-center gap-3 ${collapsed ? 'justify-center px-0' : 'px-3'} h-9 rounded-md text-sm transition-colors`;

  if (self) {
    return <div className={`${cls} bg-zinc-800 text-white`} title={title}>{body}</div>;
  }
  return (
    <a href={targetUrl(device)} className={`${cls} text-zinc-400 hover:text-white hover:bg-zinc-900`} title={title}>
      {body}
    </a>
  );
}
