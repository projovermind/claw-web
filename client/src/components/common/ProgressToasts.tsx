import { X, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { useProgressToastStore, type ProgressTask } from '../../store/progress-toast-store';

const STYLES = `
@keyframes progress-slide {
  0% { transform: translateX(-100%); }
  50% { transform: translateX(150%); }
  100% { transform: translateX(-100%); }
}
@keyframes check-pop {
  0% { transform: scale(0.4); opacity: 0; }
  70% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes toast-enter {
  from { opacity: 0; transform: translateY(6px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0)   scale(1);    }
}
@keyframes toast-exit {
  from { opacity: 1; transform: translateY(0)   scale(1);    max-height: 80px; }
  to   { opacity: 0; transform: translateY(4px) scale(0.97); max-height: 0;    }
}
.progress-indeterminate {
  animation: progress-slide 1.4s ease-in-out infinite;
}
.check-pop-in {
  animation: check-pop 0.2s ease-out forwards;
}
.toast-enter {
  animation: toast-enter 0.18s ease-out forwards;
}
`;

function TaskToast({ task }: { task: ProgressTask }) {
  const { dismissTask } = useProgressToastStore();
  const isDone = task.status === 'complete';
  const isFailed = task.status === 'failed';
  const isActive = task.status === 'active';
  const hasDeterminate = typeof task.progress === 'number';
  const displayTitle = isFailed
    ? (task.failMessage || task.title)
    : (isDone && task.completeMessage)
      ? task.completeMessage
      : task.title;

  return (
    <div
      className={`
        w-64 rounded-lg border shadow-xl px-3 py-2.5 text-sm transition-colors duration-300 toast-enter
        ${isFailed ? 'border-red-800 bg-zinc-900' : isDone ? 'border-emerald-700 bg-zinc-900' : 'border-zinc-700 bg-zinc-900'}
      `}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {isDone ? (
            <CheckCircle2 size={14} className="text-emerald-400 shrink-0 check-pop-in" />
          ) : isFailed ? (
            <AlertCircle size={14} className="text-red-400 shrink-0" />
          ) : (
            <Loader2 size={14} className="animate-spin shrink-0 text-emerald-400" />
          )}
          <span className={`truncate text-[13px] font-medium ${isFailed ? 'text-red-300' : 'text-zinc-200'}`}>
            {displayTitle}
          </span>
        </div>
        <button
          onClick={() => dismissTask(task.id)}
          className="text-zinc-600 hover:text-zinc-300 shrink-0"
        >
          <X size={12} />
        </button>
      </div>

      {task.step && isActive && (
        <p className="mt-1 text-[11px] text-zinc-500 truncate pl-5">{task.step}</p>
      )}

      {isActive && (
        <div className="mt-2 h-1 rounded-full bg-zinc-800 overflow-hidden">
          {hasDeterminate ? (
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${task.progress}%` }}
            />
          ) : (
            <div className="h-full w-1/2 rounded-full bg-gradient-to-r from-transparent via-emerald-400 to-transparent progress-indeterminate" />
          )}
        </div>
      )}
    </div>
  );
}

function MinimizedBadge({ task }: { task: ProgressTask }) {
  const { dismissTask } = useProgressToastStore();
  const isDone = task.status === 'complete';

  return (
    <div
      className={`
        flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] border shadow-md cursor-default
        ${isDone ? 'border-emerald-700 bg-zinc-900 text-emerald-400' : 'border-zinc-700 bg-zinc-900 text-zinc-400'}
      `}
    >
      {isDone ? (
        <CheckCircle2 size={11} className="text-emerald-400 check-pop-in" />
      ) : task.status === 'failed' ? (
        <AlertCircle size={11} className="text-red-400" />
      ) : (
        <Loader2 size={11} className="animate-spin text-emerald-400" />
      )}
      <span className="max-w-[80px] truncate">{task.title}</span>
      <button onClick={() => dismissTask(task.id)} className="hover:text-zinc-200">
        <X size={10} />
      </button>
    </div>
  );
}

export default function ProgressToasts() {
  const tasks = useProgressToastStore((s) => s.tasks);

  const active = tasks.filter((t) => t.status === 'active' || t.status === 'complete' || t.status === 'failed');
  const minimized = tasks.filter((t) => t.status === 'minimized');

  return (
    <>
      <style>{STYLES}</style>

      {/* Minimized badges — top right */}
      {minimized.length > 0 && (
        <div className="fixed top-3 right-3 z-50 flex flex-col gap-1.5 items-end pointer-events-auto">
          {minimized.map((t) => (
            <MinimizedBadge key={t.id} task={t} />
          ))}
        </div>
      )}

      {/* Active toasts — bottom right */}
      {active.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end pointer-events-auto">
          {active.map((t) => (
            <TaskToast key={t.id} task={t} />
          ))}
        </div>
      )}
    </>
  );
}
