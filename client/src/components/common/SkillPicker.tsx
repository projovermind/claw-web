import { useState, useMemo } from 'react';
import { Sparkles, Package } from 'lucide-react';
import type { Skill } from '../../lib/types';
import { useT } from '../../lib/i18n';

interface Props {
  allSkills: Skill[];
  selectedIds: string[];
  inheritedIds?: string[]; // read-only, greyed out, always selected
  onChange: (ids: string[]) => void;
  emptyMessage?: string;
}

export default function SkillPicker({
  allSkills,
  selectedIds,
  inheritedIds = [],
  onChange,
  emptyMessage
}: Props) {
  const [search, setSearch] = useState('');
  const t = useT();

  const inheritedSet = useMemo(() => new Set(inheritedIds), [inheritedIds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allSkills;
    return allSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.plugin ?? '').toLowerCase().includes(q)
    );
  }, [allSkills, search]);

  // Sort: selected/inherited first → custom then system → alphabetical
  const sorted = useMemo(() => {
    return filtered.slice().sort((a, b) => {
      const ai = inheritedSet.has(a.id) || selectedIds.includes(a.id) ? 0 : 1;
      const bi = inheritedSet.has(b.id) || selectedIds.includes(b.id) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      const as = a.system ? 1 : 0;
      const bs = b.system ? 1 : 0;
      if (as !== bs) return as - bs;
      return a.name.localeCompare(b.name);
    });
  }, [filtered, selectedIds, inheritedSet]);

  const toggle = (id: string) => {
    if (inheritedSet.has(id)) return; // can't uncheck inherited
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };

  if (allSkills.length === 0) {
    return (
      <div className="rounded border border-dashed border-zinc-800 bg-zinc-950/40 p-3 text-[11px] text-zinc-600 italic text-center">
        {emptyMessage ?? t('skillPicker.empty')}
      </div>
    );
  }

  const totalEffective = selectedIds.length + inheritedIds.filter((i) => !selectedIds.includes(i)).length;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('skillPicker.search')}
          className="flex-1 bg-transparent text-xs focus:outline-none placeholder:text-zinc-600"
        />
        <span className="text-[11px] text-zinc-600">
          {totalEffective}/{allSkills.length}
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {sorted.map((s) => {
          const isInherited = inheritedSet.has(s.id);
          const isSelected = selectedIds.includes(s.id);
          const active = isInherited || isSelected;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => toggle(s.id)}
              disabled={isInherited}
              className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 text-xs mb-0.5 ${
                isInherited
                  ? 'bg-zinc-800/40 text-zinc-500 cursor-default'
                  : active
                    ? 'bg-amber-900/30 text-amber-100 hover:bg-amber-900/40'
                    : 'text-zinc-300 hover:bg-zinc-900'
              }`}
              title={isInherited ? t('skillPicker.inheritedTitle') : undefined}
            >
              <div
                className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center ${
                  active
                    ? isInherited
                      ? 'bg-zinc-600 border-zinc-600'
                      : 'bg-amber-500 border-amber-500'
                    : 'border-zinc-600'
                }`}
              >
                {active && <span className="text-[11px] text-zinc-950 font-bold">✓</span>}
              </div>
              {s.system ? (
                <Package size={11} className="text-sky-400 shrink-0" />
              ) : (
                <Sparkles
                  size={11}
                  className={isInherited ? 'text-zinc-500 shrink-0' : 'text-amber-400 shrink-0'}
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate flex items-center gap-1">
                  {s.name}
                  {isInherited && (
                    <span className="text-[11px] px-1 rounded bg-zinc-700 text-zinc-400 font-normal">
                      inherited
                    </span>
                  )}
                  {s.system && s.plugin && (
                    <span className="text-[11px] px-1 rounded bg-sky-900/40 text-sky-300 font-normal truncate">
                      {s.plugin}
                    </span>
                  )}
                </div>
                {s.description && (
                  <div className="text-[11px] text-zinc-500 truncate">{s.description}</div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
