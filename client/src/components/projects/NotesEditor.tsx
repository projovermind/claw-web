import { useState } from 'react';
import { FileText, Edit3, Check } from 'lucide-react';
import { useT } from '../../lib/i18n';

export function NotesEditor({
  notes,
  onSave
}: {
  notes: string;
  onSave: (notes: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes);

  const save = () => {
    onSave(draft);
    setEditing(false);
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800">
        <FileText size={14} className="text-zinc-500" />
        <span className="text-sm font-semibold text-zinc-300 flex-1">{t('projects.notes')}</span>
        <button
          onClick={() => {
            if (editing) save();
            else { setDraft(notes); setEditing(true); }
          }}
          className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 flex items-center gap-1"
        >
          {editing ? <><Check size={10} /> {t('common.save')}</> : <><Edit3 size={10} /> {t('common.edit')}</>}
        </button>
      </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
          placeholder={t('projects.notesPlaceholder')}
          className="w-full bg-transparent text-sm text-zinc-300 p-4 min-h-[120px] resize-y outline-none placeholder-zinc-600"
          autoFocus
        />
      ) : (
        <div className="p-4 text-sm text-zinc-400 whitespace-pre-wrap min-h-[60px]">
          {notes || <span className="italic text-zinc-600">{t('projects.notesEmpty')}</span>}
        </div>
      )}
    </div>
  );
}
