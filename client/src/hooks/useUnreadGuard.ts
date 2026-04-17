import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useChatStore } from '../store/chat-store';
import type { Session } from '../lib/types';

/**
 * 전역 unread 무결성 가드.
 *
 * - 어느 페이지에 있든 백그라운드로 세션 리스트를 폴링
 * - 존재하지 않는 세션 ID (삭제 등) 의 unread 를 purge
 * - 이전 버그: ChatSidebar 안에서만 정리했어서 채팅 페이지 밖에서는
 *   유령 unread 가 영구 잔존 → 레이아웃 Sidebar 내비 도트가 항상 켜져있음
 *
 * 이 hook 은 App 최상위에서 한 번만 호출되어야 함.
 */
export function useUnreadGuard() {
  const { data } = useQuery<{ sessions: Session[] }>({
    queryKey: ['sessions-all'],
    queryFn: api.allSessions,
    refetchInterval: 5000
  });
  const purgeUnread = useChatStore((s) => s.purgeUnread);

  useEffect(() => {
    if (!data?.sessions) return;
    const validIds = new Set(data.sessions.map((s) => s.id));
    purgeUnread(validIds);
  }, [data, purgeUnread]);
}
