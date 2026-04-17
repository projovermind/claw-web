import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, Sparkles, Package, Lock, Users, UserPlus, UserMinus } from 'lucide-react';
import { api } from '../../lib/api';
import type { Skill, Agent } from '../../lib/types';
import { useT } from '../../lib/i18n';

export function SkillDetail({
  selected,
  appliedAgents,
  onEdit,
  onAssign
}: {
  selected: Skill;
  appliedAgents: { direct: Agent[]; inherited: Agent[] };
  onEdit: (skill: Skill) => void;
  onAssign: (skill: Skill, mode: 'assign' | 'unassign') => void;
}) {
  const qc = useQueryClient();
  const t = useT();
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSkill(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
    }
  });

  const totalApplied = appliedAgents.direct.length + appliedAgents.inherited.length;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {selected.system ? (
              <Package size={18} className="text-sky-400" />
            ) : (
              <Sparkles size={18} className="text-amber-400" />
            )}
            <div className="text-xl font-semibold truncate">{selected.name}</div>
            {selected.system && (
              <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-sky-900/40 text-sky-300">
                <Lock size={11} /> {t('skillDetail.system')} &middot; {selected.plugin}
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500 font-mono mt-1 break-all">{selected.id}</div>
          {selected.description && (
            <div className="text-sm text-zinc-400 mt-1.5">{selected.description}</div>
          )}
          {selected.source && (
            <div className="text-xs text-zinc-600 font-mono mt-1.5 truncate" title={selected.source}>
              📁 {selected.source}
            </div>
          )}
        </div>
        {!selected.system && (
          <>
            <button
              onClick={() => onEdit(selected)}
              className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white"
              title={t('skillDetail.edit')}
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={() => {
                if (confirm(t('skillDetail.deleteConfirm', { name: selected.name }))) remove.mutate(selected.id);
              }}
              className="p-1.5 rounded hover:bg-red-900/40 text-zinc-400 hover:text-red-400"
              title={t('skillDetail.delete')}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
      {/* Applied agents section */}
      <div className="border-t border-zinc-800 pt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-zinc-500">
            <Users size={13} />
            <span>{t('skillDetail.appliedAgents')} &middot; {totalApplied}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onAssign(selected, 'assign')}
              className="text-xs rounded bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-200 px-2.5 py-1 flex items-center gap-1"
            >
              <UserPlus size={11} /> {t('skillDetail.addAgent')}
            </button>
            {appliedAgents.direct.length > 0 && (
              <button
                onClick={() => onAssign(selected, 'unassign')}
                className="text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-2.5 py-1 flex items-center gap-1"
              >
                <UserMinus size={11} /> {t('skillDetail.removeAgent')}
              </button>
            )}
          </div>
        </div>
        {totalApplied === 0 ? (
          <div className="text-xs text-zinc-600 italic py-3">
            {t('skillDetail.emptyApplied')}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {appliedAgents.direct.map((a) => (
              <AgentChip key={`d-${a.id}`} agent={a} variant="direct" />
            ))}
            {appliedAgents.inherited.map((a) => (
              <AgentChip key={`i-${a.id}`} agent={a} variant="inherited" />
            ))}
          </div>
        )}
        {appliedAgents.inherited.length > 0 && (
          <div className="text-[11px] text-zinc-600 mt-2">
            {t('skillDetail.inheritedHint')}
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800 pt-3">
        <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
          Content (Markdown)
        </div>
        <pre className="text-sm text-zinc-300 font-mono whitespace-pre-wrap break-words bg-zinc-950/60 border border-zinc-800 rounded p-4 max-h-[500px] overflow-y-auto leading-relaxed">
          {selected.content || <span className="text-zinc-600 italic">{t('skillDetail.emptyContent')}</span>}
        </pre>
      </div>
    </div>
  );
}

function AgentChip({ agent, variant }: { agent: Agent; variant: 'direct' | 'inherited' }) {
  const t = useT();
  const cls =
    variant === 'direct'
      ? 'bg-emerald-900/30 border-emerald-900/50 text-emerald-200'
      : 'bg-zinc-800/60 border-zinc-700 text-zinc-400';
  return (
    <span
      className={`text-xs px-2 py-1 rounded border ${cls} flex items-center gap-1`}
      title={variant === 'inherited' ? t('skillDetail.inheritedTitle', { name: agent.name }) : agent.name}
    >
      <span>{agent.avatar ?? '🤖'}</span>
      <span className="truncate max-w-[120px]">{agent.name}</span>
      {variant === 'inherited' && <Lock size={9} className="text-zinc-600" />}
    </span>
  );
}
