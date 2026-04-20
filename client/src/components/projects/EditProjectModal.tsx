import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, AlertTriangle, Sparkles, FileText, Save, FolderOpen, Wrench, UserCircle2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import type { Project, ClaudeCliBackend } from '../../lib/types';
import SkillPicker from '../common/SkillPicker';
import PathPicker from '../common/PathPicker';
import ToolPicker from '../common/ToolPicker';

function LabeledField({
  label,
  help,
  children
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">{label}</span>
      {children}
      {help && <span className="block text-[11px] text-zinc-600 mt-1 leading-snug">{help}</span>}
    </label>
  );
}

export function EditProjectModal({
  project,
  placedCount,
  busy,
  onClose,
  onSubmit
}: {
  project: Project;
  placedCount: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (patch: Partial<Project>) => void;
}) {
  const qc = useQueryClient();
  const t = useT();
  const [form, setForm] = useState<Project>({
    ...project,
    defaultSkillIds: project.defaultSkillIds ?? []
  });
  const { data: skills } = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  const { data: backendsState } = useQuery({ queryKey: ['backends'], queryFn: api.backends });
  const pathChanged = form.path !== project.path;
  const valid = form.name.trim() && form.path.trim();

  const [pickerOpen, setPickerOpen] = useState(false);
  // CLAUDE.md lazy loader
  const [tab, setTab] = useState<'settings' | 'md'>('settings');
  const mdQuery = useQuery({
    queryKey: ['project-md', project.id],
    queryFn: () => api.readProjectMd(project.id),
    enabled: tab === 'md'
  });
  const [mdDraft, setMdDraft] = useState<string | null>(null);
  const [mdConflict, setMdConflict] = useState<string | null>(null);
  const mdContent = mdDraft ?? mdQuery.data?.content ?? '';
  const mdChanged = mdDraft !== null && mdDraft !== (mdQuery.data?.content ?? '');

  const saveMd = useMutation({
    mutationFn: () =>
      api.writeProjectMd(project.id, mdContent, {
        ifMatchMtime: mdQuery.data?.mtimeMs ?? 0
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-md', project.id] });
      setMdDraft(null);
      setMdConflict(null);
    },
    onError: (err: Error) => {
      // 409 conflict: someone else edited the file on disk.
      if (/MTIME_CONFLICT|modified externally|409/.test(err.message)) {
        setMdConflict(t('projects.mdConflictPrompt'));
      }
    }
  });

  const forceSave = async () => {
    // Re-read to get the latest mtime, then save with that mtime so it passes.
    await qc.invalidateQueries({ queryKey: ['project-md', project.id] });
    const fresh = await qc.fetchQuery({
      queryKey: ['project-md', project.id],
      queryFn: () => api.readProjectMd(project.id)
    });
    await api.writeProjectMd(project.id, mdContent, { ifMatchMtime: fresh.mtimeMs });
    qc.invalidateQueries({ queryKey: ['project-md', project.id] });
    setMdDraft(null);
    setMdConflict(null);
  };

  const reloadMd = async () => {
    setMdDraft(null);
    setMdConflict(null);
    await qc.invalidateQueries({ queryKey: ['project-md', project.id] });
  };

  return (
    <>
      <PathPicker
        open={pickerOpen}
        initialPath={form.path || undefined}
        onSelect={(p) => setForm({ ...form, path: p })}
        onClose={() => setPickerOpen(false)}
      />
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        onClick={onClose}
      >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <h3 className="text-lg font-semibold">{t('projects.editTitle')} {project.name}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X size={18} />
          </button>
        </div>
        <div className="flex gap-0 px-5 pt-3 border-b border-zinc-800">
          <button
            onClick={() => setTab('settings')}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === 'settings'
                ? 'border-emerald-500 text-white'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t('projects.settings')}
          </button>
          <button
            onClick={() => setTab('md')}
            className={`px-4 py-2 text-sm border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === 'md'
                ? 'border-emerald-500 text-white'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <FileText size={13} /> CLAUDE.md
            {mdChanged && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
          </button>
        </div>
        {tab === 'md' ? (
          <div className="p-5 flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-zinc-500 truncate">
                {mdQuery.isLoading
                  ? t('projects.mdLoading')
                  : mdQuery.error
                    ? `${t('projects.mdErrorPrefix')}: ${(mdQuery.error as Error).message}`
                    : mdQuery.data?.exists
                      ? (
                        <span>
                          📁 <code className="text-zinc-400">{mdQuery.data.filePath}</code> &middot;{' '}
                          {mdQuery.data.size} bytes
                        </span>
                      )
                      : (
                        <span className="text-amber-400">
                          {t('projects.mdNoFile')}
                        </span>
                      )}
              </div>
              {mdChanged && (
                <button
                  disabled={saveMd.isPending}
                  onClick={() => saveMd.mutate()}
                  className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-3 py-1.5 text-xs flex items-center gap-1 shrink-0 ml-2"
                >
                  <Save size={12} /> {saveMd.isPending ? t('common.saving') : t('projects.mdSaveToFile')}
                </button>
              )}
            </div>
            {mdConflict && (
              <div className="mb-2 rounded border border-amber-900/60 bg-amber-900/20 p-3 text-[11px] text-amber-100 flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-semibold mb-1">{t('common.conflict')}</div>
                  <div className="mb-2 text-amber-200/80">{mdConflict}</div>
                  <div className="flex gap-2">
                    <button
                      onClick={forceSave}
                      className="rounded bg-red-900/50 hover:bg-red-900/70 text-red-200 px-2.5 py-1 text-[11px]"
                    >
                      {t('common.overwriteWithMine')}
                    </button>
                    <button
                      onClick={reloadMd}
                      className="rounded bg-zinc-800 hover:bg-zinc-700 px-2.5 py-1 text-[11px]"
                    >
                      {t('common.reloadFromDisk')}
                    </button>
                    <button
                      onClick={() => setMdConflict(null)}
                      className="rounded bg-zinc-800 hover:bg-zinc-700 px-2.5 py-1 text-[11px] ml-auto"
                    >
                      {t('common.close')}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <textarea
              value={mdContent}
              onChange={(e) => setMdDraft(e.target.value)}
              placeholder={
                mdQuery.isLoading
                  ? ''
                  : t('projects.mdPlaceholder')
              }
              className="flex-1 min-h-[400px] w-full resize-none bg-zinc-950 border border-zinc-800 rounded px-3 py-2 font-mono leading-relaxed focus:outline-none focus:border-zinc-600"
              style={{ fontSize: '13px' }}
            />
            <p className="text-[11px] text-zinc-600 mt-2 leading-snug">
              {t('projects.mdEditorHint')}
            </p>
          </div>
        ) : (
          <div className="p-5 space-y-3 overflow-y-auto flex-1">
            <LabeledField label={t('projects.idImmutable')}>
              <input
                disabled
                value={form.id}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono opacity-50"
              />
            </LabeledField>
            <LabeledField label={t('projects.fieldName')}>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              />
            </LabeledField>
            <LabeledField
              label={t('projects.fieldPath')}
              help={t('projects.pathChangeHelp')}
            >
              <div className="flex gap-1.5">
                <input
                  value={form.path}
                  onChange={(e) => setForm({ ...form, path: e.target.value })}
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                />
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 text-sm text-zinc-300 flex items-center gap-1.5 shrink-0"
                  title={t('common.selectFolder')}
                >
                  <FolderOpen size={14} /> {t('common.find')}
                </button>
              </div>
            </LabeledField>
            <LabeledField label={t('projects.fieldColor')}>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  className="w-12 h-10 bg-transparent border border-zinc-800 rounded cursor-pointer"
                  value={form.color ?? '#7bcce0'}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                />
                <code className="text-[11px] text-zinc-500 font-mono">{form.color}</code>
              </div>
            </LabeledField>
            <div className="border-t border-zinc-800 pt-3">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                <Sparkles size={11} className="text-amber-400" />
                {t('projects.defaultSkills')}
              </div>
              <p className="text-[11px] text-zinc-600 leading-snug mb-2">
                {t('projects.defaultSkillsHelp')}
              </p>
              <SkillPicker
                allSkills={skills ?? []}
                selectedIds={form.defaultSkillIds ?? []}
                onChange={(ids) => setForm({ ...form, defaultSkillIds: ids })}
              />
              <div className="text-[11px] text-zinc-600 mt-1.5">
                {t('projects.defaultSkillsInherit', { count: placedCount })}
              </div>
            </div>

            <div className="border-t border-zinc-800 pt-3">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                <Wrench size={11} className="text-sky-400" />
                {t('projects.defaultAllowedTools')}
              </div>
              <p className="text-[11px] text-zinc-600 leading-snug mb-2">
                {t('projects.defaultAllowedToolsHelp')}
              </p>
              <ToolPicker
                selected={form.defaultAllowedTools ?? []}
                onChange={(tools) => setForm({ ...form, defaultAllowedTools: tools })}
              />
            </div>

            <div className="border-t border-zinc-800 pt-3">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                <Wrench size={11} className="text-red-400" />
                {t('projects.defaultDisallowedTools')}
              </div>
              <p className="text-[11px] text-zinc-600 leading-snug mb-2">
                {t('projects.defaultDisallowedToolsHelp')}
              </p>
              <ToolPicker
                selected={form.defaultDisallowedTools ?? []}
                onChange={(tools) => setForm({ ...form, defaultDisallowedTools: tools })}
              />
            </div>

            <div className="border-t border-zinc-800 pt-3">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                <UserCircle2 size={11} className="text-indigo-400" />
                Claude 백엔드 (Backend)
              </div>
              <p className="text-[11px] text-zinc-600 leading-snug mb-2">
                이 프로젝트 에이전트에 우선 사용할 Claude CLI 백엔드. 미선택 시 스케줄러가 자동 분배합니다.
              </p>
              <select
                value={form.backendId ?? ''}
                onChange={(e) => setForm({ ...form, backendId: e.target.value || null })}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              >
                <option value="">자동 (스케줄러 분배)</option>
                {Object.values(backendsState?.backends ?? {})
                  .filter((b): b is ClaudeCliBackend => b.type === 'claude-cli')
                  .filter((b) => b.status !== 'disabled')
                  .map((b) => (
                    <option key={b.id} value={b.id}>{b.label} ({b.id})</option>
                  ))}
              </select>
            </div>

            {pathChanged && placedCount > 0 && (
              <div className="rounded bg-amber-900/20 border border-amber-900/40 p-3 text-[11px] text-amber-200 flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <div>
                  {t('projects.pathChangeWarn', { count: placedCount })}
                </div>
              </div>
            )}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          {tab === 'md' ? (
            <button
              onClick={onClose}
              className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm"
            >
              {t('common.close')}
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm"
              >
                {t('common.cancel')}
              </button>
              <button
                disabled={!valid || busy}
                onClick={() =>
                  onSubmit({
                    name: form.name,
                    path: form.path,
                    color: form.color,
                    defaultSkillIds: form.defaultSkillIds,
                    defaultAllowedTools: form.defaultAllowedTools,
                    defaultDisallowedTools: form.defaultDisallowedTools,
                    backendId: form.backendId ?? null,
                  })
                }
                className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm"
              >
                {busy ? t('common.saving') : t('common.save')}
              </button>
            </>
          )}
        </div>
      </div>
      </div>
    </>
  );
}
