import { logger } from '../../lib/logger.js';
import { normalizeTiers } from '../../lib/model-tiers.js';
import { extractEscalation, buildEscalationNotice, formatTierLine } from './delegation.js';
import { extractDelegationSummary } from './message-sender.js';

/**
 * 원격 워커의 **완료** 회신을 리드에게 전달한다.
 *
 * 로컬 워커가 끝났을 때 `message-sender.js` 가 하는 것과 같은 일을 한다:
 * 원문 저장 → 요약 추출 → 에스컬레이션 판정 → 트래커 complete → 그룹 배리어 →
 * 원 세션에 보고 턴. 리드 입장에서 로컬 워커와 구분되지 않아야 하므로 문구와
 * 순서를 그대로 따른다(뱃지에 원격 인스턴스만 덧붙는다).
 */
export function createRemoteReport(ctx) {
  const { sessionsStore, configStore, eventBus, delegationTracker, pushStore, backendsStore } = ctx;

  async function reportRemoteCompletion({ entry, result, escalate = null }) {
    const fullText = String(result ?? '');
    const reportPath = delegationTracker.saveFullReport(entry.targetSessionId, fullText);
    const extracted = extractDelegationSummary(fullText);
    const summary = extracted.summary || '(응답 없음)';
    const sourceNote = reportPath
      ? `**전체 응답 원문**: ${reportPath}\n(요약에 없는 세부사항이 필요하면 이 파일을 Read 하세요)\n`
      : '';
    const truncationWarning = extracted.structured
      ? ''
      : `⚠️ 워커가 <report> 블록을 출력하지 않아 아래 요약은 응답의 앞뒤만 잘라낸 것입니다 — 중간 내용이 빠져 있으니 판단 전에 원문을 확인하세요.\n`;

    // remote 가 escalate 필드를 채워 보냈으면 그것을 믿고, 없으면 원문에서 뽑는다
    // (구현이 다른 인스턴스와도 맞물려야 한다).
    const escalation = escalate ? { reason: escalate } : extractEscalation(fullText);
    const completed = delegationTracker.complete(entry.targetSessionId, summary, reportPath, !!escalation);
    if (!completed) return { ok: false, error: 'already_settled' };

    const escalationNotice = escalation
      ? buildEscalationNotice({
          reason: escalation.reason,
          tier: completed.tier ?? null,
          order: normalizeTiers(backendsStore?.getRaw?.()?.tiers).order
        }) + '\n\n'
      : '';
    const tierLine = formatTierLine(completed);
    const hostLine = `**실행 기계**: \`${completed.remoteInstance}\`${completed.remoteSessionId ? ` (원격 세션 ${completed.remoteSessionId})` : ''}\n`;
    ctx.dequeueNextAgent(completed.targetAgentId);

    const reportBody =
      `**작업**: ${completed.task}\n` +
      hostLine +
      tierLine +
      sourceNote +
      truncationWarning +
      (escalationNotice ? `\n${escalationNotice}` : '') +
      `\n**결과**:\n${summary}`;
    const heldForGroup = ctx.collectGroupReport?.(completed, { status: 'completed', body: reportBody }) ?? false;

    await sessionsStore.appendMessage(completed.originSessionId, {
      role: 'assistant',
      content: `${escalation ? '🚨' : '✅'} **원격 위임 ${escalation ? '에스컬레이션' : '완료'}** — ${completed.targetAgentId} @ ${completed.remoteInstance}\n\n${reportBody}`
    });
    eventBus.publish('delegation.completed', {
      id: completed.id,
      originSessionId: completed.originSessionId,
      targetSessionId: completed.targetSessionId,
      targetAgentId: completed.targetAgentId,
      remoteInstance: completed.remoteInstance
    });
    if (pushStore) {
      const agentName = configStore.getAgent(completed.targetAgentId)?.name || completed.targetAgentId;
      pushStore.sendPushToAll(
        `${agentName} 원격 위임 완료`,
        completed.task?.slice(0, 80) || '위임된 작업이 완료되었습니다.',
        { url: `/chat?session=${encodeURIComponent(completed.originSessionId)}` }
      ).catch(() => {});
    }

    if (heldForGroup) {
      logger.info(
        { originSessionId: completed.originSessionId, groupId: completed.groupId },
        'federation: 회신을 그룹 배리어가 붙잡음'
      );
      return { ok: true, status: 'completed', held: true };
    }

    const reEntryCount = (ctx.reEntryCounters.get(completed.originSessionId) ?? 0) + 1;
    if (reEntryCount > ctx.MAX_REENTRY) {
      logger.warn({ originSessionId: completed.originSessionId, reEntryCount }, 'federation: 재진입 한도 초과 — 자동 진행 중단');
      await sessionsStore.appendMessage(completed.originSessionId, {
        role: 'assistant',
        content: `⚠️ **위임 자동 진행 한계 도달** (${reEntryCount - 1}/${ctx.MAX_REENTRY}회) — 무한 루프 방지를 위해 자동 진행을 중단합니다. 다음 단계를 직접 지시해 주세요.`
      });
      return { ok: true, status: 'completed', reEntryBlocked: true };
    }

    ctx.reEntryCounters.set(completed.originSessionId, reEntryCount);
    const trigger =
      `[원격 위임 ${escalation ? '에스컬레이션' : '결과 보고'}]\n\n` +
      `**대상 에이전트**: ${completed.targetAgentId}\n` +
      hostLine +
      `**작업**: ${completed.task}\n` +
      tierLine +
      sourceNote +
      truncationWarning +
      (escalationNotice ? `\n${escalationNotice}` : '') +
      `\n**결과**:\n${summary}\n\n` +
      `위 결과를 바탕으로 계획을 계속 진행하세요. ` +
      `원격 기계의 파일은 여기에 없습니다 — 필요하면 푸시된 브랜치를 가져오세요. ` +
      `다음 위임할 작업이 있으면 즉시 위임 JSON을 출력하세요. ` +
      `사용자에게 확인받거나 choices 태그로 질문하지 말고 자동으로 계속 진행하세요. ` +
      `모든 작업이 완료됐을 때만 최종 결과를 사용자에게 보고하세요.`;
    await sessionsStore.appendMessage(completed.originSessionId, { role: 'user', content: trigger });
    ctx.dispatch(completed.originSessionId, { kind: 'report', content: trigger });
    return { ok: true, status: 'completed' };
  }

  return { reportRemoteCompletion };
}
