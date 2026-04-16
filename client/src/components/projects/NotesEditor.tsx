import { useState } from 'react';
import { FileText, Edit3, Check } from 'lucide-react';

export function NotesEditor({
  notes,
  onSave
}: {
  notes: string;
  onSave: (notes: string) => void;
}) {
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
        <span className="text-sm font-semibold text-zinc-300 flex-1">메모</span>
        <button
          onClick={() => {
            if (editing) save();
            else { setDraft(notes); setEditing(true); }
          }}
          className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 flex items-center gap-1"
        >
          {editing ? <><Check size={10} /> 저장</> : <><Edit3 size={10} /> 편집</>}
        </button>
      </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
          placeholder="프로젝트 메모, 목표, 주의사항 등을 자유롭게 작성..."
          className="w-full bg-transparent text-sm text-zinc-300 p-4 min-h-[120px] resize-y outline-none placeholder-zinc-600"
          autoFocus
        />
      ) : (
        <div className="p-4 text-sm text-zinc-400 whitespace-pre-wrap min-h-[60px]">
          {notes || <span className="italic text-zinc-600">메모 없음 — 편집 버튼을 눌러 작성하세요</span>}
        </div>
      )}
    </div>
  );
}
