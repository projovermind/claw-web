import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Brain, Save, FileText } from 'lucide-react';
import { api, ApiError } from '../../lib/api';

const INDEX_FILE = 'MEMORY.md';

function formatSize(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * ~/.claude/projects/<slug>/memory 를 읽고 쓴다 — Claude 가 세션 간 유지하는
 * 자동 메모리. 프로젝트에 workingDir 이 없으면 서버가 404 를 준다.
 */
export function ClaudeMemoryPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['claude-memory', projectId],
    queryFn: () => api.claudeMemory(projectId),
    retry: false
  });

  const [selected, setSelected] = useState(INDEX_FILE);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);

  // 목록을 새로 받으면 MEMORY.md 내용(index)을 편집기에 싣는다.
  useEffect(() => {
    if (!data) return;
    setSelected(INDEX_FILE);
    setDraft(data.index ?? '');
    setDirty(false);
  }, [data]);

  const fileQ = useMutation({
    mutationFn: (name: string) => api.claudeMemoryFile(projectId, name),
    onSuccess: (r, name) => {
      setSelected(name);
      setDraft(r.content);
      setDirty(false);
    }
  });

  const saveMut = useMutation({
    mutationFn: () => api.putClaudeMemoryFile(projectId, selected, draft),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['claude-memory', projectId] });
    }
  });

  if (isLoading) return <div className="text-sm text-zinc-500">불러오는 중...</div>;

  if (error) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-6 text-sm text-zinc-500">
        {notFound
          ? '이 프로젝트에는 작업 디렉토리(workingDir)가 없어 Claude 자동 메모리 경로를 찾을 수 없습니다. 프로젝트 편집에서 경로를 지정하세요.'
          : `메모리를 불러오지 못했습니다 — ${(error as Error).message}`}
      </div>
    );
  }

  const files = data?.files ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Brain size={14} className="text-violet-400" />
        <span className="text-sm font-semibold text-zinc-300">Claude 자동 메모리</span>
      </div>
      <div className="text-[11px] text-zinc-600 font-mono break-all">{data?.dir}</div>

      {files.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-6 text-sm text-zinc-500">
          저장된 메모리 파일이 없습니다. Claude 가 세션 중 기억할 만한 사실을 발견하면 이 폴더에 파일을 만듭니다.
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800">
          {files.map((f) => (
            <button
              key={f.name}
              onClick={() => fileQ.mutate(f.name)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800/50 ${
                selected === f.name ? 'bg-zinc-800/40' : ''
              }`}
            >
              <FileText size={12} className="text-zinc-500 shrink-0" />
              <span className="text-xs text-zinc-300 flex-1 truncate">{f.name}</span>
              <span className="text-[10px] text-zinc-600 font-mono shrink-0">{formatSize(f.size)}</span>
              <span className="text-[10px] text-zinc-600 font-mono shrink-0">
                {f.mtime ? new Date(f.mtime).toLocaleDateString() : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-mono">{selected}</span>
          <button
            onClick={() => saveMut.mutate()}
            disabled={!dirty || saveMut.isPending}
            className="flex items-center gap-1.5 text-xs bg-emerald-900/50 text-emerald-200 px-3 py-1.5 rounded disabled:opacity-40 hover:bg-emerald-900/70"
          >
            <Save size={12} />
            {saveMut.isPending ? '저장 중...' : '저장'}
          </button>
        </div>
        <textarea
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
          spellCheck={false}
          placeholder={`${INDEX_FILE} — 한 줄에 메모리 하나씩 (- [제목](file.md) — 요약)`}
          className="w-full h-64 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-600 resize-y"
        />
        {saveMut.isError && (
          <div className="text-[11px] text-red-400">{(saveMut.error as Error).message}</div>
        )}
      </div>
    </div>
  );
}
