import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export function FeaturesTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const patch = useMutation({
    mutationFn: (features: Record<string, boolean>) => api.patchSettings({ features }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] })
  });

  if (!data) return <div className="text-zinc-500">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-2">
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
              onClick={() => patch.mutate({ [key]: !enabled })}
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
  );
}
