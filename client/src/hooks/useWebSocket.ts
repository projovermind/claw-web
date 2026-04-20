import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWsStore } from '../store/ws-store';
import { useChatStore } from '../store/chat-store';
import { useToastStore } from '../store/toast-store';
import { useDelegationStore } from '../store/delegation-store';
import { getAuthToken, api } from '../lib/api';
import { useT } from '../lib/i18n';
import { playDing, playWarn } from '../lib/sound';

const TOPICS_TO_INVALIDATE: Record<string, string[]> = {
  'agent.updated': ['agents'],
  'agents.refreshed': ['agents'],
  'metadata.refreshed': ['agents'],
  'project.created': ['projects'],
  'project.updated': ['projects'],
  'project.deleted': ['projects'],
  'projects.refreshed': ['projects'],
  'session.created': ['sessions'],
  'session.updated': ['sessions'],
  'session.deleted': ['sessions'],
  'sessions.refreshed': ['sessions'],
  'skill.created': ['skills', 'activity'],
  'skill.updated': ['skills', 'activity'],
  'skill.deleted': ['skills', 'activity'],
  'skill.bulkAssign': ['skills', 'agents', 'activity'],
  'skill.bulkUnassign': ['skills', 'agents', 'activity'],
  'skills.refreshed': ['skills'],
  'agent.created': ['agents', 'activity'],
  'agent.deleted': ['agents', 'activity'],
  'agent.cloned': ['agents', 'activity'],
  'upload.created': ['activity'],
  'upload.deleted': ['activity'],
  'settings.updated': ['settings', 'activity'],
  'backends.updated': ['backends', 'activity'],
  // Ralph Loop events → refetch session so the loop status banner updates
  'session.loop.started': ['sessions'],
  'session.loop.iteration': ['sessions'],
  'session.loop.completed': ['sessions'],
  'session.loop.escalated': ['sessions'],
  'session.loop.stopped': ['sessions'],
  // Delegation events
  'delegation.started': ['sessions'],
  'delegation.completed': ['sessions']
};

export function useWebSocket() {
  const queryClient = useQueryClient();
  const setState = useWsStore((s) => s.setState);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  // t 는 현재 언어에 바인딩 — ref 로 보관해서 effect 재실행 방지
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      setState('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = getAuthToken();
      const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws${suffix}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setState('open');
        // 재연결 시 서버에서 active 목록 다시 로드 (새로고침 후 hydrate)
        if (retryRef.current > 0) {
          api.delegations()
            .then((entries) => useDelegationStore.getState().hydrate(entries))
            .catch(() => useDelegationStore.getState().clearStale());
        }
        retryRef.current = 0;
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { type: string; [k: string]: unknown };
          const topic = msg.type;

          // Chat events → dispatch into chat store (DO NOT invalidate agents/sessions queries mid-stream)
          if (topic === 'chat.started') {
            const sid = msg.sessionId as string;
            // Invalidate session so other clients see the user message immediately
            queryClient.invalidateQueries({ queryKey: ['session', sid] });
            useChatStore.getState().startRun(sid);
            return;
          }
          if (topic === 'chat.chunk') {
            useChatStore.getState().appendChunk(msg.sessionId as string, (msg.text as string) ?? '');
            return;
          }
          if (topic === 'chat.tool') {
            const tool = msg.tool as { name: string; input: Record<string, unknown> };
            if (tool) useChatStore.getState().addToolCall(msg.sessionId as string, tool);
            return;
          }
          if (topic === 'chat.done') {
            const sid = msg.sessionId as string;
            // refetchQueries 로 실제 데이터가 돌아올 때까지 기다린 후 streaming 클리어
            // → 최종 메시지가 MessageList에 반영된 뒤 StreamingMessage가 사라짐 (공백 없음)
            const timeout = new Promise<void>(resolve => setTimeout(resolve, 4000));
            Promise.race([
              queryClient.refetchQueries({ queryKey: ['session', sid] }),
              timeout
            ]).finally(() => {
              useChatStore.getState().finishRun(sid, null);
            });
            queryClient.invalidateQueries({ queryKey: ['sessions'] });
            // 띠링 알림음 — settings 캐시에서 enabled/volume 읽음
            try {
              const settings = queryClient.getQueryData<{ appearance?: { soundEnabled?: boolean; soundVolume?: number } }>(['settings-appearance']);
              const ap = settings?.appearance;
              if (ap?.soundEnabled !== false) {
                playDing(ap?.soundVolume ?? 0.2);
              }
            } catch { /* ignore */ }
            return;
          }
          if (topic === 'chat.error') {
            useChatStore.getState().finishRun(msg.sessionId as string, (msg.error as string) ?? 'error');
            // 에러 알림음 (띠-리-ㅇ 두번)
            try {
              const settings = queryClient.getQueryData<{ appearance?: { soundEnabled?: boolean; soundVolume?: number } }>(['settings-appearance']);
              const ap = settings?.appearance;
              if (ap?.soundEnabled !== false) {
                playWarn(ap?.soundVolume ?? 0.2);
              }
            } catch { /* ignore */ }
            return;
          }
          if (topic === 'chat.exit' || topic === 'chat.aborted') {
            // chat.error가 먼저 왔으면 에러 메시지 유지 (exit가 덮어쓰지 않음)
            const sid = msg.sessionId as string;
            const existing = useChatStore.getState().runtime[sid];
            if (!existing?.error) {
              useChatStore.getState().finishRun(sid, null);
            }
            return;
          }

          // Toast notifications for loop & error events
          if (topic === 'session.loop.completed') {
            const iterations = (msg.iterations as number) ?? 0;
            useToastStore.getState().add('success', tRef.current('ws.loopDone', { n: iterations }));
          }
          if (topic === 'session.loop.escalated') {
            const reason = (msg.reason as string) ?? tRef.current('ws.escalateDefault');
            useToastStore.getState().add('warning', tRef.current('ws.escalate', { reason }));
          }
          if (topic === 'chat.error') {
            const errMsg = (msg.error as string) ?? 'error';
            useToastStore.getState().add('error', tRef.current('ws.chatError', { error: errMsg }));
          }
          if (topic === 'delegation.started') {
            const agent = (msg.targetAgentId as string) ?? '?';
            useToastStore.getState().add('info', tRef.current('ws.delegateStart', { agent }));
            useDelegationStore.getState().add({
              id: msg.id as string,
              originSessionId: msg.originSessionId as string,
              targetSessionId: msg.targetSessionId as string,
              targetAgentId: msg.targetAgentId as string,
              task: (msg.task as string) ?? ''
            });
            // 위임 시작 — origin 세션의 unread 억제 (위임 완료 시에 표시)
            useChatStore.getState().startDelegating(msg.originSessionId as string);
          }
          if (topic === 'delegation.completed') {
            const agent = (msg.targetAgentId as string) ?? '?';
            useToastStore.getState().add('success', tRef.current('ws.delegateDone', { agent }));
            useDelegationStore.getState().complete(msg.id as string);
            // 위임 완료 — origin 세션에 unread 표시 (현재 열려있지 않은 경우)
            useChatStore.getState().finishDelegating(msg.originSessionId as string);
          }

          // Generic query invalidation for non-chat events
          const keys = TOPICS_TO_INVALIDATE[topic];
          if (keys) {
            for (const k of keys) queryClient.invalidateQueries({ queryKey: [k] });
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        setState('closed');
        if (cancelled) return;
        const delay = Math.min(30_000, 1000 * 2 ** retryRef.current);
        retryRef.current += 1;
        setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [queryClient, setState]);
}
