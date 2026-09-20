import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDelegationStore, type DelegationEntry } from '../../store/delegation-store';
import { api } from '../../lib/api';

const REMOVE_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 30_000;   // 30초마다 세션 상태 확인
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 활동 신호 무변화 10분 → stuck

const isDoneEntry = (d: DelegationEntry) => d.status === 'completed' || d.status === 'failed';

/**
 * 위임 목록 수명 관리 — 새로고침 시 서버 복원 + 완료 3초 후 제거.
 * 앱에서 한 번만 호출할 것 (ChatPage).
 */
export function useDelegationLifecycle() {
  const delegations = useDelegationStore((s) => s.delegations);
  const hydrate = useDelegationStore((s) => s.hydrate);
  const removeRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 새로고침 시 서버에서 active 위임 목록 복원
  useEffect(() => {
    api.delegations().then(hydrate).catch(() => {/* 무시 */});
  }, [hydrate]);

  useEffect(() => {
    const timers = removeRef.current;
    for (const d of delegations) {
      if (isDoneEntry(d) && !timers.has(d.id)) {
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
}

/**
 * 진행 중인 위임들의 활동 신호를 폴링해 stuck 여부를 판정한다.
 * 팝오버가 닫혀 있어도 계속 돌아야 하므로 목록이 아니라 인디케이터에서 관리한다.
 */
function useStuckWatcher(delegations: DelegationEntry[]) {
  const [stuckIds, setStuckIds] = useState<Set<string>>(() => new Set());
  // id → { 마지막 활동 신호, 그 신호를 처음 본 시각 }
  const signals = useRef<Map<string, { signal: string | null; changedAt: number }>>(new Map());
  const listRef = useRef(delegations);
  listRef.current = delegations;

  const activeKey = delegations
    .filter((d) => !isDoneEntry(d))
    .map((d) => `${d.id}:${d.targetSessionId}`)
    .join(',');

  useEffect(() => {
    if (!activeKey) {
      signals.current.clear();
      setStuckIds(new Set());
      return;
    }

    const check = async () => {
      const entries = listRef.current.filter((d) => !isDoneEntry(d));
      const alive = new Set(entries.map((e) => e.id));
      for (const id of signals.current.keys()) {
        if (!alive.has(id)) signals.current.delete(id);
      }

      const next = new Set<string>();
      await Promise.all(entries.map(async (entry) => {
        try {
          const session = await api.session(entry.targetSessionId);

          // 세션이 더 이상 실행 중이 아니면 stuck 해제
          if (!session.isRunning) {
            signals.current.delete(entry.id);
            return;
          }

          // 툴 실행만 하는 긴 턴은 updatedAt이 멈추므로 러너 하트비트를 우선 사용
          const signal = session.lastActivityAt ?? session.updatedAt ?? null;
          const prev = signals.current.get(entry.id);
          if (!prev || prev.signal !== signal) {
            signals.current.set(entry.id, { signal, changedAt: Date.now() });
          } else if (Date.now() - prev.changedAt > STUCK_THRESHOLD_MS) {
            // 활동 신호 무변화 — 경과 시간 초과
            next.add(entry.id);
          }
        } catch {
          // 세션 조회 실패 시 무시
        }
      }));
      setStuckIds(next);
    };

    check(); // 즉시 1회
    const t = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [activeKey]);

  return stuckIds;
}

/** 1분 단위로 리렌더를 트리거해 "경과 M분" 표시를 살아있게 유지한다. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function DelegationItem({ entry, isStuck, onOpen }: {
  entry: DelegationEntry;
  isStuck: boolean;
  onOpen: () => void;
}) {
  const fail = useDelegationStore((s) => s.fail);
  const navigate = useNavigate();
  const isDone = isDoneEntry(entry);

  // 보고는 서버 abortChat 이 플래너에게 자동 전송한다
  const handleStop = async (e: ReactMouseEvent) => {
    e.stopPropagation(); // 행 클릭(세션 이동) 과 겹치지 않게
    if (!confirm(`'${entry.targetAgentId}' 워커를 중단하고 지금까지의 결과를 플래너에게 보고할까요?`)) return;
    try { await api.abortChat(entry.targetSessionId); } catch { /* 이미 종료 */ }
    fail(entry.id);
  };

  // 워커 세션을 활성 페인에 띄운다 — ChatPage 의 ?agent=&session= 처리 경로를 그대로 탄다.
  const handleOpen = () => {
    navigate(
      `/chat?agent=${encodeURIComponent(entry.targetAgentId)}&session=${encodeURIComponent(entry.targetSessionId)}`
    );
    onOpen();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpen(); } }}
      title={`${entry.targetAgentId} 세션 열기`}
      className={`flex items-center gap-2 px-3 py-2 text-xs font-medium cursor-pointer transition-colors duration-300 ${
        isDone
          ? 'text-zinc-500 hover:bg-zinc-800/60'
          : isStuck
          ? 'bg-amber-900/30 text-amber-200 hover:bg-amber-900/50'
          : 'text-zinc-200 hover:bg-zinc-800/60'
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
        <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
      )}

      {/* 에이전트명 */}
      <span className={`font-semibold truncate max-w-[100px] ${isStuck ? 'text-amber-300' : 'text-blue-300'}`}>
        {entry.targetAgentId}
      </span>

      {/* 태스크 요약 */}
      <span className="text-zinc-400 truncate flex-1 min-w-0">
        {entry.task.slice(0, 60)}{entry.task.length > 60 ? '…' : ''}
      </span>

      {/* 뱃지 or stuck 버튼 */}
      {isDone ? (
        <span
          className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
            entry.status === 'failed'
              ? 'bg-red-900/60 text-red-400'
              : 'bg-emerald-900/60 text-emerald-400'
          }`}
        >
          {entry.status === 'failed' ? '실패' : '완료'}
        </span>
      ) : isStuck ? (
        <button
          onClick={handleStop}
          className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-700/60 hover:bg-amber-600/60 text-amber-200 whitespace-nowrap"
        >
          중단
        </button>
      ) : (
        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-blue-900/60 text-blue-300">
          진행 중
        </span>
      )}
    </div>
  );
}

