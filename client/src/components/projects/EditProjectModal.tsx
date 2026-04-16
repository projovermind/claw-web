import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, AlertTriangle, Sparkles, FileText, Save, FolderOpen, Wrench } from 'lucide-react';
import { api } from '../../lib/api';
import type { Project } from '../../lib/types';
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
  const [form, setForm] = useState<Project>({
    ...project,
    defaultSkillIds: project.defaultSkillIds ?? []
  });
  const { data: skills } = useQuery({ queryKey: ['skills'], queryFn: api.skills });
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
        setMdConflict(
          '파일이 외부에서 수정됐어. 디스크에 있는 최신 내용을 무조건 덮어쓸까, 아니면 다시 불러올까?'
        );
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
          <h3 className="text-lg font-semibold">프로젝트 편집: {project.name}</h3>
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
            설정
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
                  ? '로딩 중...'
                  : mdQuery.error
                    ? `에러: ${(mdQuery.error as Error).message}`
                    : mdQuery.data?.exists
                      ? (
                        <span>
                          📁 <code className="text-zinc-400">{mdQuery.data.filePath}</code> &middot;{' '}
                          {mdQuery.data.size} bytes
                        </span>
                      )
                      : (
                        <span className="text-amber-400">
                          ⚠ 파일 없음 &mdash; 저장하면 새로 생성됨
                        </span>
                      )}
              </div>
              {mdChanged && (
                <button
                  disabled={saveMd.isPending}
                  onClick={() => saveMd.mutate()}
                  className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-3 py-1.5 text-xs flex items-center gap-1 shrink-0 ml-2"
                >
                  <Save size={12} /> {saveMd.isPending ? '저장 중...' : '파일에 저장'}
                </button>
              )}
            </div>
            {mdConflict && (
              <div className="mb-2 rounded border border-amber-900/60 bg-amber-900/20 p-3 text-[11px] text-amber-100 flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-semibold mb-1">충돌 감지</div>
                  <div className="mb-2 text-amber-200/80">{mdConflict}</div>
                  <div className="flex gap-2">
                    <button
                      onClick={forceSave}
                      className="rounded bg-red-900/50 hover:bg-red-900/70 text-red-200 px-2.5 py-1 text-[11px]"
                    >
                      내 수정으로 덮어쓰기
                    </button>
                    <button
                      onClick={reloadMd}
                      className="rounded bg-zinc-800 hover:bg-zinc-700 px-2.5 py-1 text-[11px]"
                    >
                      디스크에서 다시 불러오기
                    </button>
                    <button
                      onClick={() => setMdConflict(null)}
                      className="rounded bg-zinc-800 hover:bg-zinc-700 px-2.5 py-1 text-[11px] ml-auto"
                    >
                      닫기
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
                  : '# 프로젝트 이름\n\n## 기술 스택\n- ...\n\n## 빌드 & 배포\n```bash\n...\n```\n\n## 에이전트 가이드라인\n- ...'
              }
              className="flex-1 min-h-[400px] w-full resize-none bg-zinc-950 border border-zinc-800 rounded px-3 py-2 font-mono leading-relaxed focus:outline-none focus:border-zinc-600"
              style={{ fontSize: '13px' }}
            />
            <p className="text-[11px] text-zinc-600 mt-2 leading-snug">
              💡 이 파일은 해당 프로젝트 폴더의 <code>CLAUDE.md</code>. Claude CLI가 이 프로젝트를 cwd로
              실행할 때 자동으로 로드해서 컨텍스트로 쓰임. Lightweight Mode 에이전트는 이 내용이 systemPrompt
              역할을 해. 저장 시 실제 파일 시스템에 쓰여.
            </p>
          </div>
        ) : (
          <div className="p-5 space-y-3 overflow-y-auto flex-1">
            <LabeledField label="ID (변경 불가)">
              <input
                disabled
                value={form.id}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono opacity-50"
              />
            </LabeledField>
            <LabeledField label="이름">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              />
            </LabeledField>
            <LabeledField
              label="경로 (Path)"
              help="수정 시 이 프로젝트에 배치된 에이전트의 workingDir이 자동 cascade 업데이트됨. 실제 폴더는 건드리지 않음."
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
                  title="폴더 선택"
                >
                  <FolderOpen size={14} /> 찾기
                </button>
              </div>
            </LabeledField>
            <LabeledField label="색상">
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
                기본 스킬 (Default Skills)
              </div>
              <p className="text-[11px] text-zinc-600 leading-snug mb-2">
                이 프로젝트에 배치된 모든 에이전트(Lead + Addon)가 자동 상속함. 에이전트 개별 설정에서 추가 스킬을 더할 수는 있지만 상속된 스킬은 빼지 못해. 전역 일괄 분배에 최적.
              </p>
              <SkillPicker
                allSkills={skills ?? []}
                selectedIds={form.defaultSkillIds ?? []}
                onChange={(ids) => setForm({ ...form, defaultSkillIds: ids })}
              />
              <div className="text-[11px] text-zinc-600 mt-1.5">
                💡 배치된 에이전트 {placedCount}명이 이 스킬들을 자동으로 받게 돼.
              </div>
            </div>

            <div className="border-t border-zinc-800 pt-3">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                <Wrench size={11} className="text-sky-400" />
                기본 허용 도구 (Default Allowed Tools)
              </div>
              <p className="text-[11px] text-zinc-600 leading-snug mb-2">
                이 프로젝트의 모든 에이전트가 자동으로 호출할 수 있는 Claude 도구. 에이전트 개별 설정에서 추가로 도구를 더할 수는 있음. 비우면 상속 없음(Claude 기본값).
              </p>
              <ToolPicker
                selected={form.defaultAllowedTools ?? []}
                onChange={(tools) => setForm({ ...form, defaultAllowedTools: tools })}
              />
            </div>

            <div className="border-t border-zinc-800 pt-3">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                <Wrench size={11} className="text-red-400" />
                기본 차단 도구 (Default Disallowed Tools)
              </div>
              <p className="text-[11px] text-zinc-600 leading-snug mb-2">
                이 프로젝트의 모든 에이전트가 절대 못 쓰는 도구. 에이전트 개별 설정보다 우선. 예: router 계열 에이전트는 Edit/Write/Bash 차단.
              </p>
              <ToolPicker
                selected={form.defaultDisallowedTools ?? []}
                onChange={(tools) => setForm({ ...form, defaultDisallowedTools: tools })}
              />
            </div>

            {pathChanged && placedCount > 0 && (
              <div className="rounded bg-amber-900/20 border border-amber-900/40 p-3 text-[11px] text-amber-200 flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <div>
                  경로를 변경하면 이 프로젝트에 배치된 <strong>{placedCount}개 에이전트</strong>의{' '}
                  <code>workingDir</code>이 새 경로로 자동 업데이트됨. 실제 폴더는 건드리지 않아.
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
              닫기
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm"
              >
                취소
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
                    defaultDisallowedTools: form.defaultDisallowedTools
                  })
                }
                className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm"
              >
                {busy ? '저장 중...' : '저장'}
              </button>
            </>
          )}
        </div>
      </div>
      </div>
    </>
  );
}
