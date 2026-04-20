import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  X,
  Search,
  Sparkles,
  Package,
  RefreshCw,
} from 'lucide-react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import type { Skill, Agent } from '../lib/types';
import { SkillDetail } from '../components/skills/SkillDetail';
import { BulkAssignModal } from '../components/skills/BulkAssignModal';
import { useProgressMutation } from '../lib/useProgressMutation';

const emptyDraft = () => ({ name: '', description: '', content: '' });

export default function SkillsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  const { data: agents } = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [draft, setDraft] = useState(emptyDraft());
  const [editing, setEditing] = useState<Skill | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assignModal, setAssignModal] = useState<{ skill: Skill; mode: 'assign' | 'unassign' } | null>(null);

  const create = useProgressMutation<Skill, Error, { name: string; description: string; content: string }>({
    title: '스킬 생성 중...',
    successMessage: '생성 완료',
    invalidateKeys: [['skills']],
    mutationFn: (d) => api.createSkill(d),
    onSuccess: async (s) => {
      setDraft(emptyDraft());
      setSelectedId(s.id);
    }
  });
  const update = useProgressMutation<Skill, Error, { id: string; patch: Partial<Omit<Skill, 'id'>> }>({
    title: '스킬 저장 중...',
    successMessage: '저장 완료',
    invalidateKeys: [['skills']],
    mutationFn: ({ id, patch }) => api.patchSkill(id, patch),
    onSuccess: async () => {
      setEditing(null);
    }
  });
  // Split custom vs system
  const custom = useMemo(() => (data ?? []).filter((s) => !s.system), [data]);
  const system = useMemo(() => (data ?? []).filter((s) => s.system), [data]);

  const filterFn = (list: Skill[]) => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.content.toLowerCase().includes(q) ||
        (s.plugin ?? '').toLowerCase().includes(q)
    );
  };
  const customFiltered = useMemo(() => filterFn(custom), [custom, search]);
  const systemFiltered = useMemo(() => filterFn(system), [system, search]);

  const refreshSystem = useProgressMutation<unknown, Error, void>({
    title: '시스템 스킬 새로고침 중...',
    successMessage: '새로고침 완료',
    invalidateKeys: [['skills']],
    mutationFn: () =>
      fetch('/api/skills/system/refresh', { method: 'POST' }).then((r) => r.json())
  });

  const selected = (data ?? []).find((s) => s.id === selectedId) ?? null;

  // Find agents that have the selected skill (directly or inherited via project)
  const appliedAgents = useMemo(() => {
    if (!selected || !agents) return { direct: [] as Agent[], inherited: [] as Agent[] };
    const direct: Agent[] = [];
    const inherited: Agent[] = [];
    for (const agent of agents) {
      const directHas = Array.isArray(agent.skillIds) && agent.skillIds.includes(selected.id);
      const project = agent.projectId ? (projects ?? []).find((p) => p.id === agent.projectId) : null;
      const inheritedHas =
        project?.defaultSkillIds?.includes(selected.id) ?? false;
      if (directHas) direct.push(agent);
      else if (inheritedHas) inherited.push(agent);
    }
    return { direct, inherited };
  }, [selected, agents, projects]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      <div>
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <Sparkles size={22} className="text-amber-400" /> {t('skills.title')}
        </h2>
        <p className="text-sm text-zinc-500 mt-2 max-w-4xl leading-relaxed">
          {t('skills.intro')}{' '}
          <code className="text-zinc-400 text-xs">--append-system-prompt</code>{t('skills.introSuffix')}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-5 items-start">
        {/* Left: list + create */}
        <div className="space-y-3 min-w-0">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
            <div className="text-base font-semibold text-zinc-200">{t('skills.add')}</div>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={t('skills.namePlaceholder')}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            />
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder={t('skills.descPlaceholder')}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            />
            <button
              disabled={!draft.name.trim() || create.isPending}
              onClick={() =>
                create.mutate({
                  name: draft.name.trim(),
                  description: draft.description.trim(),
                  content: draft.content
                })
              }
              className="w-full rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-3 py-2 text-sm flex items-center justify-center gap-1.5"
            >
              <Plus size={14} /> {t('skills.createEmpty')}
            </button>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
              <Search size={14} className="text-zinc-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('skills.searchPlaceholder')}
                className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-zinc-600"
                style={{ fontSize: '14px' }}
              />
              <span className="text-xs text-zinc-600 font-mono">
                {customFiltered.length + systemFiltered.length}
              </span>
            </div>
            <div className="max-h-[560px] overflow-y-auto p-1.5">
              {/* Custom skills */}
              {customFiltered.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] uppercase tracking-wider text-zinc-500">
                    <Sparkles size={11} className="text-amber-400" />
                    <span>{t('skills.mySkills')} &middot; {customFiltered.length}</span>
                  </div>
                  {customFiltered.map((s) => (
                    <SkillListButton
                      key={s.id}
                      skill={s}
                      active={selectedId === s.id}
                      onClick={() => setSelectedId(s.id)}
                    />
                  ))}
                </>
              )}
              {/* System skills */}
              {systemFiltered.length > 0 && (
                <>
                  <div className="flex items-center justify-between gap-1.5 px-2 py-1.5 mt-3 text-[11px] uppercase tracking-wider text-zinc-500">
                    <div className="flex items-center gap-1.5">
                      <Package size={11} className="text-sky-400" />
                      <span>{t('skills.systemSkills')} &middot; {systemFiltered.length}</span>
                    </div>
                    <button
                      onClick={() => refreshSystem.mutate()}
                      disabled={refreshSystem.isPending}
                      className="text-[11px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
                      title={t('skills.rescan')}
                    >
                      <RefreshCw size={11} className={refreshSystem.isPending ? 'animate-spin' : ''} />
                      {t('common.refresh')}
                    </button>
                  </div>
                  {systemFiltered.map((s) => (
                    <SkillListButton
                      key={s.id}
                      skill={s}
                      active={selectedId === s.id}
                      onClick={() => setSelectedId(s.id)}
                    />
                  ))}
                </>
              )}
              {customFiltered.length === 0 && systemFiltered.length === 0 && (
                <div className="text-sm text-zinc-600 italic text-center py-8">
                  {search ? t('common.noResults') : t('skills.emptyNoSearch')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: detail + editor */}
        <div className="min-w-0">
          {!selected ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-8 text-center text-zinc-600 text-sm">
              {t('skills.selectHint')}
            </div>
          ) : (
            <SkillDetail
              selected={selected}
              appliedAgents={appliedAgents}
              onEdit={(skill) => setEditing(skill)}
              onAssign={(skill, mode) => setAssignModal({ skill, mode })}
            />
          )}
        </div>
      </div>

      {editing && (
        <EditSkillModal
          skill={editing}
          busy={update.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(patch) => update.mutate({ id: editing.id, patch })}
        />
      )}

      {assignModal && (
        <BulkAssignModal
          skill={assignModal.skill}
          mode={assignModal.mode}
          allAgents={agents ?? []}
          projects={projects ?? []}
          appliedDirectIds={appliedAgents.direct.map((a) => a.id)}
          appliedInheritedIds={appliedAgents.inherited.map((a) => a.id)}
          onClose={() => setAssignModal(null)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ['agents'] });
            setAssignModal(null);
          }}
        />
      )}
    </div>
  );
}

