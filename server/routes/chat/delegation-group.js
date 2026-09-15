import { logger } from '../../lib/logger.js';

/**
 * 한 턴에 여러 건을 발주한 위임의 결과 배리어.
 *
 * 위임이 끝날 때마다 플래너 세션에 보고 턴이 하나씩 열리면, 3건을 병렬로 던진
 * 플래너는 1/3 만 보고 다음 계획을 세우고 → 2/3 에서 또 세우고 → 3/3 에서 또 센다.
 * 중간 턴은 정보가 모자란 채 판단하므로 대부분 폐기되고 토큰만 태운다.
 *
 * 그래서 같은 턴에서 나온 위임 N(≥2)건에 공통 groupId 를 붙이고, 멤버 전원이
 * settle(완료/실패/중단) 될 때까지 보고를 모아 뒀다가 한 턴으로 합쳐 전달한다.
 * 단건 위임은 그룹을 만들지 않으므로 기존과 똑같이 즉시 보고된다.
 *
 * 그룹 상태:
 *   planned  — 아직 트래커에 등록(attach)도 취소(drop)도 되지 않은 슬롯 수.
 *              대기열에 들어간 위임이 여기 남아 있어야 배리어가 먼저 닫히지 않는다.
 *   members  — 실행 중인 멤버 (delegationId → { entry, seq })
 *   settled  — 결과가 도착한 멤버 (발주 순서로 정렬해 보고)
 *
 * 배리어는 planned === 0 && members.size === 0 일 때 닫힌다. 워커가 영영 돌아오지
 * 않는 경우를 대비해 타임아웃이 있고, 그때는 도착한 것만 부분 보고한다.
 * 부분 보고 후 뒤늦게 끝난 멤버는 그룹이 이미 사라졌으므로 개별 보고로 돌아간다.
 */

/** 전원 도착을 기다리는 최대 시간. 넘으면 도착한 것만 부분 보고한다. */
const GROUP_TIMEOUT_MS = 30 * 60_000;

const STATUS_LABEL = {
  completed: '✅ 완료',
  aborted: '⛔ 중단',
  failed: '❌ 실패'
};

const TAIL_INSTRUCTION =
  `위 결과를 바탕으로 계획을 계속 진행하세요. ` +
  `다음 위임할 작업이 있으면 즉시 위임 JSON을 출력하세요. ` +
  `사용자에게 확인받거나 choices 태그로 질문하지 말고 자동으로 계속 진행하세요. ` +
  `모든 작업이 완료됐을 때만 최종 결과를 사용자에게 보고하세요.`;

