import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, RefreshCw, Globe2, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import type { InstancePublic } from '../../lib/types';
import { useT } from '../../lib/i18n';

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

export function InstancesTab() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['instances'], queryFn: api.instances });

  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [selfId, setSelfId] = useState('');
  const [selfPublicUrl, setSelfPublicUrl] = useState('');
  const [selfDirty, setSelfDirty] = useState(false);

  useEffect(() => {
    if (!data || selfDirty) return;
    setSelfId(data.selfId);
    setSelfPublicUrl(data.selfPublicUrl ?? '');
  }, [data, selfDirty]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['instances'] });

  const createMut = useMutation({
    mutationFn: () => api.createInstance({ id, label: label.trim() || undefined, baseUrl: baseUrl.trim(), token: token.trim() || undefined }),
    onSuccess: () => { setId(''); setLabel(''); setBaseUrl(''); setToken(''); setError(null); invalidate(); },
    onError: (e: Error) => setError(e.message)
  });

  const deleteMut = useMutation({
    mutationFn: (instId: string) => api.deleteInstance(instId),
    onSuccess: invalidate
  });

  const toggleMut = useMutation({
    mutationFn: ({ instId, enabled }: { instId: string; enabled: boolean }) => api.patchInstance(instId, { enabled }),
    onSuccess: invalidate
  });

  const saveSelfMut = useMutation({
    mutationFn: () => api.setInstancesSelf({ selfId: selfId.trim() || undefined, selfPublicUrl: selfPublicUrl.trim() || null }),
    onSuccess: () => { setSelfDirty(false); invalidate(); }
  });

  const canAdd = !!slugify(id) && /^https?:\/\//.test(baseUrl.trim());

  if (isLoading) return <div className="text-zinc-500 text-sm">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-5">
      <p className="text-[11px] text-zinc-500">{t('instancesTab.help')}</p>

      {/* self — 이 인스턴스가 스스로를 부르는 식별자와 콜백 주소 */}
      <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
        <div className="text-xs text-zinc-400 flex items-center gap-1.5">
          <ShieldCheck size={13} /> {t('instancesTab.selfTitle')}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{t('instancesTab.selfId')}</span>
            <input
              value={selfId}
              onChange={(e) => { setSelfId(e.target.value); setSelfDirty(true); }}
              placeholder="self"
              spellCheck={false}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-600"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{t('instancesTab.selfPublicUrl')}</span>
            <input
              value={selfPublicUrl}
              onChange={(e) => { setSelfPublicUrl(e.target.value); setSelfDirty(true); }}
              placeholder="https://this-machine.example.com"
              spellCheck={false}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-600"
            />
          </label>
        </div>
        <p className="text-[11px] text-zinc-600">{t('instancesTab.selfHelp')}</p>
        <div className="flex justify-end">
          <button
            onClick={() => saveSelfMut.mutate()}
            disabled={!selfDirty || saveSelfMut.isPending}
            className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 py-1.5 rounded disabled:opacity-40"
          >
            {saveSelfMut.isPending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>

      {/* 등록된 인스턴스 목록 */}
      <div className="space-y-2">
        {(data?.instances ?? []).map((inst) => (
          <InstanceRow
            key={inst.id}
            inst={inst}
            onToggle={(enabled) => toggleMut.mutate({ instId: inst.id, enabled })}
            onDelete={() => {
              if (confirm(t('instancesTab.confirmDelete', { label: inst.label }))) deleteMut.mutate(inst.id);
            }}
          />
        ))}
        {(data?.instances ?? []).length === 0 && (
          <div className="text-[11px] text-zinc-600 border border-dashed border-zinc-800 rounded px-3 py-4 text-center">
            {t('instancesTab.empty')}
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800 pt-4 space-y-2">
        <div className="text-xs text-zinc-400 flex items-center gap-1.5">
          <Plus size={13} /> {t('instancesTab.addTitle')}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder={t('instancesTab.idPlaceholder')}
            spellCheck={false}
            className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-600"
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('instancesTab.labelPlaceholder')}
            className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
          />
        </div>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://remote-instance.example.com"
          spellCheck={false}
          className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-600"
        />
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          placeholder={t('instancesTab.tokenPlaceholder')}
          spellCheck={false}
          className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-600"
        />
        {id && <div className="text-[11px] text-zinc-600 font-mono">id: {slugify(id)}</div>}
        {error && <div className="text-[11px] text-red-400">{error}</div>}
        <div className="flex justify-end">
          <button
            onClick={() => createMut.mutate()}
            disabled={!canAdd || createMut.isPending}
            className="text-xs bg-emerald-900/50 text-emerald-200 px-4 py-2 rounded disabled:opacity-40 hover:bg-emerald-900/70"
          >
            {createMut.isPending ? t('common.saving') : t('common.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function InstanceRow({ inst, onToggle, onDelete }: {
  inst: InstancePublic;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const healthMut = useMutation({
    mutationFn: () => api.checkInstanceHealth(inst.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instances'] })
  });

  const dot = healthMut.isPending
    ? 'bg-zinc-600 animate-pulse'
    : inst.health == null
    ? 'bg-zinc-700'
    : inst.health.ok
    ? 'bg-emerald-400'
    : 'bg-red-400';

  return (
    <div className={`flex items-center gap-3 bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2.5 ${!inst.enabled ? 'opacity-50' : ''}`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} title={inst.health?.error ?? undefined} />
      <Globe2 size={14} className="text-zinc-500 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-200 truncate">
          {inst.label}
          {!inst.enabled && <span className="ml-2 text-[10px] text-zinc-500 align-middle">{t('instancesTab.disabled')}</span>}
        </div>
        <div className="text-[11px] text-zinc-600 font-mono truncate">{inst.baseUrl}</div>
      </div>
      <div className="text-[11px] text-zinc-500 shrink-0 text-right leading-tight">
        <div>
          {healthMut.isPending
            ? t('instancesTab.checking')
            : inst.health
            ? inst.health.ok
              ? `${inst.health.latencyMs}ms`
              : <span className="text-red-400">{inst.health.error ?? t('instancesTab.unreachable')}</span>
            : '—'}
        </div>
        {inst.health?.version && <div className="font-mono text-zinc-600">v{inst.health.version}</div>}
      </div>
      <button
        onClick={() => healthMut.mutate()}
        disabled={healthMut.isPending}
        className="p-1.5 rounded text-zinc-500 hover:text-sky-300 hover:bg-zinc-800 shrink-0"
        title={t('instancesTab.checkHealth')}
      >
        <RefreshCw size={14} className={healthMut.isPending ? 'animate-spin' : ''} />
      </button>
      <button
        onClick={() => onToggle(!inst.enabled)}
        className={`text-[11px] px-2 py-1 rounded shrink-0 ${inst.enabled ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}`}
      >
        {inst.enabled ? t('instancesTab.disable') : t('instancesTab.enable')}
      </button>
      <button
        onClick={onDelete}
        className="p-1.5 rounded text-zinc-600 hover:text-red-300 hover:bg-zinc-800 shrink-0"
        title={t('common.delete')}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
