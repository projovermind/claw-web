import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { DEFAULT_APPEARANCE } from '../../hooks/useAppearance';
import type { Appearance } from '../../hooks/useAppearance';

/**
 * 외관(Appearance) 설정 — 앱 이름 / 테마 / 채팅 버블 색상.
 * 저장하면 서버 webConfig.appearance 에 반영되고 useAppearance 훅이 즉시 적용.
 */
export function AppearanceTab() {
  const qc = useQueryClient();
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

  if (isLoading) return <div className="text-zinc-500 text-sm">불러오는 중...</div>;

  return (
    <div className="space-y-6 max-w-xl">
      {/* 앱 이름 */}
      <section>
        <h3 className="text-sm font-semibold mb-2">앱 이름</h3>
        <p className="text-xs text-zinc-500 mb-2">좌측 상단 + 탭 제목에 표시됩니다.</p>
        <input
          type="text"
          value={draft.appName}
          onChange={(e) => setDraft({ ...draft, appName: e.target.value.slice(0, 40) })}
          maxLength={40}
          className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm outline-none focus:border-sky-500"
        />
      </section>

      {/* 테마 */}
      <section>
        <h3 className="text-sm font-semibold mb-2">테마</h3>
        <div className="flex gap-2">
          {(['dark', 'light', 'system'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setDraft({ ...draft, theme: t })}
              className={`px-3 py-1.5 rounded border text-xs ${
                draft.theme === t
                  ? 'border-sky-500 bg-sky-900/30 text-sky-200'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {t === 'dark' ? '다크' : t === 'light' ? '라이트' : '시스템'}
            </button>
          ))}
        </div>
      </section>

      {/* 라이트 모드 미세 조정 — theme=light 또는 system 일 때만 노출 */}
      {(draft.theme === 'light' || draft.theme === 'system') && (
        <section className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-1">라이트 모드 색상</h3>
          <p className="text-xs text-zinc-500 mb-3">
            라이트 모드에서 적용되는 기본 배경 / 텍스트 색. CSS 변수로 실시간 반영됩니다.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <ColorField label="메인 배경" value={draft.lightBg}
              onChange={(v) => setDraft({ ...draft, lightBg: v })} />
            <ColorField label="카드/사이드바 배경" value={draft.lightSurface}
              onChange={(v) => setDraft({ ...draft, lightSurface: v })} />
            <ColorField label="본문 텍스트" value={draft.lightText}
              onChange={(v) => setDraft({ ...draft, lightText: v })} />
            <ColorField label="보조 텍스트 (메타)" value={draft.lightMuted}
              onChange={(v) => setDraft({ ...draft, lightMuted: v })} />
          </div>

          {/* 라이트 미리보기 */}
          <div className="mt-4 p-4 rounded border" style={{
            background: draft.lightBg, borderColor: '#e4e4e7'
          }}>
            <div className="text-sm mb-2" style={{ color: draft.lightText }}>
              본문 텍스트 — <strong>강조</strong> 는 여기서 더 진하게.
            </div>
            <div className="text-xs" style={{ color: draft.lightMuted }}>
              메타 정보 — 날짜, 카운트 등
            </div>
            <div className="mt-3 rounded px-3 py-2 text-sm" style={{
              background: draft.lightSurface, color: draft.lightText
            }}>
              카드 / 사이드바 영역 미리보기
            </div>
          </div>

          <div className="flex gap-2 mt-3">
            <button
              onClick={() => setDraft({ ...draft,
                lightBg: '#fafafa', lightSurface: '#f4f4f5',
                lightText: '#18181b', lightMuted: '#52525b' })}
              className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200"
            >기본 (Zinc)</button>
            <button
              onClick={() => setDraft({ ...draft,
                lightBg: '#ffffff', lightSurface: '#f8fafc',
                lightText: '#0f172a', lightMuted: '#475569' })}
              className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200"
            >차분 (Slate)</button>
            <button
              onClick={() => setDraft({ ...draft,
                lightBg: '#fffbeb', lightSurface: '#fef3c7',
                lightText: '#451a03', lightMuted: '#78350f' })}
              className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200"
            >따뜻 (Amber)</button>
          </div>
        </section>
      )}

      {/* 버블 색상 */}
      <section>
        <h3 className="text-sm font-semibold mb-2">채팅 버블 색상</h3>
        <div className="grid grid-cols-2 gap-3">
          <ColorField label="사용자 (내 메시지)" value={draft.userBubbleColor}
            onChange={(v) => setDraft({ ...draft, userBubbleColor: v })} />
          <ColorField label="에이전트 응답" value={draft.assistantBubbleColor}
            onChange={(v) => setDraft({ ...draft, assistantBubbleColor: v })} />
        </div>

        {/* 미리보기 */}
        <div className="mt-4 p-4 bg-zinc-950 rounded border border-zinc-800 space-y-2">
          <div className="flex justify-end">
            <div className="max-w-[70%] rounded-lg px-3 py-2 text-sm text-white" style={{ background: draft.userBubbleColor }}>
              미리보기 — 사용자 메시지
            </div>
          </div>
          <div className="flex justify-start">
            <div className="max-w-[70%] rounded-lg px-3 py-2 text-sm text-zinc-200 border border-zinc-800" style={{ background: draft.assistantBubbleColor }}>
              미리보기 — 에이전트 응답입니다.
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
          {save.isPending ? '저장 중...' : '저장'}
        </button>
        {dirty && (
          <button
            onClick={() => setDraft({ ...DEFAULT_APPEARANCE, ...(server ?? {}) })}
            className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm"
          >
            되돌리기
          </button>
        )}
        <button
          onClick={() => setDraft(DEFAULT_APPEARANCE)}
          className="px-4 py-2 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 text-sm ml-auto"
        >
          기본값
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
