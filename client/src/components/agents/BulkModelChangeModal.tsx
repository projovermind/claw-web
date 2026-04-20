import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Check, Search } from 'lucide-react';
import { api } from '../../lib/api';
import type { Agent, BackendsState } from '../../lib/types';
import { useT } from '../../lib/i18n';
import { useProgressMutation } from '../../lib/useProgressMutation';

/**
 * 에이전트 모델 일괄 변경 모달
 * - 필터: 검색 + 프로젝트 + 현재 모델
 * - 체크박스로 선택 후 새 모델 선택 → 병렬 PATCH
 */
export function BulkModelChangeModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { data: agents = [] } = useQuery<Agent[]>({ queryKey: ['agents'], queryFn: api.agents });
  const { data: backends } = useQuery<BackendsState>({ queryKey: ['backends'], queryFn: api.backends });

  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [currentModelFilter, setCurrentModelFilter] = useState<string>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newModel, setNewModel] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [errors, setErrors] = useState<{ id: string; err: string }[]>([]);

  // 모델 옵션 — 백엔드별 모든 모델 유니크하게 집계
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    const b = backends?.backends ?? {};
    for (const cfg of Object.values(b)) {
      const models = (cfg as { models?: Record<string, string> }).models ?? {};
      for (const [alias, id] of Object.entries(models)) {
        set.add(alias);
        if (id !== alias) set.add(id);
      }
    }
    // 기본 aliases
    ['opus', 'sonnet', 'haiku', 'glm-5.1', 'glm-4.6', 'deepseek-chat'].forEach((m) => set.add(m));
    return Array.from(set).sort();
  }, [backends]);

  // 필터링된 에이전트
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents.filter((a) => {
      if (projectFilter !== 'all') {
        if (projectFilter === '__none__') { if (a.projectId) return false; }
        else if (a.projectId !== projectFilter) return false;
      }
      if (currentModelFilter !== 'all' && (a.model ?? 'sonnet') !== currentModelFilter) return false;
      if (q) {
        const hay = `${a.id} ${a.name ?? ''} ${a.model ?? ''} ${a.projectId ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [agents, search, projectFilter, currentModelFilter]);

  // 프로젝트 옵션
  const projects = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents) if (a.projectId) set.add(a.projectId);
    return Array.from(set).sort();
  }, [agents]);

  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };

  const selectAllFiltered = () => {
    const next = new Set(selectedIds);
    filtered.forEach((a) => next.add(a.id));
    setSelectedIds(next);
  };
  const clearAll = () => setSelectedIds(new Set());

  const bulkMutation = useProgressMutation<{ done: number; failed: number }, Error, void>({
    title: '모델 일괄 변경 중...',
    successMessage: '변경 완료',
    invalidateKeys: [['agents']],
    mutationFn: async () => {
      const ids = Array.from(selectedIds);
      setProgress({ done: 0, total: ids.length });
      setErrors([]);
      // 병렬 제한 — 동시 8개
      const CHUNK = 8;
      const failed: { id: string; err: string }[] = [];
      let done = 0;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map(async (id) => {
            try {
              await api.patchAgent(id, { model: newModel });
            } catch (e) {
              failed.push({ id, err: (e as Error).message });
            } finally {
              done += 1;
              setProgress({ done, total: ids.length });
            }
          })
        );
      }
      setErrors(failed);
      return { done, failed: failed.length };
    }
  });

  const canApply = selectedIds.size > 0 && !!newModel && !bulkMutation.isPending;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div>
            <h3 className="text-base font-semibold">{t('bulkModel.title')}</h3>
            <p className="text-[11px] text-zinc-500 mt-0.5">{t('bulkModel.desc')}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X size={18} />
          </button>
        </div>

        {/* 필터 */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-zinc-800 flex-wrap">
          <div className="flex items-center gap-1.5 flex-1 min-w-[180px]">
            <Search size={14} className="text-zinc-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('bulkModel.searchPlaceholder')}
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-zinc-600"
            />
          </div>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs"
          >
            <option value="all">{t('bulkModel.allProjects')}</option>
            <option value="__none__">{t('bulkModel.unassigned')}</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={currentModelFilter}
            onChange={(e) => setCurrentModelFilter(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs"
          >
            <option value="all">{t('bulkModel.allModels')}</option>
            {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="flex items-center justify-between px-5 py-2 border-b border-zinc-800 text-xs text-zinc-500">
          <div>
            {t('bulkModel.countLine', { selected: selectedIds.size, total: filtered.length })}
          </div>
          <div className="flex gap-2">
            <button onClick={selectAllFiltered} className="text-emerald-400 hover:text-emerald-300">
              {t('bulkModel.selectFiltered')}
            </button>
            <button onClick={clearAll} className="text-zinc-400 hover:text-white">
              {t('bulkModel.clearAll')}
            </button>
          </div>
        </div>

        {/* 에이전트 리스트 */}
        <div className="flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="text-sm text-zinc-600 italic text-center py-12">
              {t('bulkModel.noMatch')}
            </div>
          ) : (
            filtered.map((a) => {
              const checked = selectedIds.has(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => toggle(a.id)}
                  className={`w-full text-left px-3 py-2 rounded flex items-center gap-2.5 text-sm mb-1 ${
                    checked ? 'bg-emerald-900/30 text-emerald-100' : 'text-zinc-300 hover:bg-zinc-800/60'
                  }`}
                >
                  <div className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center ${
                    checked ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600'
                  }`}>
                    {checked && <Check size={11} className="text-zinc-950" />}
                  </div>
                  <span className="text-lg">{a.avatar ?? '🤖'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold truncate">{a.name || a.id}</span>
                      <span className="text-[11px] text-zinc-500 font-mono">{a.id}</span>
                    </div>
                    <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                      {a.projectId && <span>{a.projectId}</span>}
                      {a.projectId && <span className="text-zinc-700">·</span>}
                      <span className="font-mono">{a.model ?? '(none)'}</span>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* 진행 / 에러 */}
        {progress && (
          <div className="px-5 py-2 border-t border-zinc-800 text-xs text-zinc-400">
            {t('bulkModel.progress', { done: progress.done, total: progress.total })}
            {errors.length > 0 && (
              <span className="ml-2 text-red-400">
                {t('bulkModel.errorsCount', { count: errors.length })}
              </span>
            )}
          </div>
        )}

        {/* 대상 모델 + 적용 */}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-zinc-800">
          <span className="text-xs text-zinc-400">{t('bulkModel.targetModel')}</span>
          <select
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-2 text-sm focus:border-sky-500"
          >
            <option value="">{t('bulkModel.selectModel')}</option>
            {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button
            onClick={onClose}
            disabled={bulkMutation.isPending}
            className="px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-sm"
          >
            {t('bulkModel.cancel')}
          </button>
          <button
            onClick={() => bulkMutation.mutate()}
            disabled={!canApply}
            className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm font-semibold"
          >
            {bulkMutation.isPending ? t('bulkModel.applying') : t('bulkModel.applyCount', { count: selectedIds.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
