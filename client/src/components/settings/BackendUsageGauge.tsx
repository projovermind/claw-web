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

/**
 * backendId → 같은 accountUuid 를 쓰는 백엔드 수(자기 자신 포함).
 * 2 이상이면 그 백엔드들은 같은 Anthropic 계정의 한도를 나눠 쓴다.
 */
export function sharedAccountCounts(map: Record<string, BackendUsage> | null | undefined): Record<string, number> {
  const byUuid: Record<string, number> = {};
  for (const u of Object.values(map ?? {})) {
    if (u?.accountUuid) byUuid[u.accountUuid] = (byUuid[u.accountUuid] ?? 0) + 1;
  }
  const out: Record<string, number> = {};
  for (const [id, u] of Object.entries(map ?? {})) {
    if (u?.accountUuid) out[id] = byUuid[u.accountUuid];
  }
  return out;
}

/** 창 하나라도 숫자 utilization 이 있으면 true — 그릴 수치가 남아 있다는 뜻. */
export function hasUsageWindows(u?: BackendUsage | null): boolean {
  return typeof u?.fiveHour?.utilization === 'number' || typeof u?.sevenDay?.utilization === 'number';
}

/**
 * 조회는 실패했지만 직전 수치가 남아 있는 상태(서버가 stale:true 로 내려준다).
 * 일시적 429 로 게이지가 통째로 사라지는 걸 막기 위해, 숨기지 않고 흐리게 표시한다.
 */
export function isStaleUsage(u?: BackendUsage | null): boolean {
  return u?.stale === true && hasUsageWindows(u);
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
 * 사이드바(SidebarUsage)도 같은 표기를 쓰므로 export.
 */
export function untilReset(resetsAt: string | null | undefined, t: (k: string, v?: Record<string, string | number>) => string): string | null {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  if (hours >= 24) return t('backendUsage.resetDays', { d: Math.floor(hours / 24), h: hours % 24 });
  return `${String(hours).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function UsageBar({ label, win }: { label: string; win?: BackendUsageWindow | null }) {
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

/** 상태 뱃지 — 한 줄짜리 회색/빨강 칩. */
function StatusBadge({ tone, label, tip }: { tone: 'red' | 'zinc'; label: string; tip?: string }) {
  const cls = tone === 'red'
    ? 'bg-red-900/50 text-red-300 border-red-800/60'
    : 'bg-zinc-800 text-zinc-400 border-zinc-700';
  return (
    <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${cls}`} title={tip}>
      {label}
    </span>
  );
}

/** '계정 공유' 표시 — 같은 Anthropic 계정을 쓰는 백엔드가 여럿일 때. */
function SharedChip({ count }: { count?: number }) {
  const t = useT();
  const tip = count && count >= 2 ? t('backendUsage.sharedTipCount', { n: count }) : t('backendUsage.sharedTip');
  return (
    <span className="shrink-0 text-[10px] text-amber-400/70 cursor-default" title={tip}>
      {t('backendUsage.shared')}
      {count && count >= 2 ? ` (${count})` : ''}
    </span>
  );
}

/**
 * 백엔드 카드 안에 들어가는 잔여 한도 게이지. usage 가 없으면 아무것도 그리지 않는다.
 * sharedCount = 같은 accountUuid 를 쓰는 백엔드 수 (sharedAccountCounts 로 계산).
 */
export function BackendUsageGauge({ usage, sharedCount }: { usage?: BackendUsage; sharedCount?: number }) {
  const t = useT();
  if (!usage) return null;

  // 직전 성공 수치가 남아 있으면 조회 실패라도 계속 보여준다(흐리게).
  const stale = isStaleUsage(usage);

  // unsupported = 한도 개념 없는 백엔드, error = 조회 실패 — 둘 다 조용히 숨김.
  // 단 error 라도 직전 수치가 있으면 아래 게이지로 내려보낸다.
  if (usage.status === 'unsupported') return null;
  if (usage.status === 'error' && !stale) return null;

  // 같은 계정을 쓰면 한도가 합산되므로, 게이지든 뱃지든 옆에 같이 붙인다.
  const shared = usage.tokenSource === 'shared' || (sharedCount ?? 0) >= 2;
  const withShared = (node: JSX.Element) => (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">{node}</div>
      {shared && <SharedChip count={sharedCount} />}
    </div>
  );

  if (usage.status === 'expired') {
    return withShared(<StatusBadge tone="red" label={t('backendUsage.expired')} />);
  }
  if (usage.status === 'unauthorized') {
    return withShared(<StatusBadge tone="red" label={t('backendUsage.unauthorized')} />);
  }
  // 저장된 OAuth 토큰으로는 돌아가지만 그 토큰에 조회 스코프가 없는 경우.
  // 재인증이 필요한 상태가 아니므로 빨강이 아니라 중립 배지로 표시한다.
  if (usage.status === 'token-only') {
    return withShared(
      <StatusBadge tone="zinc" label={t('backendUsage.tokenOnly')} tip={t('backendUsage.tokenOnlyTip')} />
    );
  }
  if (usage.status === 'no-credentials') {
    return withShared(
      <StatusBadge tone="zinc" label={t('backendUsage.noCredentials')} tip={t('backendUsage.noCredentialsTip')} />
    );
  }

  if (usage.status !== 'ok' && !stale) return null;
  if (!usage.fiveHour && !usage.sevenDay) return null;

  const staleTip = stale
    ? `${t('backendUsage.stale')}${usage.fetchedAt ? ` (${new Date(usage.fetchedAt).toLocaleString()})` : ''}`
    : undefined;

  return withShared(
    <div className={stale ? 'space-y-1 opacity-50' : 'space-y-1'} title={staleTip}>
      <UsageBar label={t('backendUsage.fiveHour')} win={usage.fiveHour} />
      <UsageBar label={t('backendUsage.sevenDay')} win={usage.sevenDay} />
    </div>
  );
}
