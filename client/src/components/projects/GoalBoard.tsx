import { useState, useMemo } from 'react';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import type { GoalCard } from '../../lib/types';
import { useT } from '../../lib/i18n';

const COLUMNS: { key: GoalCard['status']; label: string; color: string; bg: string }[] = [
  { key: 'todo', label: 'Todo', color: 'border-zinc-700', bg: 'bg-zinc-700/20' },
  { key: 'progress', label: 'Progress', color: 'border-amber-800', bg: 'bg-amber-900/20' },
  { key: 'done', label: 'Done', color: 'border-emerald-800', bg: 'bg-emerald-900/20' },
];

export function GoalBoard({
  goals,
  onUpdate
}: {
  goals: GoalCard[];
  onUpdate: (goals: GoalCard[]) => void;
}) {
  const t = useT();
  const [adding, setAdding] = useState<GoalCard['status'] | null>(null);
  const [draft, setDraft] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);

  const addGoal = (status: GoalCard['status']) => {
    if (!draft.trim()) return;
    const card: GoalCard = {
      id: `goal_${Date.now().toString(36)}`,
      title: draft.trim(),
      status,
      createdAt: new Date().toISOString()
    };
    onUpdate([...goals, card]);
    setDraft('');
    setAdding(null);
  };

  const removeGoal = (id: string) => {
    onUpdate(goals.filter(g => g.id !== id));
  };

  const moveGoal = (id: string, newStatus: GoalCard['status']) => {
    onUpdate(goals.map(g => g.id === id ? { ...g, status: newStatus } : g));
  };

  // 진행률 계산
  const progress = useMemo(() => {
    if (goals.length === 0) return 0;
    const done = goals.filter(g => g.status === 'done').length;
    return Math.round((done / goals.length) * 100);
  }, [goals]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800">
        <span className="text-sm">🎯</span>
        <span className="text-sm font-semibold text-zinc-300">{t('projects.goals')}</span>
        {goals.length > 0 && (
          <div className="flex items-center gap-2 ml-2 flex-1">
            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden max-w-[120px]">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-[11px] text-zinc-500 font-mono">{progress}%</span>
          </div>
        )}
        <span className="text-[11px] text-zinc-600 ml-auto">{goals.length}</span>
      </div>
      <div className="grid grid-cols-3 gap-0 divide-x divide-zinc-800">
        {COLUMNS.map(col => {
          const items = goals.filter(g => g.status === col.key);
          return (
            <div
              key={col.key}
              className={`min-h-[120px] transition-colors ${dragId ? 'border-dashed' : ''}`}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add(col.bg); }}
              onDragLeave={(e) => e.currentTarget.classList.remove(col.bg)}
              onDrop={(e) => {
                e.currentTarget.classList.remove(col.bg);
                if (dragId) { moveGoal(dragId, col.key); setDragId(null); }
              }}
            >
              <div className={`px-3 py-1.5 text-[11px] uppercase tracking-wider text-zinc-500 border-b-2 ${col.color} flex items-center`}>
                <span className="flex-1">{col.label}</span>
                <span className="text-zinc-600 bg-zinc-800 px-1.5 rounded">{items.length}</span>
              </div>
              <div className="p-2 space-y-1.5">
                {items.map(g => (
                  <div
                    key={g.id}
                    draggable
                    onDragStart={() => setDragId(g.id)}
                    onDragEnd={() => setDragId(null)}
                    className={`group rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-xs cursor-grab active:cursor-grabbing ${
                      dragId === g.id ? 'opacity-40' : ''
                    }`}
                  >
                    <div className="flex items-start gap-1.5">
                      <GripVertical size={10} className="text-zinc-700 shrink-0 mt-0.5" />
                      <span className="flex-1 text-zinc-300">{g.title}</span>
                      <button
                        onClick={() => removeGoal(g.id)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-400 text-zinc-600"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                ))}
                {adding === col.key ? (
                  <div className="flex gap-1">
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addGoal(col.key);
                        if (e.key === 'Escape') { setAdding(null); setDraft(''); }
                      }}
                      placeholder={t('projects.goalInput')}
                      className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-[11px] outline-none focus:border-zinc-500"
                      autoFocus
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setAdding(col.key)}
                    className="w-full text-[11px] text-zinc-600 hover:text-zinc-400 py-1 flex items-center justify-center gap-1"
                  >
                    <Plus size={10} /> {t('common.add')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
