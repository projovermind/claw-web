import { useEffect, useRef, useState } from 'react';
import { useDelegationStore, type DelegationEntry } from '../../store/delegation-store';
import { api } from '../../lib/api';

const REMOVE_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 30_000;   // 30초마다 세션 상태 확인
const STUCK_THRESHOLD_MS = 3 * 60 * 1000; // updatedAt 무변화 3분 → stuck

function DelegationItem({ entry }: { entry: DelegationEntry }) {
  const fail = useDelegationStore((s) => s.fail);
  const isDone = entry.status === 'completed' || entry.status === 'failed';

  // 마지막으로 확인된 updatedAt + 그 시각의 실제 Date.now()
  const lastUpdatedAt = useRef<string | null>(null);
  const lastChangedAt = useRef<number>(Date.now());
  const [isStuck, setIsStuck] = useState(false);

  useEffect(() => {
    if (isDone) {
      setIsStuck(false);
      return;
    }

    const check = async () => {
      try {
        const session = await api.session(entry.targetSessionId);

        // 세션이 더 이상 실행 중이 아니면 stuck 해제
        if (!session.isRunning) {
          setIsStuck(false);
          return;
        }

        // updatedAt이 바뀌면 활동 중 → 타이머 리셋
        if (session.updatedAt !== lastUpdatedAt.current) {
          lastUpdatedAt.current = session.updatedAt ?? null;
          lastChangedAt.current = Date.now();
          setIsStuck(false);
        } else {
          // updatedAt 무변화 — 경과 시간 체크
          const silentMs = Date.now() - lastChangedAt.current;
          setIsStuck(silentMs > STUCK_THRESHOLD_MS);
        }
      } catch {
        // 세션 조회 실패 시 무시
      }
    };

    check(); // 즉시 1회
    const t = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [isDone, entry.targetSessionId]);

  const handleAbort = async () => {
    if (!confirm(`'${entry.targetAgentId}' 위임을 중단할까요?`)) return;
    try { await api.abortChat(entry.targetSessionId); } catch { /* 이미 종료 */ }
    fail(entry.id);
  };

  const handleResume = async () => {
    try { await api.abortChat(entry.targetSessionId); } catch { /* 이미 종료 */ }
    await api.sendMessage(entry.originSessionId, '이전 위임 결과를 바탕으로 다음 단계를 진행해주세요.', []);
    fail(entry.id);
  };

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium transition-all duration-300 ${
        isDone
          ? 'bg-zinc-800/60 text-zinc-500'
          : isStuck
          ? 'bg-amber-900/40 border border-amber-700/50 text-amber-200'
          : 'bg-zinc-800 text-zinc-200'
      }`}
    >
      {/* 상태 아이콘 */}
      {isDone ? (
        <span className={entry.status === 'failed' ? 'text-red-400' : 'text-emerald-400'}>
          {entry.status === 'failed' ? '✕' : '✓'}
        </span>
      ) : isStuck ? (
        <span className="text-amber-400">⚠</span>
      ) : (
        <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
      )}

      {/* 에이전트명 */}
      <span className={`font-semibold truncate max-w-[80px] ${isStuck ? 'text-amber-300' : 'text-blue-300'}`}>
        {entry.targetAgentId}
      </span>

      {/* 태스크 요약 */}
      <span className="text-zinc-400 truncate max-w-[160px]">
        {entry.task.slice(0, 40)}{entry.task.length > 40 ? '…' : ''}
      </span>

      {/* 뱃지 or stuck 버튼 */}
      {isDone ? (
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
            entry.status === 'failed'
              ? 'bg-red-900/60 text-red-400'
              : 'bg-emerald-900/60 text-emerald-400'
          }`}
        >
          {entry.status === 'failed' ? '실패' : '완료'}
        </span>
      ) : isStuck ? (
        <div className="pointer-events-auto flex items-center gap-1">
          <button
            onClick={handleResume}
            className="px-2 py-0.5 rounded text-[10px] font-bold bg-sky-800/60 hover:bg-sky-700/60 text-sky-200 whitespace-nowrap"
          >
            이어서 하기
          </button>
          <button
            onClick={handleAbort}
            className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-700/60 hover:bg-amber-600/60 text-amber-200 whitespace-nowrap"
          >
            중단
          </button>
        </div>
      ) : (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-blue-900/60 text-blue-300">
          진행 중
        </span>
      )}
    </div>
  );
}

export default function DelegationStatusBar() {
  const delegations = useDelegationStore((s) => s.delegations);
  const removeRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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
      for (const [id, t] of timers) {
        if (!delegations.find((d) => d.id === id)) {
          clearTimeout(t);
          timers.delete(id);
        }
      }
    };
  }, [delegations]);

  if (delegations.length === 0) return null;

  const active = delegations.filter(d => d.status !== 'completed' && d.status !== 'failed');
  const primary = active[0] ?? delegations[0];
  const mobileExtra = delegations.length - 1;

  return (
    <div className="absolute top-3 right-3 z-20 flex flex-wrap gap-2 justify-end max-w-[60%] pointer-events-none">
      <div className="flex items-center gap-2 lg:hidden">
        <DelegationItem entry={primary} />
        {mobileExtra > 0 && (
          <span className="px-2 py-1 rounded-full text-[10px] font-bold bg-zinc-800 text-zinc-400">
            외 {mobileExtra}건
          </span>
        )}
      </div>
      <div className="hidden lg:flex flex-wrap gap-2 justify-end">
        {delegations.map((entry) => (
          <DelegationItem key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
