import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { BackendUsage, BackendUsageWindow } from '../../lib/types';
import { useT } from '../../lib/i18n';
import { useBackendUsage } from '../settings/BackendUsageGauge';

const SIZE = 18;
const STROKE = 2.5;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

/** BackendUsageGauge 의 barColor 와 같은 임계값 — 70% 주황, 90% 빨강. */
function arcColor(pct: number): string {
  if (pct >= 90) return '#ef4444';
  if (pct >= 70) return '#f59e0b';
  return '#10b981';
}

/** 지름 18px 도넛 링 — 회색 트랙 위에 사용률만큼 단색 arc. */
function Donut({ pct }: { pct: number }) {
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0 -rotate-90">
      <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="#3f3f46" strokeWidth={STROKE} />
      {pct > 0 && (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke={arcColor(pct)}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct / 100)}
        />
      )}
    </svg>
  );
}

/**
 * 리셋 시각. 24시간 이내면 시각만('오후 8:00'), 넘으면 날짜까지('9/20 오전 3:00').
 * 값이 없거나 이미 지났으면 null.
 */
function resetAtLabel(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null;
  const d = new Date(resetsAt);
  const ms = d.getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const time = { hour: 'numeric', minute: '2-digit' } as const;
  return ms < 86_400_000
    ? d.toLocaleTimeString(undefined, time)
    : d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', ...time });
}

type Slot = { pct: number; tip: string };
type Tip = { text: string; x: number; y: number };

/** 창 하나 → 도넛 1개분. utilization 이 없으면 null(=그 쌍 생략). */
function toSlot(
  labelKey: string,
  win: BackendUsageWindow | null | undefined,
  t: (k: string, v?: Record<string, string | number>) => string
): Slot | null {
  if (!win || typeof win.utilization !== 'number') return null;
  const pct = Math.round(Math.max(0, Math.min(100, win.utilization)));
  const at = resetAtLabel(win.resetsAt);
  const tip = `${t(labelKey)} ${pct}%${at ? ` · ${t('backendUsage.resetAt', { time: at })}` : ''}`;
  return { pct, tip };
}

/**
 * 사이드바 하단 구분선 위의 백엔드별 잔여 한도.
 * status==='ok' 인 백엔드마다 한 줄 — 왼쪽 이름, 오른쪽에 [5시간 도넛+%] [주간 도넛+%].
 * 접힌 상태에서는 도넛만 가로로 붙여 그린다.
 *
 * 툴팁은 native title 대신 직접 그린다. 사이드바 래퍼가 overflow-hidden 이라
 * absolute 패널은 잘리므로, body 로 portal 해서 fixed 좌표로 띄운다.
 */
export default function SidebarUsage({ collapsed }: { collapsed: boolean }) {
  const t = useT();
  const usage = useBackendUsage();
  const backendsQ = useQuery({ queryKey: ['backends'], queryFn: api.backends, staleTime: 60_000 });
  const [tip, setTip] = useState<Tip | null>(null);

  if (!usage) return null;

  const rows = Object.entries(usage)
    .filter((e): e is [string, BackendUsage] => e[1]?.status === 'ok')
    .map(([id, u]) => ({
      id,
      label: backendsQ.data?.backends?.[id]?.label ?? id,
      slots: [toSlot('backendUsage.fiveHourLimit', u.fiveHour, t), toSlot('backendUsage.sevenDayLimit', u.sevenDay, t)]
        .filter((s): s is Slot => s !== null)
    }))
    .filter((r) => r.slots.length > 0);

  if (rows.length === 0) return null;

  // 행 오른쪽 8px 지점, 세로 중앙에 패널을 건다.
  const showTip = (e: React.MouseEvent<HTMLElement>, text: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ text, x: r.right + 8, y: r.top + r.height / 2 });
  };

  return (
    <div className={collapsed ? 'px-1 pb-2 space-y-1.5' : 'px-2 pb-2 space-y-1'}>
      {rows.map((r) => (
        <div key={r.id} className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2'}`}>
          {!collapsed && (
            <span className="min-w-0 truncate whitespace-nowrap text-[0.6875rem] text-zinc-500">{r.label}</span>
          )}
          <div className={`flex items-center ${collapsed ? 'gap-1' : 'ml-auto gap-3'}`}>
            {r.slots.map((s, i) => (
              <div
                key={i}
                className="flex items-center gap-1 cursor-default"
                onMouseEnter={(e) => showTip(e, `${r.label} — ${s.tip}`)}
                onMouseLeave={() => setTip(null)}
              >
                <Donut pct={s.pct} />
                {!collapsed && <span className="font-mono text-[0.6875rem] text-zinc-400">{s.pct}%</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
      {tip &&
        createPortal(
          <div
            className="fixed z-50 -translate-y-1/2 pointer-events-none rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 whitespace-nowrap shadow-lg"
            style={{ left: tip.x, top: tip.y }}
          >
            {tip.text}
          </div>,
          document.body
        )}
    </div>
  );
}
