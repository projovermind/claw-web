import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProgressMutation } from '../../lib/useProgressMutation';
import { Volume2, VolumeX, Play, Plus, Trash2, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api';
import { DEFAULT_APPEARANCE } from '../../hooks/useAppearance';
import type { Appearance } from '../../hooks/useAppearance';
import type { EditorConfig, WebSettings } from '../../lib/types';
import { DEFAULT_EDITOR } from '../../lib/editor';
import { useT } from '../../lib/i18n';
import { playDing } from '../../lib/sound';

/**
 * 외관(Appearance) 설정 — 앱 이름 / 채팅 버블 색상.
 * 저장하면 서버 webConfig.appearance 에 반영되고 useAppearance 훅이 즉시 적용.
 */
export function AppearanceTab() {
  const t = useT();
  const { data, isLoading } = useQuery({ queryKey: ['settings-appearance'], queryFn: api.getSettings });
  const settings = data as WebSettings | undefined;
  const server = settings?.appearance as Partial<Appearance> | undefined;
  const serverEditor = settings?.editor as Partial<EditorConfig> | undefined;

  const [draft, setDraft] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [editorDraft, setEditorDraft] = useState<EditorConfig>(DEFAULT_EDITOR);
  useEffect(() => {
    if (server) setDraft({ ...DEFAULT_APPEARANCE, ...server });
  }, [server]);
  useEffect(() => {
    if (serverEditor) setEditorDraft({ ...DEFAULT_EDITOR, ...serverEditor });
  }, [serverEditor]);

  const save = useProgressMutation<unknown, Error, { appearance: Appearance; editor: EditorConfig }>({
    title: '저장 중...',
    successMessage: '저장 완료',
    invalidateKeys: [['settings-appearance'], ['settings-editor']],
    mutationFn: (next) => api.patchSettings({ appearance: next.appearance, editor: next.editor }),
  });

  const appearanceDirty = JSON.stringify(draft) !== JSON.stringify({ ...DEFAULT_APPEARANCE, ...(server ?? {}) });
  const editorDirty = JSON.stringify(editorDraft) !== JSON.stringify({ ...DEFAULT_EDITOR, ...(serverEditor ?? {}) });
  const dirty = appearanceDirty || editorDirty;

  if (isLoading) return <div className="text-zinc-500 text-sm">{t('common.loading')}</div>;

  return (
    <div className="space-y-6 max-w-xl">
      {/* 앱 이름 */}
      <section>
        <h3 className="text-sm font-semibold mb-2">{t('appearance.appNameTitle')}</h3>
        <p className="text-xs text-zinc-500 mb-2">{t('appearance.appNameDesc')}</p>
        <input
          type="text"
          value={draft.appName}
          onChange={(e) => setDraft({ ...draft, appName: e.target.value.slice(0, 40) })}
          maxLength={40}
          className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm outline-none focus:border-sky-500"
        />
      </section>

      {/* 버블 색상 */}
      <section>
        <h3 className="text-sm font-semibold mb-2">{t('appearance.bubbleTitle')}</h3>
        <div className="grid grid-cols-2 gap-3">
          <ColorField label={t('appearance.bubbleUser')} value={draft.userBubbleColor}
            onChange={(v) => setDraft({ ...draft, userBubbleColor: v })} />
          <ColorField label={t('appearance.bubbleAssistant')} value={draft.assistantBubbleColor}
            onChange={(v) => setDraft({ ...draft, assistantBubbleColor: v })} />
        </div>

        {/* 미리보기 */}
        <div className="mt-4 p-4 bg-zinc-950 rounded border border-zinc-800 space-y-2">
          <div className="flex justify-end">
            <div className="max-w-[70%] rounded-lg px-3 py-2 text-sm text-white" style={{ background: draft.userBubbleColor }}>
              {t('appearance.previewUser')}
            </div>
          </div>
          <div className="flex justify-start">
            <div className="max-w-[70%] rounded-lg px-3 py-2 text-sm text-zinc-200 border border-zinc-800" style={{ background: draft.assistantBubbleColor }}>
              {t('appearance.previewAssistant')}
            </div>
          </div>
        </div>
      </section>

      {/* 알림음 */}
      <section>
        <h3 className="text-sm font-semibold mb-2">{t('appearance.soundTitle')}</h3>
        <p className="text-xs text-zinc-500 mb-3">{t('appearance.soundDesc')}</p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setDraft({ ...draft, soundEnabled: !draft.soundEnabled })}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs ${
              draft.soundEnabled
                ? 'border-emerald-600 bg-emerald-900/30 text-emerald-200'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400'
            }`}
          >
            {draft.soundEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
            {draft.soundEnabled ? t('appearance.soundOn') : t('appearance.soundOff')}
          </button>
          <div className="flex-1 flex items-center gap-2">
            <span className="text-[11px] text-zinc-500 w-12">{t('appearance.soundVolume')}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.soundVolume}
              disabled={!draft.soundEnabled}
              onChange={(e) => setDraft({ ...draft, soundVolume: parseFloat(e.target.value) })}
              className="flex-1 disabled:opacity-30"
            />
            <span className="text-[11px] text-zinc-500 w-8 font-mono">{Math.round(draft.soundVolume * 100)}%</span>
          </div>
          <button
            onClick={() => playDing(draft.soundVolume)}
            disabled={!draft.soundEnabled}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-xs text-zinc-300"
            title={t('appearance.soundTest')}
          >
            <Play size={11} />
            {t('appearance.soundTest')}
          </button>
        </div>
      </section>

      {/* 모델 별명 */}
      <section>
        <h3 className="text-sm font-semibold mb-1">모델 별명</h3>
        <p className="text-xs text-zinc-500 mb-3">원본 모델명 → 표시할 별칭 매핑. ModelBadge에 반영됩니다.</p>
        <div className="space-y-2">
          {Object.entries(draft.modelAliases ?? {}).map(([model, alias]) => (
            <div key={model} className="flex items-center gap-2">
              <input
                type="text"
                value={model}
                readOnly
                className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs font-mono outline-none text-zinc-400"
              />
              <span className="text-zinc-600 text-xs">→</span>
              <input
                type="text"
                value={alias}
                onChange={(e) => {
                  const next = { ...(draft.modelAliases ?? {}), [model]: e.target.value };
                  setDraft({ ...draft, modelAliases: next });
                }}
                className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs font-mono outline-none focus:border-sky-500"
                placeholder="별칭"
              />
              <button
                onClick={() => {
                  const next = { ...(draft.modelAliases ?? {}) };
                  delete next[model];
                  setDraft({ ...draft, modelAliases: next });
                }}
                className="p-1.5 rounded hover:bg-red-900/40 text-zinc-500 hover:text-red-400 shrink-0"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button
            onClick={() => {
              const model = prompt('원본 모델명 (예: claude-opus-4-6)');
              if (!model?.trim()) return;
              setDraft({ ...draft, modelAliases: { ...(draft.modelAliases ?? {}), [model.trim()]: '' } });
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
          >
            <Plus size={12} /> 별명 추가
          </button>
        </div>
      </section>

      {/* 외부 에디터 연동 */}
      <section>
        <h3 className="text-sm font-semibold mb-1 flex items-center gap-1.5">
          <ExternalLink size={13} /> 외부 에디터 연동
        </h3>
        <p className="text-xs text-zinc-500 mb-3">
          파일 경로 옆에 "VS Code / Cursor에서 열기" 버튼이 표시됩니다. 원격 접속 시 경로가 로컬과 다르면 매핑을 추가하세요.
        </p>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-400 w-20">에디터</label>
            <select
              value={editorDraft.scheme}
              onChange={(e) => setEditorDraft({ ...editorDraft, scheme: e.target.value as EditorConfig['scheme'] })}
              className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs outline-none focus:border-sky-500"
            >
              <option value="off">꺼짐 (링크 숨김)</option>
              <option value="vscode">VS Code (vscode://)</option>
              <option value="cursor">Cursor (cursor://)</option>
            </select>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-zinc-400">경로 매핑 (서버 → 로컬)</label>
              <button
                onClick={() => {
                  const from = prompt('서버 경로 접두사 (예: /Volumes/Core)');
                  if (!from?.trim()) return;
                  const to = prompt('로컬 경로 접두사 (예: /Users/me/work)');
                  if (to == null) return;
                  setEditorDraft({
                    ...editorDraft,
                    pathMap: { ...(editorDraft.pathMap ?? {}), [from.trim()]: to.trim() }
                  });
                }}
                className="flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 text-[11px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
              >
                <Plus size={11} /> 매핑 추가
              </button>
            </div>
            {Object.entries(editorDraft.pathMap ?? {}).length === 0 ? (
              <div className="text-[11px] text-zinc-600 italic px-2 py-1.5 border border-dashed border-zinc-800 rounded">
                매핑 없음 — 브라우저와 서버가 같은 머신이면 비워두세요.
              </div>
            ) : (
              <div className="space-y-1.5">
                {Object.entries(editorDraft.pathMap ?? {}).map(([from, to]) => (
                  <div key={from} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={from}
                      readOnly
                      className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs font-mono outline-none text-zinc-400"
                    />
                    <span className="text-zinc-600 text-xs">→</span>
                    <input
                      type="text"
                      value={to}
                      onChange={(e) => {
                        const next = { ...(editorDraft.pathMap ?? {}), [from]: e.target.value };
                        setEditorDraft({ ...editorDraft, pathMap: next });
                      }}
                      className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs font-mono outline-none focus:border-sky-500"
                    />
                    <button
                      onClick={() => {
                        const next = { ...(editorDraft.pathMap ?? {}) };
                        delete next[from];
                        setEditorDraft({ ...editorDraft, pathMap: next });
                      }}
                      className="p-1.5 rounded hover:bg-red-900/40 text-zinc-500 hover:text-red-400 shrink-0"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="flex gap-2 pt-4 border-t border-zinc-800">
        <button
          onClick={() => save.mutate({ appearance: draft, editor: editorDraft })}
          disabled={!dirty || save.isPending}
          className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium"
        >
          {save.isPending ? t('common.saving') : t('common.save')}
        </button>
        {dirty && (
          <button
            onClick={() => {
              setDraft({ ...DEFAULT_APPEARANCE, ...(server ?? {}) });
              setEditorDraft({ ...DEFAULT_EDITOR, ...(serverEditor ?? {}) });
            }}
            className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm"
          >
            {t('common.revert')}
          </button>
        )}
        <button
          onClick={() => { setDraft(DEFAULT_APPEARANCE); setEditorDraft(DEFAULT_EDITOR); }}
          className="px-4 py-2 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 text-sm ml-auto"
        >
          {t('common.default')}
        </button>
      </div>
    </div>
  );
}

/** 컬러 피커 + hex 입력 필드 */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs text-zinc-400 block mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-12 h-9 rounded border border-zinc-700 bg-transparent cursor-pointer shrink-0"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs font-mono outline-none focus:border-sky-500"
        />
      </div>
    </div>
  );
}
