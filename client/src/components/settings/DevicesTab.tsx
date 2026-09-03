import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ExternalLink, MonitorSmartphone } from 'lucide-react';
import { api } from '../../lib/api';
import type { Device } from '../../lib/types';

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

export function DevicesTab() {
  const qc = useQueryClient();
  const { data: devices, isLoading } = useQuery({ queryKey: ['devices'], queryFn: api.devices });

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['devices'] });

  const createMut = useMutation({
    mutationFn: (d: Device) => api.createDevice(d),
    onSuccess: () => { setName(''); setUrl(''); setNote(''); setError(null); invalidate(); },
    onError: (e: Error) => setError(e.message)
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteDevice(id),
    onSuccess: invalidate
  });

  const id = slugify(name);
  const canAdd = !!id && /^https?:\/\//.test(url.trim());

  if (isLoading) return <div className="text-zinc-500 text-sm">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-[11px] text-zinc-500">
        다른 기계에서 돌고 있는 claw-web 을 등록합니다. 여기서 원격 조종하는 게 아니라,
        사이드바에서 그 기계의 claw-web 으로 건너뜁니다. 세션·프로젝트·설정은 기계마다 따로입니다.
      </p>

      <div className="space-y-2">
        {(devices ?? []).map((d) => (
          <DeviceRow key={d.id} device={d} onDelete={() => {
            if (confirm(`${d.name} 을(를) 목록에서 지울까요?`)) deleteMut.mutate(d.id);
          }} />
        ))}
        {(devices ?? []).length === 0 && (
          <div className="text-[11px] text-zinc-600 border border-dashed border-zinc-800 rounded px-3 py-4 text-center">
            등록된 기기가 없습니다.
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800 pt-4 space-y-2">
        <div className="text-xs text-zinc-400 flex items-center gap-1.5">
          <Plus size={13} /> 기기 추가
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="이름 (예: 맥스튜디오)"
            className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://studio.subinggrae.cc"
            spellCheck={false}
            className="bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-600"
          />
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="메모 (선택) — 예: M2 Max 64GB, 전사·판정 담당"
          className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
        />
        {id && <div className="text-[11px] text-zinc-600 font-mono">id: {id}</div>}
        {error && <div className="text-[11px] text-red-400">{error}</div>}
        <div className="flex justify-end">
          <button
            onClick={() => createMut.mutate({ id, name: name.trim(), url: url.trim(), ...(note.trim() ? { note: note.trim() } : {}) })}
            disabled={!canAdd || createMut.isPending}
            className="text-xs bg-emerald-900/50 text-emerald-200 px-4 py-2 rounded disabled:opacity-40 hover:bg-emerald-900/70"
          >
            {createMut.isPending ? '추가 중…' : '추가'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeviceRow({ device, onDelete }: { device: Device; onDelete: () => void }) {
  const { data: ping, isLoading } = useQuery({
    queryKey: ['device-ping', device.id],
    queryFn: () => api.pingDevice(device.id),
    refetchInterval: 30_000
  });
  const isSelf = typeof window !== 'undefined' && (() => {
    try { return new URL(device.url).origin === window.location.origin; } catch { return false; }
  })();

  const dot = isLoading ? 'bg-zinc-600' : ping?.online ? 'bg-emerald-400' : 'bg-red-400';

  return (
    <div className="flex items-center gap-3 bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2.5">
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      <MonitorSmartphone size={14} className="text-zinc-500 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-200 truncate">
          {device.name}
          {isSelf && <span className="ml-2 text-[10px] text-sky-400 align-middle">이 기기</span>}
        </div>
        <div className="text-[11px] text-zinc-600 font-mono truncate">{device.url}</div>
        {device.note && <div className="text-[11px] text-zinc-500 truncate">{device.note}</div>}
      </div>
      <div className="text-[11px] text-zinc-500 shrink-0 text-right">
        {isLoading ? '확인 중…'
          : ping?.online ? `${ping.latencyMs}ms`
          : <span className="text-red-400">{ping?.error ?? '응답 없음'}</span>}
      </div>
      {!isSelf && (
        <a
          href={device.url}
          className="p-1.5 rounded text-zinc-500 hover:text-sky-300 hover:bg-zinc-800 shrink-0"
          title="이 기기로 이동"
        >
          <ExternalLink size={14} />
        </a>
      )}
      <button
        onClick={onDelete}
        className="p-1.5 rounded text-zinc-600 hover:text-red-300 hover:bg-zinc-800 shrink-0"
        title="삭제"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
