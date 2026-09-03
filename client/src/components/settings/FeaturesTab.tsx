import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProgressMutation } from '../../lib/useProgressMutation';
import { api } from '../../lib/api';
import type { WebSettings } from '../../lib/types';

const COMPACT_CHOICES = [0, 50, 60, 70, 80] as const;

/** 빈 문자열/음수/NaN 은 모두 0(미설정) 으로 접는다. */
function parseBudget(raw: string): number {
  const n = Number(raw.replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function FeaturesTab() {
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const patch = useProgressMutation<
    unknown,
    Error,
    Parameters<typeof api.patchSettings>[0]
  >({
    title: '설정 변경 중...',
    successMessage: '변경 완료',
    invalidateKeys: [['settings'], ['usage-stats']],
    mutationFn: (body) => api.patchSettings(body),
  });

  const [budget5h, setBudget5h] = useState('');
  const [budget7d, setBudget7d] = useState('');

  useEffect(() => {
    const usage = (data as WebSettings | undefined)?.usage;
    setBudget5h(usage?.budget5h ? String(usage.budget5h) : '');
    setBudget7d(usage?.budget7d ? String(usage.budget7d) : '');
  }, [data]);

  if (!data) return <div className="text-zinc-500">Loading...</div>;

  const autoCompactPct = data.chat?.autoCompactPct ?? 0;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-2">
        <p className="text-[11px] text-zinc-500">
          각 기능은 개별 토글 가능. OFF로 바꾸면 사이드바에서 숨겨지고 해당 API도 비활성(Phase 4).
        </p>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800">
          {Object.entries(data.features).map(([key, enabled]) => (
            <div key={key} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-sm font-semibold">{key}</div>
              </div>
              <button
                onClick={() => patch.mutate({ features: { [key]: !enabled } })}
                className={`rounded px-4 py-1.5 text-xs ${
                  enabled ? 'bg-emerald-900/40 text-emerald-200' : 'bg-zinc-800 text-zinc-400'
                }`}
              >
                {enabled ? 'ON' : 'OFF'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 자동 compact */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 space-y-2">
        <div className="text-sm font-semibold text-zinc-200">자동 compact</div>
        <p className="text-[11px] text-zinc-500">
          턴이 끝난 뒤 세션 컨텍스트 사용률이 임계값을 넘으면 자동으로 압축합니다. 0 = 끔.
        </p>
        <div className="flex gap-1.5">
          {COMPACT_CHOICES.map((pct) => (
            <button
              key={pct}
              onClick={() => patch.mutate({ chat: { autoCompactPct: pct } })}
              className={`px-3 py-1.5 rounded text-xs ${
                autoCompactPct === pct
                  ? 'bg-emerald-900/50 text-emerald-200'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {pct === 0 ? '끔' : `${pct}%`}
            </button>
          ))}
        </div>
      </div>

      {/* 사용량 예산 */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 space-y-2">
        <div className="text-sm font-semibold text-zinc-200">사용량 예산</div>
        <p className="text-[11px] text-zinc-500">
          창별 토큰 예산. 대시보드 비용 위젯에 소진율 막대로 표시됩니다. 0 또는 비우면 미설정.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">5시간</span>
            <input
              value={budget5h}
              onChange={(e) => setBudget5h(e.target.value)}
              inputMode="numeric"
              placeholder="예: 2000000"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">7일</span>
            <input
              value={budget7d}
              onChange={(e) => setBudget7d(e.target.value)}
              inputMode="numeric"
              placeholder="예: 50000000"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
            />
          </label>
        </div>
        <div className="flex justify-end">
          <button
            onClick={() =>
              patch.mutate({
                usage: { budget5h: parseBudget(budget5h), budget7d: parseBudget(budget7d) }
              })
            }
            className="text-xs bg-emerald-900/50 text-emerald-200 px-4 py-1.5 rounded hover:bg-emerald-900/70"
          >
            예산 저장
          </button>
        </div>
      </div>
    </div>
  );
}
