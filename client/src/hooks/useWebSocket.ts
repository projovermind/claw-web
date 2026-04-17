import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWsStore } from '../store/ws-store';
import { useChatStore } from '../store/chat-store';
import { useToastStore } from '../store/toast-store';
import { getAuthToken } from '../lib/api';
import { useT } from '../lib/i18n';

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
        retryRef.current = 0;
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { type: string; [k: string]: unknown };
          const topic = msg.type;

          // Chat events → dispatch into chat store (DO NOT invalidate agents/sessions queries mid-stream)
          if (topic === 'chat.started') {
            useChatStore.getState().startRun(msg.sessionId as string);
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
            // Refetch FIRST so sessionQ.data has the persisted assistant
            // message in cache, then clear the streaming state. This avoids
            // the double-render where both the streaming bubble and the
            // newly-fetched persisted bubble were visible at the same time.
            queryClient
              .invalidateQueries({ queryKey: ['session', sid] })
              .finally(() => {
                useChatStore.getState().finishRun(sid, null);
              });
            queryClient.invalidateQueries({ queryKey: ['sessions'] });
            return;
          }
          if (topic === 'chat.error') {
            useChatStore.getState().finishRun(msg.sessionId as string, (msg.error as string) ?? 'error');
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
          }
          if (topic === 'delegation.completed') {
            const agent = (msg.targetAgentId as string) ?? '?';
            useToastStore.getState().add('success', tRef.current('ws.delegateDone', { agent }));
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
