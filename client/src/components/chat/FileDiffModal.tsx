import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, FileText, Plus, Minus, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api';
import { useChatStore } from '../../store/chat-store';
import { editorUrl, useEditorConfig, FILE_DIFF_EVENT } from '../../lib/editor';
import { computeLineDiff, collectFileEdits } from '../../lib/diff';
import type { FileEditEvent, DiffLine } from '../../lib/diff';
import type { Session } from '../../lib/types';

interface Props {
  filePath: string;
  onClose: () => void;
}

/**
 * 파일 단위 누적 diff 모달.
 * 현재 세션의 messages 를 스캔해서 해당 파일에 대한 모든 Edit/Write 를 시간순으로 표시.
 * 각 이벤트는 줄 단위 diff 로 렌더 (빨강 - / 초록 +).
 */
export default function FileDiffModal({ filePath, onClose }: Props) {
  const sessionId = useChatStore((s) => s.currentSessionId);
  const sessionQ = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.session(sessionId!),
    enabled: !!sessionId
  });
  const cfg = useEditorConfig();
  const openUrl = editorUrl(filePath, cfg);

  const events = useMemo(() => {
    const s = sessionQ.data as Session | undefined;
    return collectFileEdits(s?.messages ?? [], filePath);
  }, [sessionQ.data, filePath]);

  const totalAdd = events.reduce(
    (n, e) => n + computeLineDiff(e.oldStr, e.newStr).filter((l) => l.kind === 'add').length,
    0
  );
  const totalDel = events.reduce(
    (n, e) => n + computeLineDiff(e.oldStr, e.newStr).filter((l) => l.kind === 'del').length,
    0
  );

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-5xl max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800">
          <FileText size={16} className="text-zinc-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-mono text-sm text-zinc-200 truncate">{filePath}</div>
            <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-2">
              <span>{events.length}개 수정</span>
              {totalAdd > 0 && <span className="text-emerald-400">+{totalAdd}</span>}
              {totalDel > 0 && <span className="text-red-400">−{totalDel}</span>}
            </div>
          </div>
          {openUrl && (
            <a
              href={openUrl}
              className="shrink-0 text-sky-400 hover:text-sky-300 flex items-center gap-1 text-xs px-2 py-1 rounded border border-sky-900/60 hover:border-sky-700"
              title={`Open in ${cfg.scheme}`}
            >
              <ExternalLink size={12} /> 에디터에서 열기
            </a>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body — scrollable timeline */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {sessionQ.isLoading && (
            <div className="text-zinc-500 text-sm text-center py-10">로딩 중...</div>
          )}
          {!sessionQ.isLoading && events.length === 0 && (
            <div className="text-zinc-500 text-sm text-center py-10">
              이 세션에 해당 파일에 대한 수정 기록이 없습니다.
            </div>
          )}
          {events.map((ev, i) => (
            <EditEventBlock key={`${ev.msgIndex}-${i}`} event={ev} index={i + 1} />
          ))}
        </div>
      </div>
    </div>
  );
}

function EditEventBlock({ event, index }: { event: FileEditEvent; index: number }) {
  const diff = useMemo(() => computeLineDiff(event.oldStr, event.newStr), [event]);
  const addCount = diff.filter((l) => l.kind === 'add').length;
  const delCount = diff.filter((l) => l.kind === 'del').length;
  const ts = event.ts ? new Date(event.ts).toLocaleTimeString('ko-KR', { hour12: false }) : '';

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      {/* Event header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/60 border-b border-zinc-800 text-xs">
        <span className="font-mono text-zinc-500">#{index}</span>
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold ${
            event.tool === 'Write'
              ? 'bg-blue-900/40 text-blue-300'
              : 'bg-amber-900/40 text-amber-300'
          }`}
        >
          {event.tool === 'Write' ? '전체 덮어쓰기' : '부분 수정'}
        </span>
        <div className="flex-1" />
        {addCount > 0 && (
          <span className="text-emerald-400 flex items-center gap-0.5">
            <Plus size={10} />
            {addCount}
          </span>
        )}
        {delCount > 0 && (
          <span className="text-red-400 flex items-center gap-0.5">
            <Minus size={10} />
            {delCount}
          </span>
        )}
        {ts && <span className="font-mono text-zinc-600">{ts}</span>}
      </div>

      {/* Diff body */}
      <DiffBody lines={diff} />
    </div>
  );
}

function DiffBody({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="text-[11.5px] font-mono overflow-x-auto">
      {lines.map((l, i) => (
        <DiffRow key={i} line={l} />
      ))}
    </div>
  );
}

/**
 * 앱 루트에 1회 마운트되는 전역 호스트.
 * `openFileDiff(path)` → window event → 이 호스트가 받아 모달 오픈.
 */
export function FileDiffHost() {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ filePath: string }>).detail;
      if (detail?.filePath) setPath(detail.filePath);
    };
    window.addEventListener(FILE_DIFF_EVENT, onOpen);
    return () => window.removeEventListener(FILE_DIFF_EVENT, onOpen);
  }, []);
  // ESC to close
  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPath(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [path]);
  if (!path) return null;
  return <FileDiffModal filePath={path} onClose={() => setPath(null)} />;
}

function DiffRow({ line }: { line: DiffLine }) {
  const bg =
    line.kind === 'add'
      ? 'bg-emerald-950/40'
      : line.kind === 'del'
        ? 'bg-red-950/40'
        : 'bg-transparent';
  const prefixColor =
    line.kind === 'add'
      ? 'text-emerald-500'
      : line.kind === 'del'
        ? 'text-red-500'
        : 'text-zinc-600';
  const textColor =
    line.kind === 'add'
      ? 'text-emerald-200'
      : line.kind === 'del'
        ? 'text-red-200'
        : 'text-zinc-400';
  const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  return (
    <div className={`flex ${bg}`}>
      <span className={`shrink-0 w-6 text-center ${prefixColor} select-none`}>{prefix}</span>
      <pre className={`flex-1 whitespace-pre-wrap break-all px-1 py-0.5 ${textColor}`}>
        {line.text || '\u00a0'}
      </pre>
    </div>
  );
}