export function createDelegationGroups(ctx) {
  const { sessionsStore, eventBus } = ctx;
  const groups = new Map(); // groupId → group
  let idCounter = 0;

  const timeoutMs = () => Number(ctx.groupTimeoutMs) || GROUP_TIMEOUT_MS;

  function armTimeout(group) {
    const timer = setTimeout(() => {
      group.timer = null;
      logger.warn(
        { groupId: group.id, settled: group.settled.length, waiting: group.members.size, planned: group.planned },
        'delegation group: barrier timed out — reporting partial results'
      );
      flush(group.id, { partial: true }).catch((err) =>
        logger.warn({ err: err?.message, groupId: group.id }, 'delegation group: partial flush failed')
      );
    }, timeoutMs());
    timer.unref?.();
    group.timer = timer;
  }

  /**
   * 한 턴에서 나온 위임 묶음을 연다. size < 2 면 그룹을 만들지 않고 null 을
   * 돌려준다 — 단건은 배리어가 순수 지연이기만 하다.
   */
  function openGroup(originSessionId, size) {
    if (!originSessionId || !(size > 1)) return null;
    const id = `grp_${++idCounter}_${Date.now().toString(36)}`;
    const group = {
      id,
      originSessionId,
      size,
      planned: size,
      seq: 0,
      members: new Map(),
      settled: [],
      timer: null
    };
    groups.set(id, group);
    armTimeout(group);
    logger.info({ groupId: id, originSessionId, size }, 'delegation group: opened');
    eventBus?.publish?.('delegation.group.started', { groupId: id, originSessionId, size });
    return id;
  }

  /** 트래커에 등록된 멤버를 그룹에 붙인다. */
  function attachMember(groupId, entry) {
    const group = groups.get(groupId);
    if (!group || !entry) return false;
    entry.groupId = groupId;
    group.planned = Math.max(0, group.planned - 1);
    group.members.set(entry.id, { entry, seq: group.seq++ });
    return true;
  }

  /**
   * 멤버가 되지 못한 슬롯을 지운다(잘못된 에이전트 ID, 깊이 초과, 발주 중 예외).
   * 이걸 빼먹으면 배리어가 영영 닫히지 않고 타임아웃까지 보고가 묶인다.
   */
  function dropSlot(groupId, reason = 'not-dispatched') {
    const group = groups.get(groupId);
    if (!group) return false;
    group.planned = Math.max(0, group.planned - 1);
    logger.info({ groupId, reason, planned: group.planned }, 'delegation group: slot dropped');
    maybeClose(group);
    return true;
  }

  function isClosed(group) {
    return group.planned === 0 && group.members.size === 0;
  }

  function maybeClose(group) {
    if (!isClosed(group)) return;
    if (!group.settled.length) {
      // 전원이 발주 단계에서 탈락했다 — 보고할 결과가 없다. 실패 안내는
      // reportUndeliveredTasks 가 따로 처리하므로 여기서는 그룹만 치운다.
      closeGroup(group);
      logger.info({ groupId: group.id }, 'delegation group: closed with no members');
      return;
    }
    flush(group.id, { partial: false }).catch((err) =>
      logger.warn({ err: err?.message, groupId: group.id }, 'delegation group: flush failed')
    );
  }

  function closeGroup(group) {
    if (group.timer) clearTimeout(group.timer);
    group.timer = null;
    groups.delete(group.id);
  }

  /**
   * 멤버 하나의 결과를 모은다. 그룹에 속한 멤버면 true 를 돌려주고, 호출자는
   * 개별 보고를 보내지 않는다. 그룹이 없거나 이미 닫혔으면 false — 기존처럼
   * 즉시 보고한다.
   */
  function collectReport(entry, { status = 'completed', body = '' } = {}) {
    if (!entry?.groupId) return false;
    const group = groups.get(entry.groupId);
    if (!group) return false;
    const member = group.members.get(entry.id);
    if (!member) return false;

    group.members.delete(entry.id);
    group.settled.push({ entry, status, body, seq: member.seq });
    logger.info(
      { groupId: group.id, delegationId: entry.id, status, settled: group.settled.length, waiting: group.members.size },
      'delegation group: member settled — holding report'
    );
    maybeClose(group);
    return true;
  }

  function renderBlock(item, index, total) {
    const label = STATUS_LABEL[item.status] ?? item.status;
    return `## ${index + 1}/${total} ${label} — ${item.entry.targetAgentId}\n\n${item.body}`;
  }

  function buildContent(group, { partial }) {
    const done = [...group.settled].sort((a, b) => a.seq - b.seq);
    const outstanding = [...group.members.values()].sort((a, b) => a.seq - b.seq);
    const total = done.length + outstanding.length;

    const header = partial
      ? `[위임 결과 보고 — ${group.size}건 중 ${done.length}건 도착, ${outstanding.length}건 미도착]`
      : `[위임 결과 보고 — 같은 턴에 발주한 ${done.length}건 일괄]`;

    const intro = partial
      ? `함께 발주한 위임 중 일부가 제한 시간 안에 끝나지 않았습니다. 도착한 결과만 먼저 전달합니다.`
      : `함께 발주한 위임이 모두 끝났습니다. 아래 ${done.length}건을 한꺼번에 검토하고 다음 단계를 판단하세요.`;

    const sections = done.map((item, i) => renderBlock(item, i, total));

    if (outstanding.length) {
      sections.push(
        `## 미도착 ${outstanding.length}건 (아직 실행 중)\n\n` +
        outstanding.map((m) => `- \`${m.entry.targetAgentId}\`: ${m.entry.task}`).join('\n') +
        `\n\n이 작업들은 완료되지 않았습니다. 끝나는 대로 따로 보고됩니다. ` +
        `지금 판단할 수 없으면 도착한 결과만으로 진행 가능한 부분을 먼저 처리하세요.`
      );
    }

    return `${header}\n\n${intro}\n\n${sections.join('\n\n---\n\n')}\n\n${TAIL_INSTRUCTION}`;
  }

  /**
   * 모인 결과를 원 세션에 한 턴으로 전달한다. 재진입 카운터는 그룹당 1회만
   * 올린다 — 멤버 수만큼 세면 병렬 위임을 쓸수록 한계에 빨리 닿는다.
   */
  async function deliver(originSessionId, content, meta) {
    const count = (ctx.reEntryCounters?.get(originSessionId) ?? 0) + 1;
    if (ctx.MAX_REENTRY && count > ctx.MAX_REENTRY) {
      logger.warn({ originSessionId, count, ...meta }, 'delegation group: re-entry limit exceeded — not resuming planner');
      await sessionsStore.appendMessage(originSessionId, {
        role: 'assistant',
        content: `⚠️ **위임 자동 진행 한계 도달** (${count - 1}/${ctx.MAX_REENTRY}회) — 무한 루프 방지를 위해 자동 진행을 중단합니다. 다음 단계를 직접 지시해 주세요.`
      }).catch(() => {});
      return;
    }
    ctx.reEntryCounters?.set(originSessionId, count);
    await sessionsStore.appendMessage(originSessionId, { role: 'user', content });
    ctx.dispatch(originSessionId, { kind: 'report', content });
  }

  async function flush(groupId, { partial = false } = {}) {
    const group = groups.get(groupId);
    if (!group) return false;
    closeGroup(group);
    if (!group.settled.length) return false;

    const content = buildContent(group, { partial });
    logger.info(
      { groupId, originSessionId: group.originSessionId, reported: group.settled.length, partial },
      'delegation group: delivering combined report'
    );
    eventBus?.publish?.('delegation.group.completed', {
      groupId,
      originSessionId: group.originSessionId,
      reported: group.settled.length,
      outstanding: group.members.size,
      partial
    });
    try {
      await deliver(group.originSessionId, content, { groupId });
    } catch (err) {
      logger.warn({ err: err?.message, groupId }, 'delegation group: delivery failed');
      return false;
    }
    return true;
  }

  /** 디버깅/테스트용 — 열려 있는 그룹 수. */
  function groupCount() {
    return groups.size;
  }

  function stopGroups() {
    for (const group of groups.values()) if (group.timer) clearTimeout(group.timer);
    groups.clear();
  }

  return {
    openDelegationGroup: openGroup,
    attachGroupMember: attachMember,
    dropGroupSlot: dropSlot,
    collectGroupReport: collectReport,
    flushDelegationGroup: flush,
    delegationGroupCount: groupCount,
    stopGroups
  };
}
