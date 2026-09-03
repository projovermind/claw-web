import { useQuery } from '@tanstack/react-query';
import { MonitorSmartphone } from 'lucide-react';
import { api } from '../../lib/api';
import type { Device } from '../../lib/types';

function isSelf(device: Device) {
  try { return new URL(device.url).origin === window.location.origin; } catch { return false; }
}

/**
 * 등록된 기기로 건너뛰는 목록. claw-web 은 단일 기계 전제라 원격 조종이 아니라
 * 그 기계의 claw-web 을 여는 것 — 그래서 NavLink 가 아니라 통짜 이동(<a>)이다.
 * 기기가 없으면 아무것도 그리지 않아 1대 쓰는 사람에겐 변화가 없다.
 */
export default function DeviceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { data: devices } = useQuery({ queryKey: ['devices'], queryFn: api.devices, staleTime: 60_000 });
  if (!devices || devices.length === 0) return null;

  return (
    <div className="mt-4 pt-4 border-t border-zinc-800/60 space-y-1">
      {!collapsed && (
        <div className="flex items-center gap-1 text-[11px] text-zinc-500 mb-1 px-3">
          <MonitorSmartphone size={11} />
          <span>기기</span>
        </div>
      )}
      {devices.map((d) => <DeviceLink key={d.id} device={d} collapsed={collapsed} />)}
    </div>
  );
}

function DeviceLink({ device, collapsed }: { device: Device; collapsed: boolean }) {
  const self = isSelf(device);
  const { data: ping } = useQuery({
    queryKey: ['device-ping', device.id],
    queryFn: () => api.pingDevice(device.id),
    refetchInterval: 30_000,
    enabled: !self
  });

  const dot = self ? 'bg-sky-400' : ping == null ? 'bg-zinc-600' : ping.online ? 'bg-emerald-400' : 'bg-red-400';
  const title = collapsed
    ? `${device.name}${self ? ' (이 기기)' : ping && !ping.online ? ' — 응답 없음' : ''}`
    : undefined;

  const body = (
    <>
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      {!collapsed && <span className="flex-1 min-w-0 truncate whitespace-nowrap">{device.name}</span>}
    </>
  );

  const cls = `relative flex items-center gap-3 ${collapsed ? 'justify-center px-0' : 'px-3'} h-9 rounded-md text-sm transition-colors`;

  if (self) {
    return <div className={`${cls} bg-zinc-800 text-white`} title={title}>{body}</div>;
  }
  return (
    <a href={device.url} className={`${cls} text-zinc-400 hover:text-white hover:bg-zinc-900`} title={title}>
      {body}
    </a>
  );
}
