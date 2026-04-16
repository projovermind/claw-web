import { useEffect, useRef, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';

/**
 * Popover that appears when the user types `@` in the ChatInput.
 * Shows a fuzzy file search scoped to the current agent's workingDir.
 * Selecting a file inserts its absolute path at the cursor position.
 */
export default function AtFilePopover({
  query,
  workingDir,
  cursor,
  onSelect,
  onCursorChange,
  onClose: _onClose
}: {
  /** Text after `@`, e.g. "src/comp" */
  query: string;
  /** The root directory to search in (agent's workingDir). */
  workingDir: string | null;
  cursor: number;
  onSelect: (path: string) => void;
  onCursorChange: (idx: number) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [results, setResults] = useState<{ name: string; path: string; rel: string }[]>([]);
  const [loading, setLoading] = useState(false);

  // Debounced search
  useEffect(() => {
    if (!workingDir || !query.trim()) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.fsSearch(workingDir, query.trim(), 15);
        if (!controller.signal.aborted) {
          setResults(data.results);
          onCursorChange(0);
        }
      } catch {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, workingDir]);

  useEffect(() => {
    if (cursor >= results.length) onCursorChange(Math.max(0, results.length - 1));
  }, [results.length, cursor, onCursorChange]);

  useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!workingDir) {
    return (
      <div className="absolute left-0 bottom-full mb-1 w-80 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl z-20 p-3 text-xs text-zinc-500 italic">
        에이전트의 workingDir이 설정돼 있지 않아서 파일 검색 불가
      </div>
    );
  }

  if (loading && results.length === 0) {
    return (
      <div className="absolute left-0 bottom-full mb-1 w-80 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl z-20 p-3 text-xs text-zinc-500 flex items-center gap-2">
        <Loader2 size={12} className="animate-spin" /> 검색 중…
      </div>
    );
  }

  if (!query.trim()) {
    return (
      <div className="absolute left-0 bottom-full mb-1 w-80 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl z-20 p-3 text-xs text-zinc-500 italic">
        파일명을 입력하면 프로젝트 내 파일을 검색합니다
      </div>
    );
  }

  if (results.length === 0 && !loading) {
    return (
      <div className="absolute left-0 bottom-full mb-1 w-80 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl z-20 p-3 text-xs text-zinc-500 italic">
        결과 없음
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="absolute left-0 bottom-full mb-1 w-96 max-h-60 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl z-20"
    >
      {results.map((r, i) => (
        <button
          key={r.path}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(r.path);
          }}
          onMouseEnter={() => onCursorChange(i)}
          className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs ${
            i === cursor ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
          }`}
        >
          <FileText size={12} className="text-sky-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-zinc-200 truncate">{r.name}</div>
            <div className="text-[11px] text-zinc-500 font-mono truncate">{r.rel}</div>
          </div>
        </button>
      ))}
      {loading && (
        <div className="px-3 py-1 text-[11px] text-zinc-600 flex items-center gap-1">
          <Loader2 size={10} className="animate-spin" /> 업데이트 중…
        </div>
      )}
    </div>
  );
}
