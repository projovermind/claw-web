import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface Appearance {
  appName: string;
  userBubbleColor: string;
  assistantBubbleColor: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  appName: 'Claw Web',
  userBubbleColor: '#3f3f46',
  assistantBubbleColor: '#18181b'
};

/**
 * 전역 외관 설정 훅.
 *
 * - 서버 settings 에서 appearance 읽어옴
 * - 버블 색상 → CSS variable 로 주입 (index.css 에서 --user-bubble / --assistant-bubble 로 참조)
 * - 앱 이름 → title + 반환값으로 렌더 컴포넌트가 직접 사용
 *
 * App 최상위에서 1회 호출.
 */
export function useAppearance(): Appearance {
  // v1.1.0~v1.1.1 의 테마 토글이 html 에 남긴 잔여 클래스 제거 (마운트 1회)
  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark');
  }, []);

  const { data } = useQuery({
    queryKey: ['settings-appearance'],
    queryFn: api.getSettings,
    refetchOnWindowFocus: false,
    staleTime: 30_000
  });

  const raw = (data as { appearance?: Partial<Appearance> } | undefined)?.appearance ?? {};
  const appearance: Appearance = { ...DEFAULT_APPEARANCE, ...raw };

  useEffect(() => {
    // CSS 변수 주입 — TailwindCSS 클래스는 `bg-[var(--user-bubble)]` 로 참조
    const root = document.documentElement;
    root.style.setProperty('--user-bubble', appearance.userBubbleColor);
    root.style.setProperty('--assistant-bubble', appearance.assistantBubbleColor);
  }, [appearance.userBubbleColor, appearance.assistantBubbleColor]);

  useEffect(() => {
    document.title = appearance.appName;
  }, [appearance.appName]);

  return appearance;
}
