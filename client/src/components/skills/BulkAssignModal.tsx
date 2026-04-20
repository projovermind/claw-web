import { useState, useMemo } from 'react';
import { X, Search } from 'lucide-react';
import { api } from '../../lib/api';
import type { Skill, Agent, Project } from '../../lib/types';
import { useT } from '../../lib/i18n';
import { useProgressMutation } from '../../lib/useProgressMutation';

export function BulkAssignModal({
  skill,
  mode,
  allAgents,
  projects,
  appliedDirectIds,
  appliedInheritedIds,
  onClose,
  onDone
}: {
  skill: Skill;
  mode: 'assign' | 'unassign';
  allAgents: Agent[];
  projects: Project[];
  appliedDirectIds: string[];
  appliedInheritedIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<'all' | 'main' | 'project' | 'addon' | 'unassigned'>('all');

  // For assign: show agents that DON'T already have it directly (inherited is OK to show, user can still add explicit)
  // For unassign: show agents that HAVE it directly (can't unassign inherited)
  const candidates = useMemo(() => {
    let list = allAgents;
    if (mode === 'assign') {
      const has = new Set(appliedDirectIds);
      list = list.filter((a) => !has.has(a.id));
    } else {
      const has = new Set(appliedDirectIds);
      list = list.filter((a) => has.has(a.id));
    }
    if (tierFilter !== 'all') {
      if (tierFilter === 'unassigned') list = list.filter((a) => !a.tier);
      else list = list.filter((a) => a.tier === tierFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (a) =>
          a.id.toLowerCase().includes(q) ||
          (a.name ?? '').toLowerCase().includes(q) ||
          (a.projectId ?? '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [allAgents, mode, appliedDirectIds, tierFilter, search]);

  const toggle = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const selectAll = () => setSelectedIds(candidates.map((a) => a.id));
  const clearAll = () => setSelectedIds([]);

  const mutate = useProgressMutation<void, Error, void>({
    title: mode === 'assign' ? '스킬 일괄 적용 중...' : '스킬 일괄 해제 중...',
    successMessage: mode === 'assign' ? '적용 완료' : '해제 완료',
    mutationFn: async () => {
      if (mode === 'assign') await api.assignSkillToAgents(skill.id, selectedIds);
      else await api.unassignSkillFromAgents(skill.id, selectedIds);
    },
    onSuccess: async () => onDone()
  });

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects]
  );

  const title =
    mode === 'assign'
      ? t('bulk.titleAssign', { name: skill.name })
      : t('bulk.titleUnassign', { name: skill.name });

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div>
            <h3 className="text-base font-semibold">{title}</h3>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {mode === 'assign' ? t('bulk.hintAssign') : t('bulk.hintUnassign')}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-b border-zinc-800">
          <Search size={14} className="text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('bulk.searchPlaceholder')}
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-600"
          />
          <select
            value={tierFilter}
            onChange={(e) =>
              setTierFilter(e.target.value as 'all' | 'main' | 'project' | 'addon' | 'unassigned')
            }
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm"
          >
            <option value="all">{t('bulk.tierAll')}</option>
            <option value="main">Main</option>
            <option value="project">Lead</option>
            <option value="addon">Addon</option>
            <option value="unassigned">{t('bulk.tierUnassigned')}</option>
          </select>
        </div>

        <div className="flex items-center justify-between px-5 py-2 border-b border-zinc-800 text-xs text-zinc-500">
          <div>
            {t('bulk.countLine', { selected: selectedIds.length, total: candidates.length })}
          </div>
          <div className="flex gap-2">
            <button onClick={selectAll} className="text-emerald-400 hover:text-emerald-300">
              {t('bulk.selectAll')}
            </button>
            <button onClick={clearAll} className="text-zinc-400 hover:text-white">
              {t('bulk.deselectAll')}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {candidates.length === 0 ? (
            <div className="text-sm text-zinc-600 italic text-center py-12">
              {mode === 'assign' ? t('bulk.emptyAssign') : t('bulk.emptyUnassign')}
            </div>
          ) : (
            candidates.map((a) => {
              const checked = selectedIds.includes(a.id);
              const isInherited = appliedInheritedIds.includes(a.id);
              const project = a.projectId ? projectById.get(a.projectId) : null;
              return (
                <button
                  key={a.id}
                  onClick={() => toggle(a.id)}
                  className={`w-full text-left px-3 py-2 rounded flex items-center gap-2.5 text-sm mb-1 ${
                    checked ? 'bg-emerald-900/30 text-emerald-100' : 'text-zinc-300 hover:bg-zinc-800/60'
                  }`}
                >
                  <div
                    className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center ${
                      checked ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600'
                    }`}
                  >
                    {checked && <span className="text-[11px] text-zinc-950 font-bold">✓</span>}
                  </div>
                  <span className="text-lg">{a.avatar ?? '🤖'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate flex items-center gap-1.5">
                      {a.name}
                      {isInherited && (
                        <span className="text-[11px] px-1 rounded bg-zinc-700 text-zinc-400 font-normal">
                          {t('bulk.inherited')}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-zinc-500 truncate flex items-center gap-1.5">
                      <span className="font-mono">{a.id}</span>
                      {project && (
                        <>
                          <span className="text-zinc-700">&middot;</span>
                          <span
                            className="inline-flex items-center gap-1"
                            style={{ color: project.color }}
                          >
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: project.color }} />
                            {project.name}
                          </span>
                        </>
                      )}
                      {a.tier && (
                        <>
                          <span className="text-zinc-700">&middot;</span>
                          <span>{a.tier}</span>
                        </>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          <button onClick={onClose} className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm">
            {t('bulk.cancel')}
          </button>
          <button
            disabled={selectedIds.length === 0 || mutate.isPending}
            onClick={() => mutate.mutate()}
            className={`px-4 py-2 rounded text-sm disabled:opacity-40 ${
              mode === 'assign'
                ? 'bg-emerald-700 hover:bg-emerald-600'
                : 'bg-red-900/60 hover:bg-red-900 text-red-100'
            }`}
          >
            {mutate.isPending
              ? t('bulk.processing')
              : mode === 'assign'
                ? t('bulk.applyAssign', { count: selectedIds.length })
                : t('bulk.applyUnassign', { count: selectedIds.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
