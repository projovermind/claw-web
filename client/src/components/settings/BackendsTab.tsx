import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useProgressMutation } from '../../lib/useProgressMutation';
import { Plus, Trash2, CheckCircle2, XCircle, Play, Folder, Copy, Settings2, Key, AlertTriangle, Eye, Users, Layers } from 'lucide-react';
import { api } from '../../lib/api';
import type { BackendPublic, ClaudeCliBackend, ApplyBackendToAgentsResult, ModelTiers } from '../../lib/types';
import { resolveTiers, tierLabel, normalizeTierKey, tierBackendOf } from '../../lib/model-tiers';
import { BackendCard } from './BackendCard';
import { BackendUsageGauge, useBackendUsage, sharedAccountCounts } from './BackendUsageGauge';
import { ModelRow } from './ModelRow';
import { InlineEditText } from './InlineEditText';
import { TierModelMap } from './TierModelMap';
import { AddBackendModal } from './AddBackendModal';
import { AccountAuthModal } from './AccountAuthModal';
import { ClaudeStatusCard } from './ClaudeStatusCard';
import { RevealTokenModal } from './RevealTokenModal';
import PathPicker from '../common/PathPicker';
import { useT } from '../../lib/i18n';
import { useProgressToastStore } from '../../store/progress-toast-store';
import { useToastStore } from '../../store/toast-store';

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function relativeTime(ts: number | null): string {
  if (!ts) return '없음';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function fmtSeconds(s: number): string {
  if (s <= 0) return '0s';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

const STATUS_BADGE: Record<ClaudeCliBackend['status'], string> = {
  active: 'bg-emerald-900/60 text-emerald-300 border border-emerald-800',
  cooldown: 'bg-amber-900/60 text-amber-300 border border-amber-800',
  disabled: 'bg-zinc-800 text-zinc-500 border border-zinc-700',
  'needs-relogin': 'bg-red-900/60 text-red-300 border border-red-800 animate-pulse',
};
const STATUS_LABEL: Record<ClaudeCliBackend['status'], string> = {
  active: '활성',
  cooldown: '쿨다운',
  disabled: '비활성',
  'needs-relogin': '재로그인 필요',
};

/** POST /api/backends/tiers 바디. backends 는 null 을 담지 않는다(= 키를 뺀 것이 전역 따름). */
type TiersPayload = {
  order: string[];
  labels: Record<string, string>;
  backends?: Record<string, string>;
};

export function BackendsTab() {
  const t = useT();
  const { data } = useQuery({ queryKey: ['backends'], queryFn: api.backends, refetchInterval: 5000 });
  const { data: usage } = useQuery({ queryKey: ['usage-stats'], queryFn: api.usageStats, refetchInterval: 30000 });
  const backendUsage = useBackendUsage();
  const sharedCounts = useMemo(() => sharedAccountCounts(backendUsage), [backendUsage]);
  const [adding, setAdding] = useState(false);
  const [loginHint, setLoginHint] = useState<{ configDir: string } | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [authModalId, setAuthModalId] = useState<string | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  // 일괄 적용 — 대상 백엔드('' = 전역 설정 따르기) 와 확인 모달
  const [applyTarget, setApplyTarget] = useState<string>('');
  const [applyConfirm, setApplyConfirm] = useState(false);
  // 티어 일괄 적용 — '' = 티어 해제(에이전트가 고정 모델을 쓰게 됨)
  const [applyTierTarget, setApplyTierTarget] = useState<string>('');
  const [applyTierConfirm, setApplyTierConfirm] = useState(false);
  const [draftTierKey, setDraftTierKey] = useState('');
  const [draftTierLabel, setDraftTierLabel] = useState('');
  const addToast = useToastStore((s) => s.add);
  const { data: agents } = useQuery({ queryKey: ['agents'], queryFn: api.agents });

  /** null(전역 따르기) 또는 백엔드 id 를 사람이 읽는 라벨로. */
  const backendLabelOf = (backendId: string | null): string => {
    if (backendId == null) return t('backendsTab.applyAllFollowGlobal');
    return data?.backends[backendId]?.label ?? backendId;
  };

  const tiers = useMemo(() => resolveTiers(data), [data]);

  /** '' (티어 해제) 또는 티어 키를 사람이 읽는 라벨로. */
  const tierLabelOf = (key: string): string =>
    key ? tierLabel(tiers, key) : t('backendsTab.applyTierNone');

  // Cooldown countdown — seeded from polled data, ticks every second
  const [countdowns, setCountdowns] = useState<Record<string, number>>({});

  const claudeCliList = data
    ? (Object.values(data.backends).filter((b) => b.type === 'claude-cli') as unknown as ClaudeCliBackend[])
    : [];
  const editingBackend = editingId ? (claudeCliList.find((b) => b.id === editingId) ?? null) : null;
  const authBackend = authModalId ? (claudeCliList.find((b) => b.id === authModalId) ?? null) : null;

  useEffect(() => {
    setCountdowns((prev) => {
      const next = { ...prev };
      claudeCliList.forEach((b) => {
        if (b.status === 'cooldown' && b.cooldownRemaining != null) {
          next[b.id] = b.cooldownRemaining;
        } else if (b.status !== 'cooldown') {
          delete next[b.id];
        }
      });
      return next;
    });
  }, [claudeCliList]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdowns((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const id in next) {
          if (next[id] > 0) { next[id]--; changed = true; }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // URL ?authBackend=ID 로 진입 시 (push 알림 클릭 등) 해당 백엔드의 인증 모달 자동 오픈
  useEffect(() => {
    const target = searchParams.get('authBackend');
    if (!target) return;
    if (claudeCliList.some((b) => b.id === target)) {
      setAuthModalId(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, claudeCliList.length]);

  // 모달 닫힐 때 URL 쿼리 정리
  const closeAuthModal = () => {
    setAuthModalId(null);
    if (searchParams.get('authBackend')) {
      const next = new URLSearchParams(searchParams);
      next.delete('authBackend');
      setSearchParams(next, { replace: true });
    }
  };

  const setActive = useProgressMutation<unknown, Error, string>({
    title: '백엔드 전환 중...',
    successMessage: '전환 완료',
    invalidateKeys: [['backends']],
    mutationFn: (id: string) => api.setActiveBackend(id),
  });
  const setAusterity = useProgressMutation<unknown, Error, { enabled: boolean; backendId?: string }>({
    title: '절약 모드 변경 중...',
    successMessage: '변경 완료',
    invalidateKeys: [['backends']],
    mutationFn: ({ enabled, backendId }: { enabled: boolean; backendId?: string }) =>
      api.setAusterity(enabled, backendId),
  });
  const presetsQuery = useQuery({
    queryKey: ['backend-presets'],
    queryFn: () => api.backendPresets(),
  });
  const applyPreset = useProgressMutation<unknown, Error, string>({
    title: '백엔드 추가 중...',
    successMessage: '추가 완료',
    invalidateKeys: [['backends'], ['backend-presets']],
    mutationFn: (id: string) => api.applyBackendPreset(id),
  });
  const removeBackend = useProgressMutation<unknown, Error, string>({
    title: '백엔드 삭제 중...',
    successMessage: '삭제 완료',
    invalidateKeys: [['backends']],
    mutationFn: (id: string) => api.deleteBackend(id),
  });

  const patchStatusMut = useProgressMutation<unknown, Error, { id: string; status: ClaudeCliBackend['status'] }>({
    title: '상태 변경 중...',
    successMessage: '상태가 변경되었습니다',
    invalidateKeys: [['backends']],
    mutationFn: ({ id, status }) => api.patchAccount(id, { status }),
  });

  const setFallback = useProgressMutation<unknown, Error, string | null>({
    title: '폴백 백엔드 변경 중...',
    successMessage: '변경 완료',
    invalidateKeys: [['backends']],
    mutationFn: (backendId: string | null) => api.setFallbackBackend(backendId),
  });

  const restoreAgentBackends = useProgressMutation<
    ApplyBackendToAgentsResult,
    Error,
    Record<string, string | null>
  >({
    title: t('backendsTab.applyAllProgress'),
    invalidateKeys: [['agents'], ['backends']],
    mutationFn: (previous) => api.applyBackendToAgents({ restore: previous }),
    onSuccess: (res) => {
      addToast('success', t('backendsTab.applyAllUndone', { count: res.updated }));
    },
    onError: (err) => {
      addToast('error', t('backendsTab.applyAllUndoFailed', { error: err.message }));
    },
  });

  const applyToAgents = useProgressMutation<ApplyBackendToAgentsResult, Error, string | null>({
    title: t('backendsTab.applyAllProgress'),
    invalidateKeys: [['agents'], ['backends']],
    mutationFn: (backendId: string | null) => api.applyBackendToAgents({ backendId }),
    onSuccess: (res, backendId) => {
      addToast(
        'success',
        t('backendsTab.applyAllDone', {
          count: res.updated,
          target: backendLabelOf(backendId),
        }),
        {
          action: {
            label: t('backendsTab.applyAllUndo'),
            onClick: () => restoreAgentBackends.mutate(res.previous),
          },
        }
      );
    },
    onError: (err) => {
      addToast('error', t('backendsTab.applyAllFailed', { error: err.message }));
    },
  });

  /** 티어 정의 저장 — 추가/이름변경/삭제/백엔드 지정 모두 통째 저장 한 번으로. */
  const saveTiers = useProgressMutation<ModelTiers, Error, TiersPayload>({
    title: t('backendsTab.tiersSaving'),
    successMessage: t('backendsTab.tiersSaved'),
    invalidateKeys: [['backends']],
    mutationFn: (next: TiersPayload) => api.setBackendTiers(next),
    onError: (err) => {
      addToast('error', t('backendsTab.tiersSaveFailed', { error: err.message }));
    },
  });

  /**
   * 티어는 항상 통째 저장이라 현재 값 위에 부분 수정만 얹어서 보낸다.
   * backends 는 지정된 티어가 하나도 없으면 키 자체를 빼서, 이 필드를 아직 모르는
   * 서버(구 tiersSchema 는 strict 라 400)에서도 이름변경/추가/삭제가 계속 동작하게 한다.
   */
  const saveTierPatch = (patch: Partial<ModelTiers>) => {
    const order = patch.order ?? tiers.order;
    const labels = patch.labels ?? tiers.labels;
    const merged = patch.backends ?? tiers.backends ?? {};
    const backends: Record<string, string> = {};
    for (const tier of order) {
      const b = merged[tier];
      if (b) backends[tier] = b;
    }
    saveTiers.mutate({
      order,
      labels,
      ...(Object.keys(backends).length > 0 ? { backends } : {})
    });
  };

  const restoreAgentTiers = useProgressMutation<
    ApplyBackendToAgentsResult,
    Error,
    Record<string, string | null>
  >({
    title: t('backendsTab.applyTierProgress'),
    invalidateKeys: [['agents'], ['backends']],
    mutationFn: (previousTiers) => api.applyBackendToAgents({ restoreTiers: previousTiers }),
    onSuccess: (res) => {
      addToast('success', t('backendsTab.applyTierUndone', { count: res.updated }));
    },
    onError: (err) => {
      addToast('error', t('backendsTab.applyAllUndoFailed', { error: err.message }));
    },
  });

  const applyTierToAgents = useProgressMutation<ApplyBackendToAgentsResult, Error, string | null>({
    title: t('backendsTab.applyTierProgress'),
    invalidateKeys: [['agents'], ['backends']],
    mutationFn: (modelTier: string | null) => api.applyBackendToAgents({ modelTier }),
    onSuccess: (res, modelTier) => {
      addToast(
        'success',
        t('backendsTab.applyTierDone', { count: res.updated, target: tierLabelOf(modelTier ?? '') }),
        {
          action: {
            label: t('backendsTab.applyAllUndo'),
            onClick: () => restoreAgentTiers.mutate(res.previousTiers ?? {}),
          },
        }
      );
    },
    onError: (err) => {
      addToast('error', t('backendsTab.applyTierFailed', { error: err.message }));
    },
  });

  const testMut = useProgressMutation<{ ok: boolean; output?: string; error?: string }, Error, string>({
    title: '계정 테스트 중...',
    successMessage: '테스트 완료',
    mutationFn: (id: string) => api.testAccount(id),
    onSuccess: (res, id) => {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: res.ok, msg: res.output || res.error || '' },
      }));
    },
  });

  if (!data) return <div className="text-zinc-500">Loading...</div>;

  const list = Object.values(data.backends);
  const openaiList = list.filter(
    (b): b is Extract<typeof b, { type: 'openai-compatible' | 'anthropic-compatible' }> =>
      b.type !== 'claude-cli'
  );

  return (
    <div className="space-y-5">
      {/* Claude CLI 상태 — 설치/재설치/로그인 */}
      <ClaudeStatusCard />

      {/* 토큰 사용량 요약 */}
      {usage && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="text-sm font-semibold text-zinc-300">사용량 (토큰 기준)</div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded border border-zinc-700 bg-zinc-950/60 p-3 space-y-1">
              <div className="text-zinc-500 uppercase tracking-wider text-[10px]">최근 5시간</div>
              <div className="text-xl font-mono font-bold text-amber-300">{fmtTokens(usage.window5h.total)}</div>
              <div className="text-zinc-500">
                ↑{fmtTokens(usage.window5h.inputTokens)} &nbsp;↓{fmtTokens(usage.window5h.outputTokens)}
              </div>
            </div>
            <div className="rounded border border-zinc-700 bg-zinc-950/60 p-3 space-y-1">
              <div className="text-zinc-500 uppercase tracking-wider text-[10px]">최근 7일</div>
              <div className="text-xl font-mono font-bold text-sky-300">{fmtTokens(usage.window7d.total)}</div>
              <div className="text-zinc-500">
                ↑{fmtTokens(usage.window7d.inputTokens)} &nbsp;↓{fmtTokens(usage.window7d.outputTokens)}
              </div>
            </div>
          </div>
          <div className="text-[10px] text-zinc-600">* Anthropic 계정의 실제 잔여 한도는 별도 확인 필요 (API로 조회 불가)</div>
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        <div className="text-sm font-semibold text-zinc-300">Global</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Active Backend</div>
            <select
              value={data.activeBackend}
              onChange={(e) => setActive.mutate(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            >
              {list.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} ({b.id})
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{t('backendsTab.austerityTitle')}</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  setAusterity.mutate({ enabled: !data.austerityMode, backendId: data.austerityBackend })
                }
                className={`flex-1 rounded px-3 py-2 text-sm ${
                  data.austerityMode
                    ? 'bg-amber-900/40 text-amber-200'
                    : 'bg-zinc-800 text-zinc-400'
                }`}
              >
                {data.austerityMode ? 'ON' : 'OFF'} &rarr; {data.austerityBackend}
              </button>
            </div>
          </div>
        </div>
        <p className="text-[11px] text-zinc-500">
          {t('backendsTab.austerityDesc', { backend: data.austerityBackend })}
        </p>

        {/* 폴백 백엔드 — 에이전트에 백엔드가 지정 안 됐을 때 */}
        <div className="pt-3 border-t border-zinc-800">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
            {t('backendsTab.fallbackTitle')}
          </div>
          <select
            value={data.fallbackBackend ?? ''}
            onChange={(e) => setFallback.mutate(e.target.value || null)}
            disabled={setFallback.isPending}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="">{t('backendsTab.fallbackNone')}</option>
            {list.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} ({b.id})
              </option>
            ))}
          </select>
          <p className="text-[11px] text-zinc-500 mt-1">{t('backendsTab.fallbackDesc')}</p>
        </div>

        {/* 전체 에이전트 백엔드 일괄 적용 */}
        <div className="pt-3 border-t border-zinc-800">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
            <Users size={11} />
            {t('backendsTab.applyAllTitle')}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={applyTarget}
              onChange={(e) => setApplyTarget(e.target.value)}
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            >
              <option value="">{t('backendsTab.applyAllFollowGlobal')}</option>
              {list.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} ({b.id})
                </option>
              ))}
            </select>
            <button
              onClick={() => setApplyConfirm(true)}
              disabled={applyToAgents.isPending || restoreAgentBackends.isPending}
              className="shrink-0 rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-2 text-xs disabled:opacity-50"
            >
              {t('backendsTab.applyAllButton')}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">{t('backendsTab.applyAllDesc')}</p>
          <p className="flex items-start gap-1 text-[11px] text-amber-400/80 mt-1 leading-snug">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            <span>{t('backendsTab.applyAllTierWarn')}</span>
          </p>

          {/* 티어 일괄 적용 — 백엔드 일괄 적용과 같은 되돌리기 토스트 흐름 */}
          <div className="flex items-center gap-2 mt-2">
            <select
              value={applyTierTarget}
              onChange={(e) => setApplyTierTarget(e.target.value)}
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            >
              {tiers.order.map((key) => (
                <option key={key} value={key}>
                  {tierLabel(tiers, key)}
                </option>
              ))}
              <option value="">{t('backendsTab.applyTierNone')}</option>
            </select>
            <button
              onClick={() => setApplyTierConfirm(true)}
              disabled={applyTierToAgents.isPending || restoreAgentTiers.isPending}
              className="shrink-0 rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-2 text-xs disabled:opacity-50"
            >
              {t('backendsTab.applyTierButton')}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">{t('backendsTab.applyTierDesc')}</p>
        </div>

        {/* 모델 티어 관리 — 추가 / 이름변경 / 삭제 */}
        <div className="pt-3 border-t border-zinc-800">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
            <Layers size={11} />
            {t('backendsTab.tiersTitle')}
          </div>
          <p className="text-[11px] text-zinc-500 mb-2">{t('backendsTab.tiersDesc')}</p>
          <div className="space-y-1">
            {tiers.order.map((key) => {
              const pinned = tierBackendOf(tiers, key);
              // 전역 따름이면 지금의 activeBackend 기준으로 풀린다 — 그 결과를 그대로 보여준다.
              const effectiveId = pinned ?? data.activeBackend;
              const effective = data.backends[effectiveId];
              const resolvedModel = effective?.tierModels?.[key] ?? null;
              return (
                <div key={key} className="flex items-center gap-1.5">
                  {/* 1칸: 티어명 (라벨 인라인 수정 + 원래 키) */}
                  <div className="w-32 shrink-0 min-w-0">
                    <InlineEditText
                      value={tierLabel(tiers, key)}
                      onSave={(v) => saveTierPatch({ labels: { ...tiers.labels, [key]: v } })}
                      className="text-sm text-zinc-200 truncate"
                      placeholder={key}
                    />
                    <div className="font-mono text-[10px] text-zinc-600 truncate">{key}</div>
                  </div>

                  {/* 2칸: 이 티어를 실행할 백엔드 */}
                  <select
                    value={pinned ?? ''}
                    disabled={saveTiers.isPending}
                    onChange={(e) =>
                      saveTierPatch({
                        backends: { ...(tiers.backends ?? {}), [key]: e.target.value || null }
                      })
                    }
                    className="w-44 shrink-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-300 disabled:opacity-50"
                  >
                    <option value="">{t('backendsTab.tierBackendGlobal')}</option>
                    {list.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>

                  {/* 3칸: 그 백엔드에서 실제로 풀리는 모델 ID */}
                  {resolvedModel ? (
                    <span
                      className="flex-1 min-w-0 truncate font-mono text-[11px] text-zinc-400"
                      title={t('backendsTab.tierResolvedVia', {
                        backend: effective?.label ?? effectiveId,
                        model: resolvedModel
                      })}
                    >
                      &rarr; {resolvedModel}
                    </span>
                  ) : (
                    <span
                      className="flex-1 min-w-0 truncate flex items-center gap-1 text-[11px] text-amber-400/90"
                      title={t('backendsTab.tierUnmappedHint', {
                        backend: effective?.label ?? effectiveId
                      })}
                    >
                      <AlertTriangle size={10} className="shrink-0" />
                      {t('backendsTab.tierUnmapped')}
                    </span>
                  )}

                  <button
                    onClick={() => {
                      if (!confirm(t('backendsTab.tierDeleteConfirm', { tier: tierLabel(tiers, key) }))) return;
                      const labels = { ...tiers.labels };
                      const backends = { ...(tiers.backends ?? {}) };
                      delete labels[key];
                      delete backends[key];
                      saveTierPatch({ order: tiers.order.filter((k) => k !== key), labels, backends });
                    }}
                    disabled={saveTiers.isPending || tiers.order.length <= 1}
                    className="p-1 rounded hover:bg-red-900/40 text-zinc-500 hover:text-red-400 disabled:opacity-30"
                    title={t('backendsTab.tierDelete')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex gap-1 pt-2">
            <input
              value={draftTierKey}
              onChange={(e) => setDraftTierKey(e.target.value)}
              placeholder={t('backendsTab.tierKeyPlaceholder')}
              className="w-32 shrink-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] font-mono"
            />
            <input
              value={draftTierLabel}
              onChange={(e) => setDraftTierLabel(e.target.value)}
              placeholder={t('backendsTab.tierLabelPlaceholder')}
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px]"
            />
            <button
              onClick={() => {
                const key = normalizeTierKey(draftTierKey);
                if (!key || tiers.order.includes(key)) return;
                saveTierPatch({
                  order: [...tiers.order, key],
                  labels: { ...tiers.labels, [key]: draftTierLabel.trim() || key },
                });
                setDraftTierKey('');
                setDraftTierLabel('');
              }}
              disabled={
                saveTiers.isPending ||
                !normalizeTierKey(draftTierKey) ||
                tiers.order.includes(normalizeTierKey(draftTierKey))
              }
              className="shrink-0 rounded bg-emerald-900/40 hover:bg-emerald-900/60 disabled:opacity-30 text-emerald-200 px-2 py-1 text-[11px] flex items-center"
            >
              <Plus size={11} />
            </button>
          </div>
          {tiers.order.includes(normalizeTierKey(draftTierKey)) && (
            <p className="text-[11px] text-amber-400/80 mt-1">{t('backendsTab.tierKeyDuplicate')}</p>
          )}
        </div>
      </div>

      {applyConfirm && (
        <ApplyToAgentsConfirm
          targetLabel={backendLabelOf(applyTarget || null)}
          affectedCount={
            agents ? agents.filter((a) => (a.backendId ?? null) !== (applyTarget || null)).length : null
          }
          onCancel={() => setApplyConfirm(false)}
          onConfirm={() => {
            setApplyConfirm(false);
            applyToAgents.mutate(applyTarget || null);
          }}
        />
      )}

      {applyTierConfirm && (
        <ApplyToAgentsConfirm
          kind="modelTier"
          targetLabel={tierLabelOf(applyTierTarget)}
          affectedCount={
            agents
              ? agents.filter((a) => (a.modelTier ?? null) !== (applyTierTarget || null)).length
              : null
          }
          onCancel={() => setApplyTierConfirm(false)}
          onConfirm={() => {
            setApplyTierConfirm(false);
            applyTierToAgents.mutate(applyTierTarget || null);
          }}
        />
      )}

      {/* 원클릭 프리셋 — 아직 등록 안 된 것만 노출 */}
      {(presetsQuery.data?.some((p) => !p.installed) ?? false) && (
        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">빠른 추가</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {presetsQuery.data!.filter((p) => !p.installed).map((p) => (
              <div key={p.id} className="border border-zinc-800 bg-zinc-900/40 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-zinc-200">{p.label}</span>
                  <button
                    onClick={() => applyPreset.mutate(p.id)}
                    disabled={applyPreset.isPending}
                    className="shrink-0 rounded bg-zinc-800 hover:bg-zinc-700 px-2 py-1 text-xs flex items-center gap-1 disabled:opacity-50"
                  >
                    <Plus size={11} /> 추가
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed">{p.desc}</p>
                {p.warn && (
                  <p className="flex items-start gap-1 text-[11px] text-amber-400/80 leading-relaxed">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    <span>{p.warn}</span>
                  </p>
                )}
                <p className="text-[10px] text-zinc-600 font-mono truncate">{p.backend.baseURL}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Backends (claude-cli first, openai-compatible after) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-zinc-300">Backends ({list.length})</div>
          <button
            onClick={() => setAdding(true)}
            className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs flex items-center gap-1"
          >
            <Plus size={12} /> {t('backendsTab.addBackend')}
          </button>
        </div>

        {loginHint && (
          <LoginHintBanner
            configDir={loginHint.configDir}
            onClose={() => setLoginHint(null)}
          />
        )}

        {/* Claude CLI cards */}
        {claudeCliList.map((b) => {
          const countdown = countdowns[b.id];
          const testRes = testResults[b.id];
          const cred = b.cred;
          const credHas = cred?.has ?? false;
          const credExpiringSoon = cred?.expiringSoon ?? false;
          const needsRelogin = b.status === 'needs-relogin';
          const authLabel = !credHas ? '최초 연결' : (needsRelogin || credExpiringSoon) ? '토큰 갱신' : '인증';
          const authBtnClass = needsRelogin
            ? 'bg-red-900/60 hover:bg-red-800/70 text-red-200 border-red-800/60 animate-pulse'
            : credExpiringSoon
            ? 'bg-amber-900/50 hover:bg-amber-800/60 text-amber-200 border-amber-800/60'
            : credHas
            ? 'bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-200 border-emerald-800/50'
            : 'bg-sky-900/50 hover:bg-sky-800/60 text-sky-300 border-sky-800/50';
          return (
            <div key={b.id} className={`border rounded-lg p-3 space-y-2 ${needsRelogin ? 'border-red-800/60 bg-red-950/10' : 'border-zinc-800 bg-zinc-900/40'}`}>
              {needsRelogin && (
                <div className="flex items-start gap-1.5 text-[11px] text-red-300 bg-red-950/40 border border-red-900/50 rounded px-2 py-1">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>토큰이 만료되었거나 인증이 필요합니다 — 우측 <strong>인증</strong> 버튼을 눌러 갱신하세요.</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${STATUS_BADGE[b.status]}`}>
                    {STATUS_LABEL[b.status]}
                    {b.status === 'cooldown' && countdown != null && countdown > 0 && (
                      <span className="ml-1 opacity-70">{fmtSeconds(countdown)}</span>
                    )}
                  </span>
                  {/* 자격증명 배지 */}
                  <CredBadge cred={cred} />
                  <span className="font-medium text-sm truncate">{b.label}</span>
                  <span className="text-[10px] text-zinc-600 font-mono shrink-0">{b.id}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    title="인증 관리 — 토큰 붙여넣기 / 헤드리스 / Terminal / 백업"
                    onClick={() => setAuthModalId(b.id)}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${authBtnClass}`}
                  >
                    <Key size={12} />
                    {authLabel}
                  </button>
                  <button
                    title="연결 테스트"
                    onClick={() => testMut.mutate(b.id)}
                    disabled={testMut.isPending && testMut.variables === b.id}
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  >
                    <Play size={13} />
                  </button>
                  <button
                    title={b.status === 'disabled' ? '활성화' : '비활성화'}
                    onClick={() =>
                      patchStatusMut.mutate({ id: b.id, status: b.status === 'disabled' ? 'active' : 'disabled' })
                    }
                    disabled={patchStatusMut.isPending}
                    className="px-2 py-0.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200"
                  >
                    {b.status === 'disabled' ? '활성화' : '비활성화'}
                  </button>
                  <button
                    title="저장된 토큰 보기 (비밀번호 필요)"
                    onClick={() => setRevealId(b.id)}
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-amber-300"
                  >
                    <Eye size={13} />
                  </button>
                  <button
                    title="편집 (모델/configDir)"
                    onClick={() => setEditingId(b.id)}
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  >
                    <Settings2 size={13} />
                  </button>
                  <button
                    onClick={() => removeBackend.mutate(b.id)}
                    disabled={removeBackend.isPending}
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <Folder size={11} className="shrink-0" />
                <span className="font-mono truncate flex-1">{b.configDir || '—'}</span>
                {b.configDir && (
                  <CopyLoginCmd configDir={b.configDir} onCopied={() => setLoginHint({ configDir: b.configDir })} />
                )}
              </div>

              {/* 모델 설정 요약 */}
              {b.models && Object.keys(b.models).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(b.models).map(([k, v]) => (
                    <span key={k} className="text-[10px] font-mono bg-zinc-800 text-zinc-400 rounded px-1.5 py-0.5">
                      {k}: {v}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-3 text-[10px] text-zinc-600">
                <span>마지막 사용: {relativeTime(b.lastUsedAt)}</span>
                {b.usage && <span>이번 시간 {b.usage.messagesUsed}건</span>}
                <span>우선순위 {b.priority}</span>
              </div>

              <BackendUsageGauge usage={backendUsage?.[b.id]} sharedCount={sharedCounts[b.id]} />

              {testRes && (
                <div className={`flex items-start gap-1.5 text-[11px] rounded px-2 py-1 ${testRes.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300'}`}>
                  {testRes.ok ? <CheckCircle2 size={11} className="mt-0.5 shrink-0" /> : <XCircle size={11} className="mt-0.5 shrink-0" />}
                  <span className="font-mono break-all">{testRes.msg || (testRes.ok ? 'OK' : '실패')}</span>
                </div>
              )}
            </div>
          );
        })}

        {/* OpenAI-compatible / Anthropic-compatible cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {openaiList.map((b) => (
            <BackendCard
              key={b.id}
              backend={b}
              isActive={b.id === data.activeBackend}
              isAusterity={b.id === data.austerityBackend}
              allBackends={openaiList}
              usage={backendUsage?.[b.id]}
              sharedCount={sharedCounts[b.id]}
              onDelete={() => {
                if (confirm(t('backendsTab.deleteConfirm', { label: b.label }))) removeBackend.mutate(b.id);
              }}
              onReveal={() => setRevealId(b.id)}
            />
          ))}
        </div>
      </div>

      {adding && <AddBackendModal onClose={() => setAdding(false)} />}

      {/* 기존 Claude CLI 계정 편집 모달 */}
      {editingBackend && (
        <EditClaudeCliModal
          backend={editingBackend}
          allBackends={list}
          globalFallback={data.fallbackBackend ?? null}
          tiers={tiers}
          onClose={() => setEditingId(null)}
        />
      )}

      {/* 인증 관리 모달 — 토큰/헤드리스/Terminal/백업 통합 */}
      {authBackend && (
        <AccountAuthModal
          backend={authBackend}
          onClose={closeAuthModal}
        />
      )}

      {/* 저장된 토큰 보기 모달 — 비밀번호(서버 인증 토큰) 재확인 후 노출 */}
      {revealId && (() => {
        const target = list.find((b) => b.id === revealId);
        if (!target) return null;
        return (
          <RevealTokenModal
            backendId={target.id}
            backendLabel={target.label}
            onClose={() => setRevealId(null)}
          />
        );
      })()}
    </div>
  );
}

/** 자격증명 보유 + 만료 임박 + 출처를 한 줄 배지로 */
function CredBadge({ cred }: { cred?: ClaudeCliBackend['cred'] }) {
  if (!cred) return null;
  if (!cred.has) {
    return (
      <span title="자격증명 없음 — 인증 필요" className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700 shrink-0">
        ❌ 미인증
      </span>
    );
  }
  if (cred.expiringSoon) {
    return (
      <span
        title={cred.expiresAt ? `만료 임박 (${new Date(cred.expiresAt).toLocaleString()})` : '만료 임박'}
        className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-300 border border-amber-800/60 shrink-0"
      >
        ⚠️ 만료 임박
      </span>
    );
  }
  const sourceLabel: Record<string, string> = {
    'managed': '🔑 토큰',
    'credentials.json': '✅ 인증',
    'oauthAccount': '✅ 인증',
    'keychain': '🔐 Keychain',
    'shell': '✅ shell',
    'none': '❌ 미인증',
  };
  return (
    <span
      title={cred.accountEmail ? `${cred.source} (${cred.accountEmail})` : cred.source}
      className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/50 shrink-0"
    >
      {sourceLabel[cred.source] ?? '✅ 인증'}
    </span>
  );
}

/** 기존 Claude CLI 계정 편집 (configDir + 폴백 + models) */
function EditClaudeCliModal({
  backend,
  allBackends,
  globalFallback,
  tiers,
  onClose,
}: {
  backend: ClaudeCliBackend;
  allBackends: BackendPublic[];
  globalFallback: string | null;
  tiers: ModelTiers;
  onClose: () => void;
}) {
  const t = useT();
  const [configDir, setConfigDir] = useState(backend.configDir ?? '');
  const [fallback, setFallback] = useState<string>(backend.fallback ?? '');
  const [models, setModels] = useState<Record<string, string>>({ ...backend.models });
  const [tierModels, setTierModels] = useState<Record<string, string>>({ ...(backend.tierModels ?? {}) });
  const [showPicker, setShowPicker] = useState(false);
  const [draftAlias, setDraftAlias] = useState('');
  const [draftModel, setDraftModel] = useState('');

  // 자기 자신은 폴백 대상이 될 수 없다 (자기참조는 서버가 무시)
  const fallbackOptions = allBackends.filter((b) => b.id !== backend.id);
  const globalFallbackLabel = globalFallback
    ? (allBackends.find((b) => b.id === globalFallback)?.label ?? globalFallback)
    : null;

  const patch = useProgressMutation<unknown, Error, void>({
    title: '저장 중...',
    successMessage: '저장 완료',
    invalidateKeys: [['backends'], ['accounts']],
    mutationFn: async (): Promise<unknown> => {
      const res = await api.patchAccount(backend.id, {
        configDir: configDir.trim() || undefined,
        models,
      });
      // fallback / tierModels 는 계정 스키마가 아니라 백엔드 스키마의 필드 → 변경됐을 때만 별도 PATCH
      const next = fallback || null;
      const backendPatch: Record<string, unknown> = {};
      if (next !== (backend.fallback ?? null)) backendPatch.fallback = next;
      if (JSON.stringify(tierModels) !== JSON.stringify(backend.tierModels ?? {})) {
        backendPatch.tierModels = tierModels;
      }
      if (Object.keys(backendPatch).length > 0) {
        await api.patchBackend(backend.id, backendPatch);
      }
      return res;
    },
    onSuccess: onClose,
  });

  const addModel = () => {
    const key = draftAlias.trim();
    const val = draftModel.trim();
    if (!key || !val) return;
    setModels((prev) => ({ ...prev, [key]: val }));
    setDraftAlias('');
    setDraftModel('');
  };

  const removeModel = (key: string) => {
    setModels((prev) => { const n = { ...prev }; delete n[key]; return n; });
  };

  const updateModel = (key: string, newVal: string) => {
    setModels((prev) => ({ ...prev, [key]: newVal }));
  };

  const renameModel = (oldKey: string, newKey: string) => {
    setModels((prev) => {
      const n: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        n[k === oldKey ? newKey : k] = v;
      }
      return n;
    });
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 sticky top-0 bg-zinc-900">
            <div>
              <h3 className="text-base font-semibold">계정 편집</h3>
              <div className="text-[11px] text-zinc-500 font-mono">{backend.label} · {backend.id}</div>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">✕</button>
          </div>

          <div className="p-5 space-y-4">
            {/* Config 저장소 */}
            <div>
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Config 저장소 (configDir)</div>
              <div className="flex gap-2">
                <input
                  value={configDir}
                  onChange={(e) => setConfigDir(e.target.value)}
                  placeholder="~/.claude-claw/account-..."
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                />
                <button
                  onClick={() => setShowPicker(true)}
                  className="flex items-center gap-1 px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 border border-zinc-700 shrink-0"
                >
                  <Folder size={13} />
                  찾기
                </button>
              </div>
            </div>

            {/* 폴백 백엔드 — 이 계정이 실패했을 때 대신 쓸 곳 */}
            <div>
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
                {t('editAccount.fallbackTitle')}
              </div>
              <select
                value={fallback}
                onChange={(e) => setFallback(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              >
                <option value="">
                  {globalFallbackLabel
                    ? t('editAccount.fallbackInherit', { backend: globalFallbackLabel })
                    : t('editAccount.fallbackNone')}
                </option>
                {fallbackOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} ({b.id})
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-zinc-500 mt-1">{t('editAccount.fallbackDesc')}</p>
            </div>

            {/* 티어 → 모델 매핑 — 저장 버튼까지 버퍼링 */}
            <div className="border border-zinc-800 rounded-lg p-3 space-y-2 bg-zinc-950/40">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
                {t('tierMap.title')}
              </div>
              <TierModelMap
                tiers={tiers}
                models={models}
                value={tierModels}
                onChange={setTierModels}
              />
            </div>

            {/* 모델 단축명 설정 — BackendCard 와 동일한 ModelRow UI */}
            <div className="border border-zinc-800 rounded-lg p-3 space-y-2 bg-zinc-950/40">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
                모델 단축명 ({Object.keys(models).length})
              </div>
              <p className="text-[11px] text-zinc-600 leading-snug mb-2">
                단축명(opus/sonnet 등) → 실제 모델 ID 매핑. 클릭하면 인라인 수정.
              </p>

              {Object.keys(models).length === 0 && (
                <div className="text-[11px] text-zinc-600 italic">단축명 없음 — 아래에서 추가하세요</div>
              )}

              <div className="space-y-1">
                {Object.entries(models).map(([alias, modelId]) => (
                  <ModelRow
                    key={alias}
                    alias={alias}
                    modelId={modelId}
                    onUpdate={(v) => updateModel(alias, v)}
                    onRename={(newAlias) => renameModel(alias, newAlias)}
                    onRemove={() => removeModel(alias)}
                  />
                ))}
              </div>

              {/* 새 단축명 추가 */}
              <div className="flex gap-1 pt-1">
                <input
                  value={draftAlias}
                  onChange={(e) => setDraftAlias(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addModel()}
                  placeholder="단축명 (예: opus)"
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] font-mono"
                />
                <input
                  value={draftModel}
                  onChange={(e) => setDraftModel(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addModel()}
                  placeholder="실제 모델 ID (예: claude-opus-4-5)"
                  className="flex-[2] bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] font-mono"
                />
                <button
                  onClick={addModel}
                  disabled={!draftAlias.trim() || !draftModel.trim()}
                  className="rounded bg-emerald-900/40 hover:bg-emerald-900/60 disabled:opacity-30 text-emerald-200 px-2 py-1 text-[11px] flex items-center"
                >
                  <Plus size={11} />
                </button>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-800 sticky bottom-0 bg-zinc-900">
            <button onClick={onClose} className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm">취소</button>
            <button
              disabled={patch.isPending}
              onClick={() => patch.mutate()}
              className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm"
            >
              {patch.isPending ? '저장 중...' : '저장'}
            </button>
          </div>
        </div>
      </div>

      <PathPicker
        open={showPicker}
        initialPath={configDir || undefined}
        onSelect={(p) => setConfigDir(p)}
        onClose={() => setShowPicker(false)}
      />
    </>
  );
}

function LoginHintBanner({ configDir, onClose }: { configDir: string; onClose: () => void }) {
  const cmd = `CLAUDE_CONFIG_DIR=${configDir} claude login`;
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="border border-emerald-800 bg-emerald-950/30 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-emerald-400">로그인 필요</span>
        <button onClick={onClose} className="text-[10px] text-zinc-500 hover:text-zinc-300">닫기</button>
      </div>
      <p className="text-[11px] text-zinc-400">아래 명령으로 새 계정에 로그인하세요:</p>
      <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5">
        <code className="text-[11px] text-emerald-300 font-mono flex-1 break-all">{cmd}</code>
        <button onClick={copy} className="shrink-0 text-zinc-500 hover:text-zinc-200">
          {copied ? <CheckCircle2 size={13} className="text-emerald-400" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}

function CopyLoginCmd({ configDir, onCopied }: { configDir: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  const { startTask, completeTask } = useProgressToastStore();
  const copy = () => {
    const cmd = `CLAUDE_CONFIG_DIR=${configDir} claude login`;
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      const id = `copy-${Date.now()}`;
      startTask({ id, title: '클립보드 복사됨' });
      setTimeout(() => completeTask(id, 'claude login 명령이 복사되었습니다'), 50);
      onCopied?.();
    });
  };
  return (
    <button onClick={copy} title="claude login 명령 복사" className="text-zinc-600 hover:text-zinc-300 shrink-0">
      {copied ? <CheckCircle2 size={11} className="text-emerald-400" /> : <Copy size={11} />}
    </button>
  );
}

/** 일괄 적용 확인 모달 — 영향받는 에이전트 수를 먼저 알려준다. */
function ApplyToAgentsConfirm({
  targetLabel,
  affectedCount,
  kind = 'backend',
  onConfirm,
  onCancel,
}: {
  targetLabel: string;
  /** 에이전트 목록을 아직 못 읽었으면 null */
  affectedCount: number | null;
  /** 바꾸는 대상 — 백엔드인지 모델 티어인지. 확인 문구만 달라진다. */
  kind?: 'backend' | 'modelTier';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const isTier = kind === 'modelTier';
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-zinc-800">
          <Users size={14} className="text-amber-400" />
          <h3 className="text-sm font-semibold">
            {t(isTier ? 'backendsTab.applyTierConfirmTitle' : 'backendsTab.applyAllConfirmTitle')}
          </h3>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-sm text-zinc-300 leading-relaxed">
            {affectedCount == null
              ? t(
                  isTier
                    ? 'backendsTab.applyTierConfirmBodyUnknown'
                    : 'backendsTab.applyAllConfirmBodyUnknown',
                  { target: targetLabel }
                )
              : t(isTier ? 'backendsTab.applyTierConfirmBody' : 'backendsTab.applyAllConfirmBody', {
                  count: affectedCount,
                  target: targetLabel,
                })}
          </p>
          <p className="text-[11px] text-zinc-500">
            {t(isTier ? 'backendsTab.applyTierDesc' : 'backendsTab.applyAllDesc')}
          </p>
          {!isTier && (
            <p className="flex items-start gap-1 text-[11px] text-amber-400/80 leading-snug">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>{t('backendsTab.applyAllTierWarn')}</span>
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onCancel}
              className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs"
            >
              {t('backendsTab.applyAllConfirmCancel')}
            </button>
            <button
              onClick={onConfirm}
              className="rounded bg-amber-900/60 hover:bg-amber-800/70 text-amber-100 px-3 py-1.5 text-xs"
            >
              {t('backendsTab.applyAllConfirmOk')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