function SkillListButton({
  skill,
  active,
  onClick
}: {
  skill: Skill;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded px-2.5 py-2 mb-1 transition-colors ${
        active ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:bg-zinc-900'
      }`}
    >
      <div className="flex items-center gap-2">
        {skill.system ? (
          <Package size={13} className="text-sky-400 shrink-0" />
        ) : (
          <Sparkles size={13} className="text-amber-400 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">{skill.name}</div>
          {skill.description && (
            <div className="text-[11px] text-zinc-500 truncate mt-0.5">{skill.description}</div>
          )}
        </div>
        {skill.system && skill.plugin && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-300 shrink-0">
            {skill.plugin}
          </span>
        )}
      </div>
    </button>
  );
}

function EditSkillModal({
  skill,
  busy,
  onClose,
  onSubmit
}: {
  skill: Skill;
  busy: boolean;
  onClose: () => void;
  onSubmit: (patch: Partial<Omit<Skill, 'id'>>) => void;
}) {
  const t = useT();
  const [form, setForm] = useState({
    name: skill.name,
    description: skill.description,
    content: skill.content
  });
  const valid = form.name.trim();

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles size={16} className="text-amber-400" /> {t('skills.editTitle')}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{t('skills.name')}</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{t('skills.desc')}</span>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder={t('skills.descLongPlaceholder')}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
              {t('skills.contentLabel')}
            </span>
            <textarea
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              rows={20}
              placeholder={t('skills.contentPlaceholder')}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono leading-relaxed"
              style={{ fontSize: '13px' }}
            />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          <button onClick={onClose} className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm">
            {t('common.cancel')}
          </button>
          <button
            disabled={!valid || busy}
            onClick={() => onSubmit(form)}
            className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm"
          >
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
