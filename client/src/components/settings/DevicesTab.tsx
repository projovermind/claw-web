import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ExternalLink, MonitorSmartphone } from 'lucide-react';
import { api } from '../../lib/api';
import type { Device } from '../../lib/types';

const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

export function DevicesTab() {
  const qc = useQueryClient();
  const { data: devices, isLoading } = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const { data: selfHealth } = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 });

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

  const orderMut = useMutation({
    mutationFn: ({ id, order }: { id: string; order: number }) => api.patchDevice(id, { order }),
    onSuccess: invalidate,
    onError: (e: Error) => setError(e.message)
  });

  // 순번은 사이드바 Alt+숫자 단축키와 같은 값 — 새 기기는 맨 뒤로 붙인다.
  const nextOrder = Math.max(0, ...(devices ?? []).map((d) => d.order ?? 0)) + 1;

  const id = slugify(name);
  const canAdd = !!id && /^https?:\/\//.test(url.trim());

  if (isLoading) return <div className="text-zinc-500 text-sm">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-[11px] text-zinc-500">
        다른 기계에서 돌고 있는 claw-web 을 등록합니다. 여기서 원격 조종하는 게 아니라,
        사이드바에서 그 기계의 claw-web 으로 건너뜁니다. 세션·프로젝트·설정은 기계마다 따로입니다.
        <br />
        왼쪽 숫자가 순번입니다 — 사이드바에서 <kbd className="text-zinc-400">Alt</kbd>+숫자로 바로 건너뜁니다.
        {selfHealth?.version && <> 오른쪽 버전이 <span className="text-amber-400">주황색</span>이면 이 기기(v{selfHealth.version})와 달라
        그쪽에서 <code className="text-zinc-400">self-update.sh</code> 가 아직 안 돈 것입니다.</>}
      </p>

      <div className="space-y-2">
        {(devices ?? []).map((d, i) => (
          <DeviceRow
            key={d.id}
            device={d}
            index={i}
            selfVersion={selfHealth?.version}
            onOrder={(order) => orderMut.mutate({ id: d.id, order })}
            onDelete={() => {
              if (confirm(`${d.name} 을(를) 목록에서 지울까요?`)) deleteMut.mutate(d.id);
            }}
          />
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
            onClick={() => createMut.mutate({ id, name: name.trim(), url: url.trim(), order: nextOrder, ...(note.trim() ? { note: note.trim() } : {}) })}
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

function DeviceRow({ device, index, selfVersion, onOrder, onDelete }: {
  device: Device;
  index: number;
  selfVersion?: string;
  onOrder: (order: number) => void;
  onDelete: () => void;
}) {
  const { data: ping, isLoading } = useQuery({
    queryKey: ['device-ping', device.id],
    queryFn: () => api.pingDevice(device.id),
    refetchInterval: 30_000
  });
  const isSelf = typeof window !== 'undefined' && (() => {
    try { return new URL(device.url).origin === window.location.origin; } catch { return false; }
  })();

  const dot = isLoading ? 'bg-zinc-600' : ping?.online ? 'bg-emerald-400' : 'bg-red-400';

  // 원격이 보고하는 version 은 그 프로세스가 뜰 때 읽은 값이다 — 디스크가 최신이어도
  // 재시작 전이면 옛 값이 온다. 어긋나면 그쪽에서 self-update.sh 가 돌아야 한다는 신호.
  const remoteVersion = ping?.health?.version;
  const mismatched = !!remoteVersion && !!selfVersion && remoteVersion !== selfVersion;

  return (
    <div className="flex items-center gap-3 bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2.5">
      <OrderBox value={device.order ?? index + 1} onCommit={onOrder} />
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
      <div className="text-[11px] text-zinc-500 shrink-0 text-right leading-tight">
        <div>
          {isLoading ? '확인 중…'
            : ping?.online ? `${ping.latencyMs}ms`
            : <span className="text-red-400">{ping?.error ?? '응답 없음'}</span>}
        </div>
        {remoteVersion && (
          <div
            className={`font-mono ${mismatched ? 'text-amber-400' : 'text-zinc-600'}`}
            title={mismatched ? `이 기기는 v${selfVersion} — 버전이 다릅니다` : undefined}
          >
            v{remoteVersion}{mismatched && ' ≠'}
          </div>
        )}
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

/** 순번 입력. 서버가 order 로 정렬하므로 값만 바꾸면 목록·단축키 순서가 같이 따라온다. */
function OrderBox({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));

  // 다른 행을 고쳐 재정렬되면 서버 값으로 되돌린다
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n) || n === value) { setDraft(String(value)); return; }
    onCommit(n);
  };

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      title="순번 (사이드바 Alt+숫자)"
      className="w-7 shrink-0 bg-zinc-950 border border-zinc-800 rounded text-center text-[11px] font-mono
                 text-zinc-400 py-1 focus:outline-none focus:border-zinc-600 focus:text-zinc-200"
    />
  );
}
