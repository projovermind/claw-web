import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  X,
  Search,
  Sparkles,
  Package,
  RefreshCw,
} from 'lucide-react';
import { api } from '../lib/api';
import type { Skill, Agent } from '../lib/types';
import { SkillDetail } from '../components/skills/SkillDetail';
import { BulkAssignModal } from '../components/skills/BulkAssignModal';

const emptyDraft = () => ({ name: '', description: '', content: '' });

export default function SkillsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  const { data: agents } = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [draft, setDraft] = useState(emptyDraft());
  const [editing, setEditing] = useState<Skill | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assignModal, setAssignModal] = useState<{ skill: Skill; mode: 'assign' | 'unassign' } | null>(null);

  const create = useMutation({
    mutationFn: (d: { name: string; description: string; content: string }) => api.createSkill(d),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      setDraft(emptyDraft());
      setSelectedId(s.id);
    }
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Omit<Skill, 'id'>> }) =>
      api.patchSkill(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
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

  const refreshSystem = useMutation({
    mutationFn: () =>
      fetch('/api/skills/system/refresh', { method: 'POST' }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] })
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
          <Sparkles size={22} className="text-amber-400" /> 스킬
        </h2>
        <p className="text-sm text-zinc-500 mt-2 max-w-4xl leading-relaxed">
          스킬은 재사용 가능한 Markdown 지침. 에이전트 편집 모달에서 선택하면, 채팅 호출 시 선택된 스킬들의 본문이{' '}
          <code className="text-zinc-400 text-xs">--append-system-prompt</code>에 concat되어 주입돼. 여러
          에이전트가 같은 스킬을 공유 가능 (TDD 워크플로, 코드 리뷰 규칙, 배포 체크리스트 등).
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-5 items-start">
        {/* Left: list + create */}
        <div className="space-y-3 min-w-0">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
            <div className="text-base font-semibold text-zinc-200">+ 스킬 추가</div>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="이름 (예: TDD Workflow)"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            />
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="설명 (한 줄)"
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
              <Plus size={14} /> 생성 (빈 본문)
            </button>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
              <Search size={14} className="text-zinc-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="스킬 검색"
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
                    <span>내 스킬 &middot; {customFiltered.length}</span>
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
                      <span>시스템 스킬 &middot; {systemFiltered.length}</span>
                    </div>
                    <button
                      onClick={() => refreshSystem.mutate()}
                      disabled={refreshSystem.isPending}
                      className="text-[11px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
                      title="~/.claude/plugins 재스캔"
                    >
                      <RefreshCw size={11} className={refreshSystem.isPending ? 'animate-spin' : ''} />
                      새로고침
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
                  {search ? '결과 없음' : '아직 스킬 없음 — 위에서 생성하세요'}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: detail + editor */}
        <div className="min-w-0">
          {!selected ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-8 text-center text-zinc-600 text-sm">
              왼쪽에서 스킬을 선택하거나 새로 생성하세요.
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
            <Sparkles size={16} className="text-amber-400" /> 스킬 편집
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">이름</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">설명</span>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="한 줄 요약 (이 스킬이 뭐고 언제 써야 하는지)"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
              Content (Markdown)
            </span>
            <textarea
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              rows={20}
              placeholder="## TDD Workflow&#10;&#10;1. 실패하는 테스트 작성&#10;2. 테스트 돌려서 실패 확인&#10;3. 통과하는 최소 구현&#10;..."
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono leading-relaxed"
              style={{ fontSize: '13px' }}
            />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          <button onClick={onClose} className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm">
            취소
          </button>
          <button
            disabled={!valid || busy}
            onClick={() => onSubmit(form)}
            className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm"
          >
            {busy ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
