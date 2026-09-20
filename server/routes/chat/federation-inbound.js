import { logger } from '../../lib/logger.js';
import { postCallback } from '../../lib/federation-client.js';
import { extractEscalation } from './delegation.js';

/**
 * 연합의 **remote 측** — 다른 인스턴스가 건 위임을 받아 여기서 워커를 띄우고,
 * 그 워커가 끝나면 결과를 origin 에 콜백으로 되돌려준다.
 *
 * remote 쪽에는 delegation-tracker 레코드를 만들지 **않는다.** 트래커 엔트리는
 * `originSessionId` 에 보고 턴을 여는 것을 전제로 하는데 여기엔 그 세션이 없다.
 * 대신 세션 id → 콜백 정보를 들고 있다가 `chat.done` 에서 쏜다.
 */

/** 회신 본문 상한 — 원문 전체를 그대로 실어 네트워크를 막지 않도록 자른다. */
const MAX_RESULT_CHARS = 100_000;

const INTERRUPT_MARKER = '(응답이 중단되었습니다)';

export function createFederationInbound(ctx) {
  const { sessionsStore, configStore, eventBus, instancesStore } = ctx;

  // remoteSessionId → { delegationId, callbackUrl, originInstance, task }
  const pending = new Map();

  /**
   * 콜백 주소가 믿을 만한가. 그 origin 을 인스턴스로 등록해 뒀다면 등록된
   * baseUrl 과 오리진이 같아야 한다 — 인증을 통과한 요청이 임의의 주소로
   * 우리 서버를 대신 찌르게 만들 수는 없다.
   */
  function validateCallbackUrl(callbackUrl, originInstance) {
    let parsed;
    try { parsed = new URL(callbackUrl); } catch { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const registered = instancesStore?.getInstance?.(originInstance)?.baseUrl;
    if (!registered) return true;
    try {
      return new URL(registered).origin === parsed.origin;
    } catch {
      return false;
    }
  }

  /** origin 에 되돌려 보낼 때 쓸 토큰. 등록된 아웃바운드 토큰이 우선. */
  function callbackToken(originInstance) {
    const raw = instancesStore?.getRaw?.() ?? {};
    return raw.instances?.[originInstance]?.token ?? raw.inboundTokens?.[originInstance] ?? null;
  }

  async function acceptRemoteDelegation({
    delegationId, agent, task, tier = null, originLabel = null, callbackUrl, originInstance
  }) {
    if (!delegationId || !agent || !task || !callbackUrl) {
      return { accepted: false, status: 400, error: 'invalid_payload' };
    }
    if (!validateCallbackUrl(callbackUrl, originInstance)) {
      return { accepted: false, status: 400, error: 'invalid_callback' };
    }

    const targetAgentId = ctx.resolveAgentId?.(agent) ?? null;
    if (!targetAgentId) {
      logger.warn({ agent, originInstance }, 'federation: 모르는 에이전트로 위임이 들어옴 — 거절');
      return { accepted: false, status: 404, error: 'unknown_agent' };
    }
    if (ctx.hasAgentCapacity && !ctx.hasAgentCapacity(targetAgentId)) {
      return { accepted: false, status: 429, error: 'no_capacity' };
    }

    const tierOverride = ctx.resolveOverrideTier?.(tier, targetAgentId) ?? null;
    const session = await sessionsStore.create({
      agentId: targetAgentId,
      title: `[원격위임] ${task.slice(0, 40)}`,
      isDelegation: true,
      modelTierOverride: tierOverride
    });
    eventBus?.publish('session.created', { session });

    pending.set(session.id, { delegationId, callbackUrl, originInstance, task });

    const header = `[원격 위임 — ${originLabel ?? originInstance}]`;
    const fullTask = `${header}\n\n${task}`;
    await sessionsStore.appendMessage(session.id, { role: 'user', content: fullTask });
    ctx.dispatch(session.id, { kind: 'task', content: fullTask });

    logger.info(
      { delegationId, originInstance, targetAgentId, remoteSessionId: session.id, tier: tierOverride },
      'federation: 원격 위임 접수 — 워커 스폰'
    );
    return {
      accepted: true,
      remoteSessionId: session.id,
      remoteInstance: instancesStore?.getSelfId?.() ?? 'self'
    };
  }

  /** 워커가 끝났다 — origin 에 결과를 쏜다. 배달은 백그라운드(재시도 포함). */
  function settle(sessionId, status, text) {
    const info = pending.get(sessionId);
    if (!info) return;
    pending.delete(sessionId);

    const token = callbackToken(info.originInstance);
    if (!token) {
      logger.warn({ ...info }, 'federation: origin 토큰이 없어 콜백을 보낼 수 없음');
      return;
    }
    const result = String(text ?? '').slice(0, MAX_RESULT_CHARS);
    const body = {
      delegationId: info.delegationId,
      status,
      result,
      remoteSessionId: sessionId,
      escalate: extractEscalation(result)?.reason ?? null
    };
    postCallback({
      callbackUrl: info.callbackUrl,
      token,
      originId: instancesStore?.getSelfId?.() ?? 'self',
      body
    }).then((r) => {
      if (r.delivered) {
        logger.info({ delegationId: info.delegationId, attempts: r.attempts, status }, 'federation: 콜백 배달 완료');
      } else {
        logger.error(
          { delegationId: info.delegationId, attempts: r.attempts, error: r.error },
          'federation: 콜백 3회 실패 — 포기 (origin 의 스톨 스윕이 회수)'
        );
      }
    }).catch((err) => {
      logger.error({ err: err.message, delegationId: info.delegationId }, 'federation: 콜백 배달 중 예외');
    });
  }

  const unsubscribe = eventBus?.subscribe(({ topic, payload }) => {
    const sessionId = payload?.sessionId;
    if (!sessionId || !pending.has(sessionId)) return;
    if (topic === 'chat.done') {
      const text = String(payload.text ?? '');
      // 중단 마커만 남고 본문이 없으면 완료가 아니다 — 완료로 보고하면 리드가
      // 실패를 성공으로 읽고 다음 단계로 넘어간다.
      const partial = text.replace(INTERRUPT_MARKER, '').trim();
      settle(sessionId, partial ? 'completed' : 'abandoned', text);
    } else if (topic === 'chat.error') {
      settle(sessionId, 'failed', `Error: ${payload.error ?? 'unknown'}`);
    } else if (topic === 'chat.aborted') {
      settle(sessionId, 'abandoned', '원격 워커가 중단되었습니다.');
    }
  });

  return {
    acceptRemoteDelegation,
    /** 테스트/셧다운용 — 대기 중인 콜백 수 */
    pendingRemoteCount: () => pending.size,
    closeFederationInbound: () => unsubscribe?.()
  };
}
