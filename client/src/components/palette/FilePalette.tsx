import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, FolderOpen } from 'lucide-react';
import { api } from '../../lib/api';
import { useChatStore } from '../../store/chat-store';

/**
 * File-focused palette. Opens on Cmd/Ctrl-O. Lists project files matching
 * a fuzzy query, scoped to the current chat agent's workingDir. Selecting a
 * file copies its path or inserts it into ChatInput (just copies to clipboard
 * for now — Phase 2 will pipe into the input via a shared store).
 */
export default function FilePalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Current agent context for scoping the search root
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: api.agents,
    enabled: open
  });
  const workingDir = useMemo(() => {
    if (!currentAgentId || !agents) return null;
    const a = agents.find((ag) => ag.id === currentAgentId);
    return a?.workingDir ?? null;
  }, [currentAgentId, agents]);

  // Hotkey
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced file search
  const [results, setResults] = useState<{ name: string; path: string; rel: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !workingDir || !query.trim()) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.fsSearch(workingDir, query.trim(), 30);
        if (!controller.signal.aborted) {
          setResults(data.results);
          setCursor(0);
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
  }, [open, workingDir, query]);

  const copyPath = useCallback(
    (path: string) => {
      navigator.clipboard.writeText(path).catch(() => {});
      setOpen(false);
    },
    []
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[cursor];
      if (r) copyPath(r.path);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center z-[90] p-4 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-xl shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
          <FolderOpen size={16} className="text-sky-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={workingDir ? '파일 검색…' : '에이전트가 선택되지 않음 (채팅 탭에서 에이전트 선택 후)'}
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-zinc-600"
          />
          <kbd className="text-[11px] text-zinc-500 px-1.5 py-0.5 rounded border border-zinc-700 font-mono">
            ESC
          </kbd>
        </div>

        {workingDir && (
          <div className="px-4 py-1.5 text-[11px] text-zinc-600 font-mono truncate border-b border-zinc-800/50">
            📁 {workingDir}
          </div>
        )}

        <div className="max-h-[60vh] overflow-y-auto">
          {!query.trim() ? (
            <div className="py-8 text-center text-xs text-zinc-600 italic">
              파일 이름이나 경로 일부를 입력하세요
            </div>
          ) : loading && results.length === 0 ? (
            <div className="py-8 text-center text-xs text-zinc-600">검색 중…</div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-xs text-zinc-600 italic">결과 없음</div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.path}
                onClick={() => copyPath(r.path)}
                onMouseEnter={() => setCursor(i)}
                className={`w-full text-left flex items-center gap-3 px-4 py-2 ${
                  i === cursor ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40'
                }`}
              >
                <FileText size={14} className="text-sky-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-200 truncate">{r.name}</div>
                  <div className="text-[11px] text-zinc-500 font-mono truncate">{r.rel}</div>
                </div>
                {i === cursor && (
                  <span className="text-[11px] text-zinc-600 shrink-0">Enter: 경로 복사</span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-zinc-800 text-[11px] text-zinc-600">
          <span><kbd className="font-mono">↑↓</kbd> 이동</span>
          <span><kbd className="font-mono">Enter</kbd> 경로 복사</span>
          <span className="ml-auto"><kbd className="font-mono">⌘O</kbd> 열기/닫기</span>
        </div>
      </div>
    </div>
  );
}
