import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Layers } from 'lucide-react';
import { api } from '../lib/api';
import type { Agent } from '../lib/types';
import AgentHierarchy from '../components/dashboard/AgentHierarchy';
import { useT } from '../lib/i18n';
import { AgentModal, emptyAgentForm } from '../components/agents/AgentModal';
import type { AgentFormState } from '../components/agents/AgentModal';
import { BulkModelChangeModal } from '../components/agents/BulkModelChangeModal';
import { useProgressMutation } from '../lib/useProgressMutation';

export default function AgentsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const [modal, setModal] = useState<{ mode: 'create' | 'edit'; agent?: Agent } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [quickForm, setQuickForm] = useState<AgentFormState>(emptyAgentForm());

  const createAgent = useProgressMutation<Agent, Error, AgentFormState>({
    title: '에이전트 생성 중...',
    successMessage: '생성 완료',
    invalidateKeys: [['agents']],
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
      // skillIds / backendId 는 metadata overlay — create 후 PATCH 로 적용
      const patch: Record<string, unknown> = {};
      if (form.skillIds.length > 0) patch.skillIds = form.skillIds;
      if (form.backend && form.backend !== 'claude') patch.backendId = form.backend;
      if (form.backendId) patch.backendId = form.backendId;
      if (form.pinnedFiles.length > 0) patch.pinnedFiles = form.pinnedFiles;
      if (form.gitDiffAutoAttach) patch.gitDiffAutoAttach = true;
      if (Object.keys(patch).length > 0) {
        await api.patchAgent(form.id, patch);
      }
      return created;
    },
    onSuccess: async () => {
      setModal(null);
      setQuickForm(emptyAgentForm());
    },
    onError: (err: Error) => {
      alert(`${t('agents.saveFailed')}: ${err.message}`);
    }
  });

  const updateAgent = useProgressMutation<Agent, Error, { id: string; form: AgentFormState; ifMatchUpdatedAt?: string }>({
    title: '에이전트 저장 중...',
    successMessage: '저장 완료',
    invalidateKeys: [['agents']],
    mutationFn: ({ id, form, ifMatchUpdatedAt }) =>
      api.patchAgent(
        id,
        {
          name: form.name,
          avatar: form.avatar,
          model: form.model,
          backendId: form.backendId || (form.backend === 'claude' ? null : form.backend),
          systemPrompt: form.systemPrompt,
          skillIds: form.skillIds,
          allowedTools: form.allowedTools,
          disallowedTools: form.disallowedTools,
          pinnedFiles: form.pinnedFiles,
          gitDiffAutoAttach: form.gitDiffAutoAttach
        },
        { ifMatchUpdatedAt }
      ),
    onSuccess: async () => {
      setModal(null);
    },
    onError: (err: Error, vars) => {
      if (/UPDATEDAT_CONFLICT|modified by another session|409/.test(err.message)) {
        if (confirm(t('agents.conflictConfirm'))) {
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

  const deleteAgent = useProgressMutation<void, Error, string>({
    title: '에이전트 삭제 중...',
    successMessage: '삭제 완료',
    invalidateKeys: [['agents']],
    mutationFn: (id: string) => api.deleteAgent(id)
  });

  const cloneAgent = useProgressMutation<Agent, Error, { id: string; newId: string; newName?: string }>({
    title: '에이전트 복제 중...',
    successMessage: '복제 완료',
    invalidateKeys: [['agents']],
    mutationFn: ({ id, newId, newName }) => api.cloneAgent(id, newId, newName)
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
        <button
          onClick={() => setBulkOpen(true)}
          className="flex items-center gap-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 py-2 text-xs whitespace-nowrap shrink-0"
        >
          <Layers size={12} /> {t('bulkModel.openButton')}
        </button>
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

      {bulkOpen && <BulkModelChangeModal onClose={() => setBulkOpen(false)} />}

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
