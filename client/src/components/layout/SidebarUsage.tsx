import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { BackendUsageWindow } from '../../lib/types';
import { useT } from '../../lib/i18n';
import { useBackendUsage, untilReset } from '../settings/BackendUsageGauge';

const SIZE = 18;
const STROKE = 2.5;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

/** 지름 18px 도넛 링 — 회색 트랙 위에 보라→파랑 그라디언트 arc. */
function Donut({ pct, gradId }: { pct: number; gradId: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0 -rotate-90">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#c26ef2" />
          <stop offset="100%" stopColor="#6fb0f7" />
        </linearGradient>
      </defs>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="#3f3f46" strokeWidth={STROKE} />
      {clamped > 0 && (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - clamped / 100)}
        />
      )}
    </svg>
  );
}

/** '5시간 42% · 03:12 리셋 (9/17 오후 8:00)' 한 줄. 값이 없으면 null. */
function windowLine(
  label: string,
  win: BackendUsageWindow | null | undefined,
  t: (k: string, v?: Record<string, string | number>) => string
): string | null {
  if (!win || typeof win.utilization !== 'number') return null;
  const parts = [`${label} ${Math.round(win.utilization)}%`];
  const left = untilReset(win.resetsAt, t);
  if (left) parts.push(t('backendUsage.reset', { time: left }));
  const line = parts.join(' · ');
  return win.resetsAt ? `${line} (${new Date(win.resetsAt).toLocaleString()})` : line;
}

/**
 * 사이드바 하단의 백엔드별 잔여 한도. status==='ok' 인 백엔드만, fiveHour 기준으로 그린다.
 * 접힌 상태에서는 도넛만 세로로 쌓는다.
 */
export default function SidebarUsage({ collapsed }: { collapsed: boolean }) {
  const t = useT();
  const usage = useBackendUsage();
  const backendsQ = useQuery({ queryKey: ['backends'], queryFn: api.backends, staleTime: 60_000 });

  if (!usage) return null;

  const rows = Object.entries(usage)
    .filter(([, u]) => u?.status === 'ok' && typeof u.fiveHour?.utilization === 'number')
    .map(([id, u]) => {
      const pct = Math.round(Math.max(0, Math.min(100, u.fiveHour!.utilization)));
      const tip = [
        windowLine(t('backendUsage.fiveHour'), u.fiveHour, t),
        windowLine(t('backendUsage.sevenDay'), u.sevenDay, t)
      ]
        .filter(Boolean)
        .join('\n');
      return { id, label: backendsQ.data?.backends?.[id]?.label ?? id, pct, tip };
    });

  if (rows.length === 0) return null;

  return (
    <div className={collapsed ? 'flex flex-col items-center gap-1.5 mb-2' : 'space-y-1 mb-2'}>
      {rows.map((r) => (
        <div
          key={r.id}
          title={`${r.label}\n${r.tip}`}
          className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2 px-2'} cursor-default`}
        >
          <Donut pct={r.pct} gradId={`sidebar-usage-${r.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`} />
          {!collapsed && (
            <>
              <span className="flex-1 min-w-0 truncate whitespace-nowrap text-[0.6875rem] text-zinc-500">{r.label}</span>
              <span className="shrink-0 font-mono text-[0.6875rem] text-zinc-400">{r.pct}%</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
