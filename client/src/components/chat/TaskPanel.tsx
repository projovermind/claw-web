import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Square, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { api } from '../../lib/api';

export default function TaskPanel() {
  const [open, setOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: api.listTasks,
    refetchInterval: 2000
  });

  const { data: detail } = useQuery({
    queryKey: ['task-detail', selectedId],
    queryFn: () => (selectedId ? api.getTask(selectedId) : Promise.resolve(null)),
    enabled: !!selectedId,
    refetchInterval: selectedId ? 2000 : false
  });

  const killMut = useMutation({
    mutationFn: (id: string) => api.killTask(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] })
  });

  if (tasks.length === 0) return null;

  const statusIcon = (s: string) => {
    if (s === 'running') return <Loader2 size={12} className="animate-spin text-sky-400" />;
    if (s === 'completed') return <CheckCircle size={12} className="text-emerald-400" />;
    return <XCircle size={12} className="text-red-400" />;
  };

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/60">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Background Tasks ({tasks.filter((t) => t.status === 'running').length} running)
      </button>

      {open && (
        <div className="px-3 pb-2 space-y-1 max-h-64 overflow-y-auto">
          {tasks.map((t) => (
            <div
              key={t.id}
              onClick={() => setSelectedId(selectedId === t.id ? null : t.id)}
              className={`flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer ${
                selectedId === t.id ? 'bg-zinc-800' : 'hover:bg-zinc-900'
              }`}
            >
              {statusIcon(t.status)}
              <span className="flex-1 font-mono truncate text-zinc-300">{t.command}</span>
              {t.status === 'running' && (
                <button
                  onClick={(e) => { e.stopPropagation(); killMut.mutate(t.id); }}
                  className="text-red-400 hover:text-red-300"
                  title="Kill"
                >
                  <Square size={10} />
                </button>
              )}
              {t.exitCode !== null && (
                <span className={`text-[11px] ${t.exitCode === 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  exit {t.exitCode}
                </span>
              )}
            </div>
          ))}

          {selectedId && detail && (
            <div className="mt-1 rounded border border-zinc-800 bg-zinc-900/80 p-2 max-h-48 overflow-y-auto">
              <pre className="text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all">
                {detail.stdout || '(no output)'}
              </pre>
              {detail.stderr && (
                <pre className="text-[11px] font-mono text-red-300 whitespace-pre-wrap break-all mt-1 border-t border-zinc-800 pt-1">
                  {detail.stderr}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
