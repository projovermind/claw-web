import { Circle, Loader2, CheckCircle2, ListTodo } from 'lucide-react';
import type { TodoItem } from '../../store/chat-store';

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />;
  if (status === 'in_progress') return <Loader2 size={14} className="text-amber-400 animate-spin shrink-0" />;
  return <Circle size={14} className="text-zinc-600 shrink-0" />;
}

export default function TodoWidget({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2 text-xs">
      <div className="flex items-center gap-2 pb-1 border-b border-zinc-800">
        <ListTodo size={14} className="text-zinc-400" />
        <div className="font-semibold text-zinc-300">Progress</div>
        <div className="ml-auto text-[11px] text-zinc-500">
          {todos.filter((t) => t.status === 'completed').length}/{todos.length}
        </div>
      </div>
      <ul className="space-y-1.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2">
            <StatusIcon status={t.status} />
            <span
              className={`flex-1 ${
                t.status === 'completed'
                  ? 'text-zinc-500 line-through'
                  : t.status === 'in_progress'
                    ? 'text-amber-300'
                    : 'text-zinc-400'
              }`}
            >
              {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
