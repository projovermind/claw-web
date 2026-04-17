import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { DEFAULT_APPEARANCE } from '../../hooks/useAppearance';
import type { Appearance } from '../../hooks/useAppearance';
import { useT } from '../../lib/i18n';

/**
 * 외관(Appearance) 설정 — 앱 이름 / 채팅 버블 색상.
 * 저장하면 서버 webConfig.appearance 에 반영되고 useAppearance 훅이 즉시 적용.
 */
export function AppearanceTab() {
  const qc = useQueryClient();
  const t = useT();
  const { data, isLoading } = useQuery({ queryKey: ['settings-appearance'], queryFn: api.getSettings });
  const server = (data as { appearance?: Partial<Appearance> } | undefined)?.appearance;

  const [draft, setDraft] = useState<Appearance>(DEFAULT_APPEARANCE);
  useEffect(() => {
    if (server) setDraft({ ...DEFAULT_APPEARANCE, ...server });
  }, [server]);

  const save = useMutation({
    mutationFn: (next: Appearance) => api.patchSettings({ appearance: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings-appearance'] });
    }
  });

  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...DEFAULT_APPEARANCE, ...(server ?? {}) });

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

      <div className="flex gap-2 pt-4 border-t border-zinc-800">
        <button
          onClick={() => save.mutate(draft)}
          disabled={!dirty || save.isPending}
          className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium"
        >
          {save.isPending ? t('common.saving') : t('common.save')}
        </button>
        {dirty && (
          <button
            onClick={() => setDraft({ ...DEFAULT_APPEARANCE, ...(server ?? {}) })}
            className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm"
          >
            {t('common.revert')}
          </button>
        )}
        <button
          onClick={() => setDraft(DEFAULT_APPEARANCE)}
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
