import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Folder, FolderOpen, FolderPlus, ChevronLeft, Home, Check, X, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';

/**
 * Folder picker modal scoped to the server's allowedRoots.
 *
 * Flow:
 *  1. User clicks a folder button; modal opens.
 *  2. We GET /api/fs/roots to list the allowedRoots as starting points.
 *  3. User clicks one; we GET /api/fs/ls?path=<root> to see its subdirs.
 *  4. User drills in (or goes back to parent) until they land on the target.
 *  5. Clicking "이 폴더 선택" calls onSelect(currentPath) and closes the modal.
 *
 * The picker only shows directories. It's sandboxed to allowedRoots at the
 * server level — any path outside those returns 403.
 */
export default function PathPicker({
  open,
  initialPath,
  onSelect,
  onClose
}: {
  open: boolean;
  initialPath?: string;
  onSelect: (absPath: string) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // New-folder inline prompt state
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const rootsQ = useQuery({
    queryKey: ['fs-roots'],
    queryFn: api.fsRoots,
    enabled: open
  });

  const lsQ = useQuery({
    queryKey: ['fs-ls', currentPath],
    queryFn: () => api.fsLs(currentPath!),
    enabled: open && !!currentPath
  });

  const mkdir = useMutation({
    mutationFn: ({ parent, name }: { parent: string; name: string }) =>
      api.fsMkdir(parent, name),
    onSuccess: (created) => {
      // Refresh the current listing so the new folder shows up, and
      // auto-navigate into it so the user can immediately pick it.
      qc.invalidateQueries({ queryKey: ['fs-ls', currentPath] });
      setNewFolderMode(false);
      setNewFolderName('');
      setError(null);
      setCurrentPath(created.path);
    },
    onError: (err: Error) => {
      setError(err.message);
    }
  });

  // Reset on open
  useEffect(() => {
    if (open) {
      setError(null);
      setNewFolderMode(false);
      setNewFolderName('');
      setCurrentPath(initialPath ?? null);
    }
  }, [open, initialPath]);

  // Translate fetch errors into UI error state
  useEffect(() => {
    if (lsQ.error) setError((lsQ.error as Error).message);
    else setError(null);
  }, [lsQ.error]);

  if (!open) return null;

  const roots = rootsQ.data?.roots ?? [];
  const entries = lsQ.data?.entries ?? [];
  const parent = lsQ.data?.parent ?? null;

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[70] p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <FolderOpen size={16} className="text-amber-400" />
            <h3 className="text-base font-semibold">폴더 선택</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X size={16} />
          </button>
        </div>

        {/* Current path breadcrumb */}
        <div className="px-5 py-2 border-b border-zinc-800 flex items-center gap-2 text-[11px]">
          <button
            onClick={() => setCurrentPath(null)}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 shrink-0"
            title="루트로"
          >
            <Home size={12} />
          </button>
          {parent && (
            <button
              onClick={() => setCurrentPath(parent)}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400 shrink-0"
              title="상위 폴더"
            >
              <ChevronLeft size={12} />
            </button>
          )}
          <code className="flex-1 truncate text-zinc-400 font-mono">
            {currentPath ?? '(루트 선택)'}
          </code>
          {/* New folder: only enabled when we're inside a directory (not at the
              root-list step). Toggling opens an inline input row below. */}
          {currentPath && (
            <button
              onClick={() => {
                setNewFolderMode(true);
                setNewFolderName('');
                setError(null);
              }}
              disabled={newFolderMode}
              className="p-1 rounded hover:bg-zinc-800 text-emerald-400 disabled:opacity-40 shrink-0"
              title="새 폴더"
            >
              <FolderPlus size={12} />
            </button>
          )}
        </div>

        {/* New folder inline input — shown when newFolderMode */}
        {newFolderMode && currentPath && (
          <div className="px-5 py-2 border-b border-zinc-800 flex items-center gap-2 bg-emerald-900/10">
            <FolderPlus size={12} className="text-emerald-400 shrink-0" />
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newFolderName.trim()) {
                  mkdir.mutate({ parent: currentPath, name: newFolderName.trim() });
                } else if (e.key === 'Escape') {
                  setNewFolderMode(false);
                  setNewFolderName('');
                }
              }}
              placeholder="새 폴더 이름"
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs focus:outline-none focus:border-emerald-700"
            />
            <button
              disabled={!newFolderName.trim() || mkdir.isPending}
              onClick={() => mkdir.mutate({ parent: currentPath, name: newFolderName.trim() })}
              className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-2.5 py-1 text-[11px] text-white"
            >
              {mkdir.isPending ? '생성 중…' : '생성'}
            </button>
            <button
              onClick={() => {
                setNewFolderMode(false);
                setNewFolderName('');
              }}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-400"
              title="취소"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mx-5 mt-2 p-2 rounded border border-red-900/60 bg-red-900/20 flex items-start gap-2 text-[11px] text-red-200">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Entry list */}
        <div className="flex-1 overflow-y-auto px-3 py-2 min-h-[240px]">
          {!currentPath ? (
            roots.length === 0 ? (
              <div className="text-sm text-zinc-500 italic p-4 text-center">
                {rootsQ.isLoading ? '로딩 중…' : 'allowedRoots가 비어있음'}
              </div>
            ) : (
              roots.map((r) => (
                <button
                  key={r.path}
                  onClick={() => setCurrentPath(r.path)}
                  className="w-full text-left flex items-center gap-2 px-3 py-2 rounded hover:bg-zinc-800/60 text-sm"
                >
                  <Home size={14} className="text-amber-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{r.name}</div>
                    <div className="text-[11px] text-zinc-600 font-mono truncate">{r.path}</div>
                  </div>
                </button>
              ))
            )
          ) : lsQ.isLoading ? (
            <div className="text-sm text-zinc-500 italic p-4 text-center">로딩 중…</div>
          ) : entries.length === 0 ? (
            <div className="text-sm text-zinc-600 italic p-4 text-center">
              빈 폴더 (하위 디렉터리 없음)
            </div>
          ) : (
            entries.map((e) => (
              <button
                key={e.path}
                onClick={() => setCurrentPath(e.path)}
                className="w-full text-left flex items-center gap-2 px-3 py-1.5 rounded hover:bg-zinc-800/60 text-sm"
              >
                <Folder size={14} className="text-sky-400 shrink-0" />
                <span className="flex-1 truncate">{e.name}</span>
              </button>
            ))
          )}
        </div>

        {/* Footer: select button */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-zinc-800">
          <p className="text-[11px] text-zinc-600 flex-1">
            💡 표시되는 경로는 서버의 <code>allowedRoots</code> 안으로 한정됨.
          </p>
          <button
            disabled={!currentPath}
            onClick={() => {
              if (currentPath) {
                onSelect(currentPath);
                onClose();
              }
            }}
            className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 text-sm flex items-center gap-1.5"
          >
            <Check size={12} /> 이 폴더 선택
          </button>
        </div>
      </div>
    </div>
  );
}
