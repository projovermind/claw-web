import { useEffect, useRef } from 'react';
import { useDelegationStore, type DelegationEntry } from '../../store/delegation-store';

const REMOVE_DELAY_MS = 3000;

function DelegationItem({ entry }: { entry: DelegationEntry }) {
  const isDone = entry.status === 'completed' || entry.status === 'failed';

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium transition-all duration-300 ${
        isDone
          ? 'bg-zinc-800/60 text-zinc-500'
          : 'bg-zinc-800 text-zinc-200'
      }`}
    >
      {/* spinner or check */}
      {isDone ? (
        <span className={entry.status === 'failed' ? 'text-red-400' : 'text-emerald-400'}>
          {entry.status === 'failed' ? '✕' : '✓'}
        </span>
      ) : (
        <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
      )}

      {/* agent name */}
      <span className="font-semibold text-blue-300 truncate max-w-[80px]">
        {entry.targetAgentId}
      </span>

      {/* task summary */}
      <span className="text-zinc-400 truncate max-w-[160px]">
        {entry.task.slice(0, 40)}
        {entry.task.length > 40 ? '…' : ''}
      </span>

      {/* badge */}
      <span
        className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
          isDone
            ? entry.status === 'failed'
              ? 'bg-red-900/60 text-red-400'
              : 'bg-emerald-900/60 text-emerald-400'
            : 'bg-blue-900/60 text-blue-300'
        }`}
      >
        {isDone ? (entry.status === 'failed' ? '실패' : '완료') : '진행 중'}
      </span>
    </div>
  );
}

export default function DelegationStatusBar() {
  const delegations = useDelegationStore((s) => s.delegations);
  const removeRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Auto-remove completed/failed entries after a delay
  useEffect(() => {
    const timers = removeRef.current;
    for (const d of delegations) {
      if ((d.status === 'completed' || d.status === 'failed') && !timers.has(d.id)) {
        const t = setTimeout(() => {
          useDelegationStore.setState((s) => ({
            delegations: s.delegations.filter((x) => x.id !== d.id)
          }));
          timers.delete(d.id);
        }, REMOVE_DELAY_MS);
        timers.set(d.id, t);
      }
    }
    return () => {
      // cleanup timers for entries that no longer exist
      for (const [id, t] of timers) {
        if (!delegations.find((d) => d.id === id)) {
          clearTimeout(t);
          timers.delete(id);
        }
      }
    };
  }, [delegations]);

  if (delegations.length === 0) return null;

  return (
    <div className="absolute top-3 right-3 z-20 flex flex-wrap gap-2 justify-end max-w-[60%] pointer-events-none">
      {delegations.map((entry) => (
        <DelegationItem key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
