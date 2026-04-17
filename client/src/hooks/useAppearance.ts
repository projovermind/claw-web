import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface Appearance {
  appName: string;
  theme: 'dark' | 'light' | 'system';
  userBubbleColor: string;
  assistantBubbleColor: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  appName: 'Claw Web',
  theme: 'dark',
  userBubbleColor: '#3f3f46',
  assistantBubbleColor: '#18181b'
};

/**
 * 전역 외관 설정 훅.
 *
 * - 서버 settings 에서 appearance 읽어옴
 * - 테마 → document.documentElement 의 class 토글 (light/dark)
 * - 버블 색상 → CSS variable 로 주입 (index.css 에서 --user-bubble / --assistant-bubble 로 참조)
 * - 앱 이름 → title + 반환값으로 렌더 컴포넌트가 직접 사용
 *
 * App 최상위에서 1회 호출.
 */
export function useAppearance(): Appearance {
  const { data } = useQuery({
    queryKey: ['settings-appearance'],
    queryFn: api.getSettings,
    refetchOnWindowFocus: false,
    staleTime: 30_000
  });

  const raw = (data as { appearance?: Partial<Appearance> } | undefined)?.appearance ?? {};
  const appearance: Appearance = { ...DEFAULT_APPEARANCE, ...raw };

  useEffect(() => {
    const root = document.documentElement;
    // 테마 class 처리
    const apply = (theme: 'dark' | 'light') => {
      root.classList.toggle('dark', theme === 'dark');
      root.classList.toggle('light', theme === 'light');
    };
    if (appearance.theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches ? 'dark' : 'light');
      const onChange = (e: MediaQueryListEvent) => apply(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    apply(appearance.theme);
  }, [appearance.theme]);

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
