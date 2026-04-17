import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import type { Agent } from '../lib/types';
import AgentHierarchy from '../components/dashboard/AgentHierarchy';
import { useT } from '../lib/i18n';
import { AgentModal, emptyAgentForm } from '../components/agents/AgentModal';
import type { AgentFormState } from '../components/agents/AgentModal';

export default function AgentsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const [modal, setModal] = useState<{ mode: 'create' | 'edit'; agent?: Agent } | null>(null);
  const [quickForm, setQuickForm] = useState<AgentFormState>(emptyAgentForm());

  const createAgent = useMutation({
    mutationFn: async (form: AgentFormState) => {
      const created = await api.createAgent({
        id: form.id,
        name: form.name,
        avatar: form.avatar,
        model: form.model,
        systemPrompt: form.systemPrompt,
        allowedTools: form.allowedTools,
        disallowedTools: form.disallowedTools
      });
      // Apply skillIds via PATCH since they're metadata overlay
      if (form.skillIds.length > 0) {
        await api.patchAgent(form.id, { skillIds: form.skillIds });
      }
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      setModal(null);
      setQuickForm(emptyAgentForm());
    }
  });

  const updateAgent = useMutation({
    mutationFn: ({
      id,
      form,
      ifMatchUpdatedAt
    }: {
      id: string;
      form: AgentFormState;
      ifMatchUpdatedAt?: string;
    }) =>
      api.patchAgent(
        id,
        {
          name: form.name,
          avatar: form.avatar,
          model: form.model,
          backendId: form.backend === 'claude' ? null : form.backend,
          systemPrompt: form.systemPrompt,
          skillIds: form.skillIds,
          allowedTools: form.allowedTools,
          disallowedTools: form.disallowedTools
        },
        { ifMatchUpdatedAt }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      setModal(null);
    },
    onError: (err: Error, vars) => {
      if (/UPDATEDAT_CONFLICT|modified by another session|409/.test(err.message)) {
        if (
          confirm(t('agents.conflictConfirm'))
        ) {
          updateAgent.mutate({ id: vars.id, form: vars.form });
        } else {
          qc.invalidateQueries({ queryKey: ['agents'] });
          setModal(null);
        }
      } else {
        alert(`${t('agents.saveFailed')}: ${err.message}`);
      }
    }
  });

  const deleteAgent = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] })
  });

  const cloneAgent = useMutation({
    mutationFn: ({ id, newId, newName }: { id: string; newId: string; newName?: string }) =>
      api.cloneAgent(id, newId, newName),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] })
  });

  const handleClone = (agent: Agent) => {
    const defaultId = `${agent.id}_copy`;
    const newId = prompt(t('agents.clonePrompt'), defaultId);
    if (!newId) return;
    cloneAgent.mutate({ id: agent.id, newId: newId.trim() });
  };

  const handleDelete = (agent: Agent) => {
    if (confirm(t('agents.confirm.delete', { name: agent.name }))) {
      deleteAgent.mutate(agent.id);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">{t('agents.title')}</h2>
          <p className="text-[11px] text-zinc-500 mt-1">
            {t('agents.totalLabel')} {data?.length ?? 0} · {t('agents.help')}
          </p>
        </div>
      </div>

      {/* Create section at top */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold text-zinc-300">
            ⊕ {t('agents.modal.create')}
          </div>
          <button
            onClick={() => setModal({ mode: 'create' })}
            className="text-xs text-zinc-400 hover:text-white flex items-center gap-1"
          >
            {t('agents.add.full')} →
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <input
            value={quickForm.avatar}
            onChange={(e) => setQuickForm({ ...quickForm, avatar: e.target.value })}
            placeholder="🤖"
            maxLength={4}
            className="bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-lg text-center"
          />
          <input
            value={quickForm.id}
            onChange={(e) => setQuickForm({ ...quickForm, id: e.target.value })}
            placeholder="id"
            className="bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
          />
          <input
            value={quickForm.name}
            onChange={(e) => setQuickForm({ ...quickForm, name: e.target.value })}
            placeholder={t('agents.field.name')}
            className="bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
          />
          <button
            disabled={!quickForm.id || !quickForm.name || createAgent.isPending}
            onClick={() => createAgent.mutate(quickForm)}
            className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 text-sm flex items-center justify-center gap-1"
          >
            <Plus size={14} />
            {createAgent.isPending ? t('common.saving') : t('common.create')}
          </button>
        </div>
        <p className="text-[11px] text-zinc-600 mt-2">
          {t('agents.quickHint')}
        </p>
      </div>

      {/* Hierarchy with inline edit/delete -- split layout: palette left, tree right */}
      <AgentHierarchy
        splitLayout
        onEdit={(agent) => setModal({ mode: 'edit', agent })}
        onDelete={handleDelete}
        onClone={handleClone}
      />

      {modal && (
        <AgentModal
          mode={modal.mode}
          agent={modal.agent}
          onClose={() => setModal(null)}
          onSubmit={(form) => {
            if (modal.mode === 'create') createAgent.mutate(form);
            else if (modal.agent)
              updateAgent.mutate({
                id: modal.agent.id,
                form,
                ifMatchUpdatedAt: modal.agent.updatedAt
              });
          }}
          busy={createAgent.isPending || updateAgent.isPending}
        />
      )}
    </div>
  );
}