/**
 * 위임 항목 목록 팝오버 본문 — 인디케이터/세션 스트립이 공유한다.
 */
function DelegationPopoverList({ delegations, stuckIds, onOpen }: {
  delegations: DelegationEntry[];
  stuckIds: Set<string>;
  onOpen: () => void;
}) {
  const activeCount = delegations.filter((d) => !isDoneEntry(d)).length;
  return (
    <>
      <div className="px-3 py-1.5 text-[11px] text-zinc-500 sticky top-0 bg-zinc-900">
        위임 {delegations.length}건 · 진행 중 {activeCount}건
      </div>
      {delegations.map((entry) => (
        <DelegationItem
          key={entry.id}
          entry={entry}
          isStuck={stuckIds.has(entry.id)}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

/**
 * 파란 점멸등 + 건수 뱃지. 클릭하면 위임 목록 팝오버가 열린다.
 * 위임이 없으면 아무것도 그리지 않는다.
 */
export default function DelegationIndicator({ align = 'left' }: { align?: 'left' | 'right' }) {
  const delegations = useDelegationStore((s) => s.delegations);
  const stuckIds = useStuckWatcher(delegations);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const activeCount = useMemo(
    () => delegations.filter((d) => !isDoneEntry(d)).length,
    [delegations]
  );
  const hasStuck = stuckIds.size > 0;

  // 위임이 모두 사라지면 팝오버도 닫는다
  useEffect(() => {
    if (delegations.length === 0) setOpen(false);
  }, [delegations.length]);

  if (delegations.length === 0) return null;

  const allDone = activeCount === 0;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`위임 ${activeCount}건 진행 중${hasStuck ? ' — 응답 없는 워커 있음' : ''}`}
        className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] font-semibold transition-colors ${
          hasStuck
            ? 'bg-amber-900/40 border-amber-700/60 text-amber-200 hover:bg-amber-900/60'
            : allDone
            ? 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
            : 'bg-blue-950/50 border-blue-800/60 text-blue-200 hover:bg-blue-900/50'
        }`}
      >
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            hasStuck ? 'bg-amber-400 animate-pulse' : allDone ? 'bg-emerald-400' : 'bg-blue-400 animate-pulse'
          }`}
        />
        <span className="font-mono">{activeCount || delegations.length}</span>
      </button>

      {open && (
        <div
          className={`absolute top-full mt-1 z-50 w-[min(22rem,calc(100vw-1.5rem))] max-h-80 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl divide-y divide-zinc-800 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <DelegationPopoverList
            delegations={delegations}
            stuckIds={stuckIds}
            onOpen={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 입력창 바로 위 상시 상태 스트립 — 현재 세션이 원본인, 완료되지 않은 위임이 있을 때만 표시.
 * "위임 진행 중 N건 · 대상에이전트명 · 경과 M분" 형태. 클릭하면 DelegationIndicator 와 동일한
 * 목록 팝오버가 (입력창을 가리지 않도록) 위쪽으로 열린다.
 */
export function DelegationSessionStrip({ sessionId }: { sessionId: string | null }) {
  const allDelegations = useDelegationStore((s) => s.delegations);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow();

  const sessionDelegations = useMemo(
    () => allDelegations.filter((d) => d.originSessionId === sessionId),
    [allDelegations, sessionId]
  );
  const active = useMemo(
    () => sessionDelegations.filter((d) => !isDoneEntry(d)),
    [sessionDelegations]
  );
  const stuckIds = useStuckWatcher(sessionDelegations);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (active.length === 0) setOpen(false);
  }, [active.length]);

  if (!sessionId || active.length === 0) return null;

  const hasStuck = active.some((d) => stuckIds.has(d.id));
  const agentNames = Array.from(new Set(active.map((d) => d.targetAgentId)));
  const agentLabel = agentNames.length === 1
    ? agentNames[0]
    : `${agentNames[0]} 외 ${agentNames.length - 1}`;
  const oldestStartedAt = Math.min(...active.map((d) => d.startedAt));
  const elapsedMin = Math.max(0, Math.floor((now - oldestStartedAt) / 60_000));

  return (
    <div ref={ref} className="relative shrink-0 border-t border-zinc-800">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`위임 ${active.length}건 진행 중${hasStuck ? ' — 응답 없는 워커 있음' : ''}`}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium transition-colors ${
          hasStuck
            ? 'bg-amber-900/30 text-amber-200 hover:bg-amber-900/50'
            : 'bg-blue-950/30 text-blue-200 hover:bg-blue-950/50'
        }`}
      >
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${hasStuck ? 'bg-amber-400 animate-pulse' : 'bg-blue-400 animate-pulse'}`}
        />
        <span>
          위임 진행 중 {active.length}건 · <span className="font-semibold">{agentLabel}</span> · 경과 {elapsedMin}분
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 z-50 max-h-80 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl divide-y divide-zinc-800">
          <DelegationPopoverList
            delegations={sessionDelegations}
            stuckIds={stuckIds}
            onOpen={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
