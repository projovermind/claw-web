import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { BackendCard } from './BackendCard';
import { AddBackendModal } from './AddBackendModal';
import { useT } from '../../lib/i18n';

export function BackendsTab() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['backends'], queryFn: api.backends });
  const [adding, setAdding] = useState(false);

  const setActive = useMutation({
    mutationFn: (id: string) => api.setActiveBackend(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backends'] })
  });
  const setAusterity = useMutation({
    mutationFn: ({ enabled, backendId }: { enabled: boolean; backendId?: string }) =>
      api.setAusterity(enabled, backendId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backends'] })
  });
  const removeBackend = useMutation({
    mutationFn: (id: string) => api.deleteBackend(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backends'] })
  });

  if (!data) return <div className="text-zinc-500">Loading...</div>;

  const list = Object.values(data.backends);

  return (
    <div className="space-y-5">
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
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-zinc-300">Backends ({list.length})</div>
        <button
          onClick={() => setAdding(true)}
          className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs flex items-center gap-1"
        >
          <Plus size={12} /> {t('backendsTab.addBackend')}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {list.map((b) => (
          <BackendCard
            key={b.id}
            backend={b}
            isActive={b.id === data.activeBackend}
            isAusterity={b.id === data.austerityBackend}
            allBackends={list}
            onDelete={() => {
              if (b.type === 'claude-cli') return;
              if (confirm(t('backendsTab.deleteConfirm', { label: b.label }))) removeBackend.mutate(b.id);
            }}
          />
        ))}
      </div>

      {adding && <AddBackendModal onClose={() => setAdding(false)} />}
    </div>
  );
}
