import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { BackendUsage, BackendUsageWindow } from '../../lib/types';
import { useT } from '../../lib/i18n';

/**
 * 백엔드별 잔여 한도. 60초 폴링 — refetchIntervalInBackground=false 라 창이 비활성이면 멈춘다.
 * 서버가 아직 /api/backends/usage 를 안 올렸으면(404/500) null 로 떨어뜨려 게이지를 감춘다.
 */
export function useBackendUsage(): Record<string, BackendUsage> | null {
  const { data } = useQuery({
    queryKey: ['backends-usage'],
    queryFn: () => api.backendsUsage().catch(() => null),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false
  });
  return data?.backends ?? null;
}

/** 사용률(0~100)에 따른 바 색. 70% 주황, 90% 빨강. */
function barColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-emerald-500/80';
}

/**
 * resetsAt 까지 남은 시간. 24시간 미만은 HH:MM, 그 이상(주간 창)은 '2일 23시간'.
 * 이미 지났거나 값이 없으면 null.
 */
function untilReset(resetsAt: string | null | undefined, t: (k: string, v?: Record<string, string | number>) => string): string | null {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  if (hours >= 24) return t('backendUsage.resetDays', { d: Math.floor(hours / 24), h: hours % 24 });
  return `${String(hours).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function UsageBar({ label, win }: { label: string; win?: BackendUsageWindow }) {
  const t = useT();
  if (!win || typeof win.utilization !== 'number') return null;
  const pct = Math.max(0, Math.min(100, win.utilization));
  const reset = untilReset(win.resetsAt, t);
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
        <span>{label}</span>
        <span className="font-mono shrink-0">
          {Math.round(pct)}%
          {reset && <span className="text-zinc-600"> · {t('backendUsage.reset', { time: reset })}</span>}
        </span>
      </div>
      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor(pct)}`}
          style={{ width: `${pct}%` }}
          title={win.resetsAt ? new Date(win.resetsAt).toLocaleString() : undefined}
        />
      </div>
    </div>
  );
}

/** 백엔드 카드 안에 들어가는 잔여 한도 게이지. usage 가 없으면 아무것도 그리지 않는다. */
export function BackendUsageGauge({ usage }: { usage?: BackendUsage }) {
  const t = useT();
  if (!usage) return null;

  // unsupported = 한도 개념 없는 백엔드, error = 조회 실패 — 둘 다 조용히 숨김
  if (usage.status === 'unsupported' || usage.status === 'error') return null;

  if (usage.status === 'expired') {
    return (
      <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-red-900/50 text-red-300 border border-red-800/60">
        {t('backendUsage.expired')}
      </span>
    );
  }

  if (usage.status !== 'ok') return null;
  if (!usage.fiveHour && !usage.sevenDay) return null;

  return (
    <div className="space-y-1">
      <UsageBar label={t('backendUsage.fiveHour')} win={usage.fiveHour} />
      <UsageBar label={t('backendUsage.sevenDay')} win={usage.sevenDay} />
    </div>
  );
}
