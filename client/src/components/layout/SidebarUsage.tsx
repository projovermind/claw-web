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

function Pair({ slot }: { slot: Slot }) {
  return (
    <div className="flex items-center gap-1 cursor-default" title={slot.tip}>
      <Donut pct={slot.pct} />
      <span className="font-mono text-[0.6875rem] text-zinc-400">{slot.pct}%</span>
    </div>
  );
}

/**
 * 사이드바 하단 구분선 위의 백엔드별 잔여 한도.
 * status==='ok' 인 백엔드마다 한 줄, 한 줄에 [5시간 도넛+%] [주간 도넛+%].
 * 접힌 상태에서는 도넛만 가로로 붙여 그린다.
 */
export default function SidebarUsage({ collapsed }: { collapsed: boolean }) {
  const t = useT();
  const usage = useBackendUsage();

  if (!usage) return null;

  const rows = Object.entries(usage)
    .filter((e): e is [string, BackendUsage] => e[1]?.status === 'ok')
    .map(([id, u]) => ({
      id,
      slots: [toSlot('backendUsage.fiveHourLimit', u.fiveHour, t), toSlot('backendUsage.sevenDayLimit', u.sevenDay, t)]
        .filter((s): s is Slot => s !== null)
    }))
    .filter((r) => r.slots.length > 0);

  if (rows.length === 0) return null;

  return (
    <div className={collapsed ? 'px-1 pb-2 space-y-1.5' : 'px-2 pb-2 space-y-1'}>
      {rows.map((r) => (
        <div key={r.id} className={`flex items-center ${collapsed ? 'justify-center gap-1' : 'gap-3'}`}>
          {r.slots.map((s, i) =>
            collapsed ? (
              <div key={i} title={s.tip} className="cursor-default">
                <Donut pct={s.pct} />
              </div>
            ) : (
              <Pair key={i} slot={s} />
            )
          )}
        </div>
      ))}
    </div>
  );
}
