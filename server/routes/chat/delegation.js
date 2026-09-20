import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { buildRoster, listProjectAgentIds } from '../../lib/agent-roster.js';
import { normalizeTiers, nextHigherTier } from '../../lib/model-tiers.js';
import { buildHostGuide } from '../../lib/host-guide.js';
import { checkInstanceHealth, postDelegate, supportsFederation } from '../../lib/federation-client.js';
import { REUSE_TASK_PREFIX } from './worker-pool.js';

/**
 * Hard ceiling on delegation chain length (planner → worker → sub-worker).
 * Without it a worker can re-delegate indefinitely; each hop multiplies token
 * spend and there is no natural termination condition.
 */
const MAX_DELEGATION_DEPTH = 3;

/**
 * 워커가 결과를 남기지 못한 채 사라지면(크래시, 외부 kill, 디스패치 유실) chat.done
 * 이 끝내 오지 않아 트래커는 영원히 running 으로 남는다. 플래너는 오지 않을 보고를
 * 기다리고 대상 에이전트는 계속 busy 로 잡힌다. 주기적으로 훑어 정리한다.
 */
const SWEEP_INTERVAL_MS = 60_000;
const STALL_TIMEOUT_MS = 10 * 60_000;
/**
 * 원격 위임은 네트워크 왕복과 상대 인스턴스의 대기열까지 포함하므로 로컬보다
 * 훨씬 늦게 회신될 수 있다. 로컬과 같은 10분으로 자르면 멀쩡히 돌고 있는
 * 원격 워커를 중단 처리해 버린다.
 */
const REMOTE_STALL_TIMEOUT_MS = 45 * 60_000;

/**
 * 헬스 정보를 이 시간보다 오래 방치했으면 위임 직전에 다시 찍는다. 죽은 원격에
 * 발주해 놓고 pending 으로 남기는 것이 이 기능의 최악 실패 모드다.
 */
const HEALTH_STALE_MS = 60_000;

/**
 * 워커가 남긴 <escalate>이유</escalate> 를 뽑아낸다.
 *
 * 지금까지 이 태그는 Ralph Loop 위임에서만 해석됐다. 일반(단발) 위임에서 워커가
 * 막혀서 이 태그를 써도 리드에게는 그냥 결과 텍스트로 흘러갔고, 워커가 <report>
 * 블록까지 출력한 경우엔 요약 추출이 report 만 취하므로 **통째로 사라졌다**.
 * 그래서 요약이 아니라 항상 응답 원문에서 뽑는다.
 *
 * @returns {{ reason: string }|null}
 */
export function extractEscalation(text) {
  const m = /<escalate>([\s\S]*?)<\/escalate>/i.exec(text ?? '');
  if (!m) return null;
  return { reason: m[1].trim() || '(이유 없음)' };
}

/**
 * 에스컬레이션을 리드가 읽을 지시문으로 바꾼다. 핵심은 "같은 티어로 그대로
 * 재위임하지 말 것" — 같은 급으로 다시 던지면 같은 벽에 다시 부딪힌다.
 */
export function buildEscalationNotice({ reason, tier = null, order = [] }) {
  const up = tier ? nextHigherTier(order, tier) : null;
  const ranAt = tier ? `현재 실행 티어는 \`${tier}\` 입니다.` : '';
  const advice = up
    ? `같은 작업을 상위 티어로 다시 맡기려면 위임 JSON 에 \`"tier": "${up}"\` 를 넣으세요. 같은 티어(\`${tier}\`)로 그대로 재위임하지 마세요 — 같은 벽에 다시 부딪힙니다.`
    : `이미 최상위 티어입니다 — 티어를 올려 해결할 수 없습니다. 작업을 더 작게 쪼개 다시 위임하거나, 리드가 직접 처리하거나, 사용자에게 상황을 알리세요.`;
  return (
    `🚨 **워커가 에스컬레이션을 요청했습니다 — 이 작업은 끝나지 않았습니다.**\n` +
    `**막힌 이유**: ${reason}\n` +
    (ranAt ? `${ranAt} ` : '') + advice
  );
}

/** 회신에 실을 "실제로 어느 급으로 돌았는지" 한 줄. 알 수 없으면 빈 문자열. */
export function formatTierLine(entry) {
  if (!entry?.tier) return '';
  return `**실행 티어**: \`${entry.tier}\`${entry.tierOverridden ? ' (위임에서 지정)' : ' (에이전트 기본)'}\n`;
}

/**
 * Creates delegation-related handlers. All cross-module calls (ctx.dispatch)
 * are resolved lazily via ctx to allow circular wiring.
 */
export function createDelegation(ctx) {
  const {
    sessionsStore,
    configStore,
    eventBus,
    delegationTracker,
    pushStore,
    failureReEntryCounters,
    MAX_FAILURE_REENTRY
  } = ctx;

  /** Parse text for JSON blocks containing a "delegate" key. */
  function extractDelegateJson(text) {
    const results = [];
    const seen = new Set();
    const candidates = [];
    const codeBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    for (const cb of codeBlocks) candidates.push(cb[1]);
    candidates.push(text);

    for (const src of candidates) {
      let idx = src.indexOf('"delegate"');
      while (idx !== -1) {
        let start = src.lastIndexOf('{', idx);
        if (start === -1) { idx = src.indexOf('"delegate"', idx + 1); continue; }
        let depth = 0, end = -1, inString = false, prev = '';
        for (let i = start; i < src.length; i++) {
          const c = src[i];
          if (inString) {
            if (c === '"' && prev !== '\\') inString = false;
          } else {
            if (c === '"') inString = true;
            else if (c === '{') depth++;
            else if (c === '}') {
              depth--;
              if (depth === 0) { end = i; break; }
            }
          }
          prev = c;
        }
        if (end !== -1) {
          try {
            const obj = JSON.parse(src.slice(start, end + 1));
            if (obj?.delegate?.agent && obj?.delegate?.task) {
              const key = `${obj.delegate.agent}::${obj.delegate.task}`;
              if (!seen.has(key)) {
                seen.add(key);
                // "model" 은 폐기된 필드다 — 프롬프트가 광고만 하고 아무도 읽지
                // 않아 조용히 무시돼 왔다. 이제 "tier" 로 대체됐음을 남긴다.
                if (obj.delegate.model !== undefined) {
                  logger.warn(
                    { agent: obj.delegate.agent, model: obj.delegate.model },
                    'delegation: "model" 필드는 폐기됐습니다 — "tier" 를 쓰세요 (무시함)'
                  );
                }
                results.push(obj);
              }
            }
          } catch { /* ignore, try next */ }
        }
        idx = src.indexOf('"delegate"', idx + 1);
      }
    }
    return results;
  }

  async function handleDelegation(originSessionId, responseText) {
    if (!delegationTracker || !responseText) return;
    const parsed = extractDelegateJson(responseText);
    if (!parsed.length) return;
    const badIds = [];
    const depthBlocked = [];
    // 같은 턴에서 나온 위임 N(≥2)건은 하나의 그룹으로 묶어, 전원이 끝난 뒤
    // 한 턴으로 합쳐 보고한다. 단건이면 그룹 없이 기존대로 즉시 보고.
    const groupId = ctx.openDelegationGroup?.(originSessionId, parsed.length) ?? null;
    for (const p of parsed) {
      const res = await executeDelegation(
        originSessionId, p.delegate.agent, p.delegate.task, JSON.stringify(p), groupId, null, p.delegate.tier ?? null
      );
      if (res?.badId) badIds.push(res);
      else if (res?.depthExceeded) depthBlocked.push(res);
    }
    if (badIds.length || depthBlocked.length) {
      await reportUndeliveredTasks(originSessionId, badIds, depthBlocked);
    }
  }

  /** 원 세션 에이전트와 같은 프로젝트에 속한 위임 가능 대상 ID 목록. */
  function listDelegateTargets(originSessionId) {
    const originAgentId = sessionsStore.get(originSessionId)?.agentId ?? null;
    return listProjectAgentIds({
      agents: configStore.getAgents() || {},
      metadataStore: ctx.metadataStore,
      projectId: originAgentId ? ctx.metadataStore?.getAgent(originAgentId)?.projectId ?? null : null,
      excludeAgentId: originAgentId,
    });
  }

  function formatTargets(ids) {
    return buildRoster(
      ids,
      configStore.getAgents() || {},
      '- (같은 프로젝트에 다른 에이전트가 없습니다 — planner_office 등 범용 에이전트를 쓰세요)'
    );
  }

  /**
   * 전달되지 못한 위임을 플래너에게 되돌려준다. 되먹임이 없으면 플래너는 실패를
   * 모른 채 턴을 끝내고 위임한 작업이 통째로 사라진다.
   */
  async function reportUndeliveredTasks(originSessionId, badIds, depthBlocked) {
    const count = (failureReEntryCounters.get(originSessionId) ?? 0) + 1;
    if (count > MAX_FAILURE_REENTRY) {
      logger.warn({ originSessionId, count }, 'delegation: retry limit exceeded — not re-entering');
      return;
    }
    failureReEntryCounters.set(originSessionId, count);

    const sections = [];
    if (badIds.length) {
      sections.push(
        `**존재하지 않는 에이전트 ID**\n\n` +
        badIds.map((f) => `- 요청한 ID: \`${f.badId}\` (존재하지 않음)\n  작업: ${f.task}`).join('\n') +
        `\n\n실제 사용 가능한 에이전트:\n${formatTargets(badIds[0].targets)}\n\n` +
        `목록에 있는 정확한 ID 로 위임 JSON 을 다시 출력하세요. 방금 쓴 잘못된 ID 를 다시 쓰지 마세요.`
      );
    }
    if (depthBlocked.length) {
      sections.push(
        `**위임 체인 깊이 한계(${MAX_DELEGATION_DEPTH}단계) 초과 — 재위임이 거부됨**\n\n` +
        depthBlocked.map((f) => `- 대상: \`${f.targetAgentId}\` (깊이 ${f.depth})\n  작업: ${f.task}`).join('\n') +
        `\n\n더 깊이 위임할 수 없습니다. 이 작업은 직접 처리하거나, 범위를 줄여 스스로 끝낸 뒤 결과를 보고하세요.`
      );
    }

    const trigger =
      `[위임 실패 — 아래 작업은 아무에게도 전달되지 않았습니다]\n\n` +
      sections.join('\n\n---\n\n') +
      `\n\n적합한 처리 방법이 없으면 위임을 반복하지 말고 사용자에게 상황을 알리세요.`;
    try {
      await sessionsStore.appendMessage(originSessionId, { role: 'user', content: trigger });
      ctx.dispatch(originSessionId, { kind: 'undelivered', content: trigger });
    } catch (err) {
      logger.warn({ err: err.message, originSessionId }, 'delegation: retry trigger send failed');
    }
  }

  /**
   * 에이전트가 동시에 소화할 수 있는 위임 수. config 의 maxConcurrent 가 없거나
   * 이상한 값이면 1 — 기존(한 번에 하나) 동작을 그대로 유지한다.
   */
  const MAX_CONCURRENT_CEILING = 10;
  function getMaxConcurrent(agentId) {
    const raw = configStore?.getAgent?.(agentId)?.maxConcurrent;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_CONCURRENT_CEILING, Math.max(1, Math.floor(n)));
  }

  /**
   * 지금 이 에이전트에게 위임을 하나 더 밀어 넣어도 되는가.
   * reserved — 대기열에서 이미 꺼냈지만 아직 트래커에 등록되지 않은 작업 수.
   * 드레인 중에는 이 예약분을 함께 세야 같은 슬롯을 두 번 꺼내지 않는다.
   */
  function hasAgentCapacity(agentId, reserved = 0) {
    if (!delegationTracker) return true;
    const activeNow = delegationTracker.activeCountForAgent
      ? delegationTracker.activeCountForAgent(agentId)
      : (delegationTracker.isAgentBusy(agentId) ? 1 : 0);
    return activeNow + reserved < getMaxConcurrent(agentId);
  }

  /** Normalize agent ID (cf.router → cf_router, case-insensitive). */
  function resolveAgentId(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (configStore.getAgent(trimmed)) return trimmed;
    const normalized = trimmed.replace(/[.\-/\s]+/g, '_');
    if (configStore.getAgent(normalized)) return normalized;
    const dotted = trimmed.replace(/_/g, '.');
    if (configStore.getAgent(dotted)) return dotted;
    const all = configStore.getAgents() || {};
    const lowerNorm = normalized.toLowerCase();
    for (const id of Object.keys(all)) {
      const idNorm = id.replace(/[.\-/\s]+/g, '_').toLowerCase();
      if (idNorm === lowerNorm) return id;
    }
    return null;
  }

  /**
   * 위임 JSON 의 "tier" 를 실제 티어 키로 정규화한다. 등록되지 않은 이름은
   * 무시(null) — 오타 하나로 위임 자체가 실패하는 것보다 에이전트 기본 티어로
   * 실행되는 편이 낫다.
   */
  function resolveOverrideTier(raw, targetAgentId) {
    if (raw == null) return null;
    const order = normalizeTiers(ctx.backendsStore?.getRaw?.()?.tiers).order;
    const wanted = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    const match = wanted ? order.find((t) => t.toLowerCase() === wanted) : null;
    if (!match) {
      logger.warn({ agent: targetAgentId, tier: raw, known: order }, 'delegation: 알 수 없는 티어 — 무시하고 기본 티어로 실행');
      return null;
    }
    return match;
  }

  /**
   * 이 에이전트를 어느 기계에서 돌릴 것인가.
   *
   * `host` 가 없거나 이 인스턴스의 selfId 와 같으면 기존 로컬 경로 그대로다 —
   * 레지스트리가 아예 없는 설치에서도 동작이 100% 변하지 않아야 한다. 모르는
   * 값이면 조용히 로컬로 떨어뜨리지 않고 실패로 돌려준다(엉뚱한 기계에서 도는
   * 것보다 리드가 사유를 아는 편이 낫다).
   *
   * @returns {{ remote: false } | { remote: true, instanceId, instance } | { error: string, host: string }}
   */
  function resolveHost(targetAgentId) {
    const host = configStore.getAgent(targetAgentId)?.host ?? null;
    const instancesStore = ctx.instancesStore;
    if (!host || typeof host !== 'string' || !host.trim()) return { remote: false };
    const wanted = host.trim();
    if (!instancesStore) return { error: 'federation_unconfigured', host: wanted };
    if (wanted === instancesStore.getSelfId()) return { remote: false };
    const instance = instancesStore.getInstance(wanted);
    if (!instance) return { error: 'unknown_host', host: wanted };
    return { remote: true, instanceId: wanted, instance };
  }

  /**
   * 원격에 발주해도 되는 상태인지 확인한다. 헬스가 낡았으면 지금 찍는다 —
   * 죽은 인스턴스에 보내 놓고 콜백을 기다리는 것이 가장 나쁜 실패 모드다.
   */
  async function gateRemoteInstance(instanceId, instance) {
    if (instance.enabled === false) return { ok: false, reason: 'disabled', detail: '인스턴스가 비활성화돼 있습니다.' };
    if (!instance.baseUrl) return { ok: false, reason: 'no_base_url', detail: 'baseUrl 이 등록돼 있지 않습니다.' };
    if (!instance.token) return { ok: false, reason: 'no_token', detail: '연합 토큰이 등록돼 있지 않습니다.' };
    if (!ctx.instancesStore.getSelfPublicUrl()) {
      return { ok: false, reason: 'no_self_public_url', detail: 'selfPublicUrl 이 비어 있어 콜백을 받을 주소가 없습니다.' };
    }

    let health = instance.health ?? null;
    const age = Date.now() - (instance.lastHealthAt ?? 0);
    if (!health || age > HEALTH_STALE_MS) {
      health = await checkInstanceHealth(instance.baseUrl);
      await ctx.instancesStore.recordHealth(instanceId, health).catch(() => {});
    }
    if (!health.ok) {
      return { ok: false, reason: 'unreachable', detail: `원격이 응답하지 않습니다 (${health.error ?? 'unknown'}).` };
    }
    if (!supportsFederation(health)) {
      return {
        ok: false,
        reason: 'federation_unsupported',
        detail: `원격 버전 ${health.version ?? '(알 수 없음)'} 은 연합 엔드포인트가 없습니다 — 업그레이드가 필요합니다.`
      };
    }
    return { ok: true, health };
  }

  /**
   * 원격 위임이 전달되지 못했다. 리드에게 사유를 즉시 되돌려 준다 —
   * 로컬로 몰래 폴백하지 않는다. 되먹임이 없으면 리드는 오지 않을 회신을
   * 기다리다 턴을 끝내고 작업이 통째로 사라진다.
   */
  async function reportRemoteFailure({ originSessionId, targetAgentId, instanceId, task, reason, detail, groupId }) {
    ctx.dropGroupSlot?.(groupId, `remote-${reason}`);
    const body =
      `**대상**: \`${targetAgentId}\` @ \`${instanceId}\`\n` +
      `**작업**: ${task}\n` +
      `**사유**: ${detail} (\`${reason}\`)`;
    await sessionsStore.appendMessage(originSessionId, {
      role: 'assistant',
      content: `❌ **원격 위임 실패** — 작업이 전달되지 않았습니다.\n\n${body}`
    });

    const count = (failureReEntryCounters.get(originSessionId) ?? 0) + 1;
    if (count > MAX_FAILURE_REENTRY) {
      logger.warn({ originSessionId, count, instanceId }, 'federation: 실패 회신 한도 초과 — 재진입하지 않음');
      return;
    }
    failureReEntryCounters.set(originSessionId, count);
    const trigger =
      `[원격 위임 실패 — 이 작업은 아무에게도 전달되지 않았습니다]\n\n${body}\n\n` +
      `로컬 에이전트로 대체할지, 원격 인스턴스 상태를 확인할지, 사용자에게 알릴지 판단해 계속 진행하세요. ` +
      `같은 대상에 그대로 재위임하지 마세요 — 같은 이유로 다시 실패합니다.`;
    await sessionsStore.appendMessage(originSessionId, { role: 'user', content: trigger });
    ctx.dispatch(originSessionId, { kind: 'report', content: trigger });
  }

  /**
   * 원격 인스턴스에 위임을 발주한다. 워커 스폰은 상대가 하고, 결과는
   * `/api/federation/result` 콜백으로 돌아와 `deliverRemoteResult` 가 받는다.
   */
  async function executeRemoteDelegation({
    originSessionId, targetAgentId, instanceId, instance, task, groupId, acceptedAt, depth, tier
  }) {
    const gate = await gateRemoteInstance(instanceId, instance);
    if (!gate.ok) {
      await reportRemoteFailure({
        originSessionId, targetAgentId, instanceId, task,
        reason: gate.reason, detail: gate.detail, groupId
      });
      return;
    }

    const instancesStore = ctx.instancesStore;
    const selfId = instancesStore.getSelfId();
    const callbackUrl = instancesStore.getSelfPublicUrl().replace(/\/+$/, '') + '/api/federation/result';
    // 트래커 키이자 연합 delegationId. 로컬 세션이 아니라는 것이 접두사로 드러나야
    // 하고, 콜백이 같은 값으로 돌아와야 회신을 맞출 수 있다.
    const delegationId = `rdel_${randomUUID().slice(0, 18)}`;

    const tierOverride = resolveOverrideTier(tier, targetAgentId);
    const effectiveTier = tierOverride ?? configStore.getAgent(targetAgentId)?.modelTier ?? null;
    const originAgentId = sessionsStore.get(originSessionId)?.agentId ?? 'unknown';
    // 머신이 다르면 파일이 공유되지 않는다 — 그 제약을 task 에 박아 보낸다.
    const guidedTask =
      `${task}\n\n${buildHostGuide({ selfId, remoteId: instanceId, remoteLabel: instance.label ?? null })}`;

    // 발주보다 트래커 등록이 **먼저**다. 빠른 원격은 POST 응답이 돌아오기 전에
    // 콜백을 쏠 수 있는데, 그때 레코드가 없으면 회신이 unknown_delegation 으로
    // 튕기고 원격이 5초/30초/120초를 헛되이 재시도한다.
    const entry = delegationTracker.create({
      originSessionId,
      targetSessionId: delegationId,
      targetAgentId,
      task,
      loop: false,
      depth,
      groupId,
      queuedAt: acceptedAt,
      tier: effectiveTier,
      tierOverridden: !!tierOverride,
      kind: 'remote',
      remoteInstance: instanceId,
      remoteSessionId: null
    });
    const attached = ctx.attachGroupMember?.(groupId, entry) ?? false;

    const sent = await postDelegate(instance, selfId, {
      delegationId,
      agent: targetAgentId,
      task: guidedTask,
      tier: effectiveTier,
      originLabel: `${originAgentId} @ ${selfId}`,
      callbackUrl
    });
    if (!sent.accepted) {
      // 접수되지 않았으니 running 으로 남겨선 안 된다 — 안 그러면 대상
      // 에이전트가 계속 busy 로 잡히고 스윕이 45분 뒤에야 풀어 준다.
      const failed = delegationTracker.fail(delegationId, `원격 접수 실패: ${sent.error}`);
      ctx.dequeueNextAgent(targetAgentId);
      const detail = `원격이 위임을 접수하지 않았습니다 (${sent.error}).`;
      if (attached && failed) {
        // 그룹 배리어에 이미 붙었다면 슬롯을 버리는 게 아니라 결과를 넣어야
        // 형제들의 보고가 함께 닫힌다.
        ctx.collectGroupReport?.(failed, {
          status: 'failed',
          body: `**작업**: ${task}\n**대상**: \`${targetAgentId}\` @ \`${instanceId}\`\n**오류**: ${detail}`
        });
      }
      await reportRemoteFailure({
        originSessionId, targetAgentId, instanceId, task,
        reason: sent.error ?? 'rejected',
        detail,
        groupId: attached ? null : groupId
      });
      return;
    }
    entry.remoteSessionId = sent.remoteSessionId ?? null;

    await sessionsStore.appendMessage(originSessionId, {
      role: 'assistant',
      content:
        `🌐 **원격 위임 시작** — \`${instance.label ?? instanceId}\` 의 ${targetAgentId}에게 작업을 전달했습니다.\n\n` +
        `**작업**: ${task}\n**원격 세션**: ${sent.remoteSessionId ?? '(미확인)'}\n` +
        `⚠️ 파일은 공유되지 않습니다 — 결과는 커밋·푸시로만 돌아옵니다.`
    });
    eventBus.publish('delegation.started', {
      id: entry.id,
      originSessionId,
      targetSessionId: delegationId,
      targetAgentId,
      task,
      groupId,
      queuedAt: entry.queuedAt,
      startedAt: entry.startedAt,
      queueMs: entry.queueMs,
      reusedSession: false,
      remoteInstance: instanceId
    });
    logger.info(
      { id: entry.id, delegationId, instanceId, targetAgentId, remoteSessionId: sent.remoteSessionId, depth },
      'federation: 원격 위임 발주 완료 — 콜백 대기'
    );
  }

  /**
   * 원격 워커의 결과 콜백을 로컬 위임과 **같은 회신 경로**에 태운다.
   * 리드 입장에서 로컬 워커와 구분되지 않아야 한다(뱃지 표기만 다름).
   */
  async function deliverRemoteResult({ delegationId, status, result, remoteSessionId, escalate }) {
    const entry = delegationTracker.getByTarget(delegationId);
    if (!entry) return { ok: false, error: 'unknown_delegation' };
    if (entry.kind !== 'remote') return { ok: false, error: 'not_remote' };

    if (remoteSessionId && entry.remoteSessionId !== remoteSessionId) {
      entry.remoteSessionId = remoteSessionId;
    }
    if (status !== 'completed') {
      const reason = status === 'failed'
        ? `원격 워커 실패: ${String(result ?? '').slice(0, 300)}`
        : '원격 워커가 결과 없이 중단됨';
      await abandonDelegation(delegationId, reason);
      return { ok: true, status };
    }
    // 완료 회신의 본문 처리(요약 추출 · 원문 저장 · 그룹 배리어 · 재진입)는
    // 로컬과 같은 함수를 탄다. ctx 에 꽂히는 것은 chat/remote-report.js.
    return ctx.reportRemoteCompletion({ entry, result, escalate });
  }

  async function executeDelegation(originSessionId, targetAgentIdRaw, task, rawText, groupId = null, queuedAt = null, tier = null) {
    // 그룹 슬롯은 정확히 한 번만 소비돼야 한다 — 등록(attach) 뒤에 예외가 나면
    // 취소(drop)까지 겹쳐 배리어가 형제들을 기다리지 않고 먼저 닫힌다.
    let attached = false;
    // 발주가 접수된 시각. 대기열을 거쳐 재진입한 경우 호출자가 원래 시각을 넘겨주므로
    // 그 값을 유지해야 큐에서 흘려버린 시간이 실행 시간에 섞이지 않는다.
    const acceptedAt = queuedAt ?? new Date().toISOString();
    try {
      const targetAgentId = resolveAgentId(targetAgentIdRaw);
      if (!targetAgentId) {
        const targets = listDelegateTargets(originSessionId);
        logger.warn({ targetAgentIdRaw, candidates: targets.length }, 'delegation: target agent not found');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⚠️ 위임 실패 — 에이전트 \`${targetAgentIdRaw}\` 는 존재하지 않습니다. 올바른 ID 로 재시도합니다.\n\n**사용 가능한 에이전트**\n${formatTargets(targets)}`
        });
        ctx.dropGroupSlot?.(groupId, 'unknown-agent');
        return { badId: targetAgentIdRaw, task, targets };
      }

      const depth = delegationTracker.getChainDepth(originSessionId) + 1;
      if (depth > MAX_DELEGATION_DEPTH) {
        logger.warn({ originSessionId, targetAgentId, depth }, 'delegation: depth limit exceeded — refused');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⛔ **위임 거부 — 체인 깊이 한계** (${depth}/${MAX_DELEGATION_DEPTH}단계)\n\n**대상**: \`${targetAgentId}\`\n**작업**: ${task}\n\n이 작업은 전달되지 않았습니다. 직접 처리해야 합니다.`
        });
        ctx.dropGroupSlot?.(groupId, 'depth-exceeded');
        return { depthExceeded: true, task, targetAgentId, depth };
      }

      if (!hasAgentCapacity(targetAgentId)) {
        const max = getMaxConcurrent(targetAgentId);
        const agentQueue = ctx.agentQueue;
        if (!agentQueue.has(targetAgentId)) agentQueue.set(targetAgentId, []);
        const queue = agentQueue.get(targetAgentId);
        queue.push({ originSessionId, targetAgentId, task, rawText, groupId, queuedAt: acceptedAt, tier });
        delegationTracker.setPendingQueue?.(agentQueue);
        const pos = queue.length;
        logger.info({ targetAgentId, queueLength: pos, max }, 'delegation: queued (agent at capacity)');
        await sessionsStore.appendMessage(originSessionId, {
          role: 'assistant',
          content: `⏳ **위임 대기** — \`${targetAgentId}\`가 동시 처리 한도(${max})에 도달했습니다. 대기열 ${pos}번째에 추가됐습니다.\n\n**작업**: ${task}`
        });
        return;
      }

      // ── 크로스호스트 분기 ──
      // 여기 한 군데서만 갈린다. host 가 없으면 아래 로컬 경로가 그대로 이어진다.
      const hostRoute = resolveHost(targetAgentId);
      if (hostRoute.error) {
        logger.warn({ targetAgentId, host: hostRoute.host, reason: hostRoute.error }, 'federation: host 해석 실패 — 로컬 폴백하지 않음');
        await reportRemoteFailure({
          originSessionId,
          targetAgentId,
          instanceId: hostRoute.host,
          task,
          reason: hostRoute.error,
          detail: hostRoute.error === 'unknown_host'
            ? `에이전트의 host \`${hostRoute.host}\` 가 인스턴스 레지스트리에 없습니다.`
            : '이 서버에 인스턴스 레지스트리가 없습니다.',
          groupId
        });
        return;
      }
      if (hostRoute.remote) {
        await executeRemoteDelegation({
          originSessionId,
          targetAgentId,
          instanceId: hostRoute.instanceId,
          instance: hostRoute.instance,
          task,
          groupId,
          acceptedAt,
          depth,
          tier
        });
        return;
      }

      const wantsLoop = /"loop"\s*:\s*true/.test(rawText);

      // 이 실행에만 적용할 모델 티어. 에이전트 저장값(config.json)은 건드리지 않고
      // 세션에만 얹는다. 재사용 세션에도 **매번** 써 넣어야(없으면 null) 앞 위임의
      // 티어가 다음 작업까지 따라가지 않는다.
      const tierOverride = resolveOverrideTier(tier, targetAgentId);
      const agentDefaultTier = configStore.getAgent(targetAgentId)?.modelTier ?? null;
      if (tierOverride) {
        logger.info(
          { agent: targetAgentId, from: agentDefaultTier, to: tierOverride },
          'delegation: 이번 실행에만 모델 티어를 덮어씀'
        );
      }
      // 이 실행이 실제로 돌아갈 급. 세션 재사용 키와 트래커 기록이 같은 값을 쓴다.
      const effectiveTier = tierOverride ?? agentDefaultTier;

      // 같은 플래너가 같은 에이전트에게 **같은 급으로** 다시 위임하는 경우에만 직전
      // 워커 세션을 --resume 으로 재사용해 콜드스타트(페르소나 재주입 + 코드베이스
      // 재탐색)를 없앤다. 급이 다르면 재사용하지 않는다 — resume 은 그 세션이 열릴
      // 때의 모델을 이어 쓰므로, 재사용하면 상위 티어 재위임이 하위 티어 그대로
      // 돌아간다. loop 위임은 세션에 loop 상태가 붙으므로 항상 새 세션.
      const reuse = wantsLoop
        ? null
        : ctx.acquireWorkerSession?.(originSessionId, targetAgentId, effectiveTier) ?? null;
      let targetSession;
      if (reuse) {
        targetSession = reuse.session;
        await sessionsStore.update(targetSession.id, {
          title: `[위임] ${task.slice(0, 40)}`,
          modelTierOverride: tierOverride
        });
      } else {
        targetSession = await sessionsStore.create({
          agentId: targetAgentId,
          title: `[위임] ${task.slice(0, 40)}`,
          isDelegation: true,
          modelTierOverride: tierOverride
        });
        eventBus.publish('session.created', { session: targetSession });
        if (!wantsLoop) ctx.registerWorkerSession?.(originSessionId, targetAgentId, targetSession.id, effectiveTier);
      }

      // 슬롯 격리: 워커의 cwd 를 전용 worktree 로 준다. 경로는 세션에 박아 둔다 —
      // 다음 턴은 --resume 이고 CLI 세션 파일 경로가 cwd 로 인코딩되므로, 경로가
      // 바뀌면 resume 대상을 못 찾아 콜드스타트가 된다.
      const lease = await ctx.leaseWorktree?.(targetAgentId, targetSession.id, {
        preferred: targetSession.worktreePath ?? null
      });
      // 원본 트리를 받은 슬롯(slot 0)은 기록하지 않는다 — cwd 오버라이드가 필요 없고,
      // 지난번 worktree 경로가 남아 있으면 사라진 디렉토리를 가리키게 된다.
      if (lease) {
        const cwd = lease.isolated ? lease.path : null;
        if ((targetSession.worktreePath ?? null) !== cwd) {
          await sessionsStore.update(targetSession.id, {
            worktreePath: cwd,
            worktreeSlot: lease.slot
          });
        }
      }

      const entry = delegationTracker.create({
        originSessionId,
        targetSessionId: targetSession.id,
        targetAgentId,
        task,
        loop: wantsLoop,
        depth,
        groupId,
        queuedAt: acceptedAt,
        // 오버라이드가 없으면 에이전트 저장 티어가 실제 실행 급이다.
        tier: effectiveTier,
        tierOverridden: !!tierOverride
      });
      attached = ctx.attachGroupMember?.(groupId, entry) ?? false;

      await sessionsStore.appendMessage(originSessionId, {
        role: 'assistant',
        content: `🔄 **위임 시작** — ${targetAgentId}에게 작업을 전달했습니다.\n\n**작업**: ${task}\n**세션**: ${targetSession.id}${reuse ? ` (재사용 ${reuse.uses}회차 — 콜드스타트 없음)` : ''}${wantsLoop ? '\n**모드**: Ralph Loop (자동 반복)' : ''}`
      });
      eventBus.publish('delegation.started', {
        id: entry.id,
        originSessionId,
        targetSessionId: targetSession.id,
        targetAgentId,
        task,
        groupId,
        queuedAt: entry.queuedAt,
        startedAt: entry.startedAt,
        queueMs: entry.queueMs,
        reusedSession: !!reuse
      });

      if (wantsLoop) {
        await sessionsStore.update(targetSession.id, {
          loop: {
            enabled: true,
            prompt: task + '\n\n완료되면 <promise>DONE</promise>을 출력하세요. 도움이 필요하면 <escalate>이유</escalate>를 출력하세요.',
            maxIterations: 10,
            completionPromise: 'DONE',
            currentIteration: 0,
            startedAt: new Date().toISOString()
          }
        });
      }

      // 재사용 세션에는 앞 작업의 대화가 그대로 남아 있다. 경계선을 붙이지 않으면
      // 워커가 이전 작업을 이어서 하거나 그 결과를 다시 보고한다.
      const fullTask = wantsLoop
        ? `${task}\n\n완료되면 <promise>DONE</promise>을 출력하세요. 도움이 필요하면 <escalate>이유</escalate>를 출력하세요.`
        : reuse ? `${REUSE_TASK_PREFIX}\n\n${task}` : task;
      await sessionsStore.appendMessage(targetSession.id, { role: 'user', content: fullTask });
      ctx.dispatch(targetSession.id, { kind: 'task', content: fullTask });

      logger.info({
        id: entry.id,
        origin: originSessionId,
        target: targetSession.id,
        agent: targetAgentId,
        loop: wantsLoop,
        tier: tierOverride,
        taskLength: task.length,
        depth,
        queueMs: entry.queueMs,
        reused: reuse ? reuse.uses : 0
      }, 'delegation: task sent');
    } catch (err) {
      // 등록까지 마친 뒤 터졌다면 멤버는 이미 트래커에 있다 — 스톨 스윕이
      // 중단 처리하면서 그때 그룹에 결과가 들어간다.
      if (!attached) ctx.dropGroupSlot?.(groupId, 'dispatch-error');
      logger.error({ err, targetAgentId: targetAgentIdRaw }, 'delegation: execution failed');
      await sessionsStore.appendMessage(originSessionId, {
        role: 'assistant',
        content: `❌ 위임 실패 — ${err.message}`
      });
    }
  }

  /**
   * 위임 대상 세션이 결과를 내지 못한 채 멈췄을 때(사용자 중단 / 세션 삭제 /
   * 빈 응답으로 자동 재시도 포기) 트래커를 정리한다. 이걸 안 하면 대상 에이전트가
   * 영원히 busy 로 남아 이후 위임이 전부 대기열에 쌓이고, 플래너는 오지 않을
   * 보고를 기다리며 턴을 끝낸다.
   */
  async function abandonDelegation(targetSessionId, reason) {
    if (!delegationTracker) return null;
    try {
      if (!delegationTracker.getByTarget(targetSessionId)) return null;
      const failed = delegationTracker.fail(targetSessionId, reason);
      // 중단된 워커 세션은 재사용 후보에서 제외 — resume 대상이 깨져 있을 수 있다.
      ctx.forgetWorkerSession?.(targetSessionId);
      // 쥐고 있던 슬롯도 놓는다. 워커가 남긴 변경은 패치로 보존된 뒤 정리된다.
      await ctx.releaseWorktree?.(targetSessionId, `abandoned: ${reason}`);
      if (!failed) return null;
      ctx.dequeueNextAgent(failed.targetAgentId);

      const body =
        `**작업**: ${failed.task}\n` +
        `**사유**: ${reason}\n\n` +
        `이 작업은 완료되지 않았습니다.`;
      // 같은 턴에 함께 발주된 위임이면 형제들이 끝날 때까지 보고를 모아 둔다.
      const held = ctx.collectGroupReport?.(failed, { status: 'aborted', body }) ?? false;
      if (!held) {
        const trigger =
          `[위임 중단]\n\n` +
          `**대상**: ${failed.targetAgentId}\n` +
          body + `\n\n` +
          `직접 처리할지, 다른 에이전트에게 다시 위임할지, 사용자에게 상황을 알릴지 판단해 계속 진행하세요.`;
        await sessionsStore.appendMessage(failed.originSessionId, { role: 'user', content: trigger });
        ctx.dispatch(failed.originSessionId, { kind: 'report', content: trigger });
      }
      logger.info(
        { id: failed.id, targetSessionId, targetAgentId: failed.targetAgentId, reason },
        'delegation: abandoned — tracker released, planner resumed'
      );
      return failed;
    } catch (err) {
      logger.warn({ err: err.message, targetSessionId, reason }, 'delegation: abandon cleanup failed');
      return null;
    }
  }

  /**
   * 위임이 마지막으로 살아 있었던 시각. 러너의 lastActivity 는 프로세스가 끝나면
   * 지워지므로, 세션 updatedAt 과 생성 시각까지 함께 보고 가장 최근 것을 쓴다.
   */
  function lastActivityMs(entry) {
    const stamps = [Date.parse(entry.createdAt)];
    const fromRunner = ctx.runner?.lastActivityAt?.(entry.targetSessionId);
    if (fromRunner) stamps.push(fromRunner);
    const updatedAt = sessionsStore.get(entry.targetSessionId)?.updatedAt;
    if (updatedAt) stamps.push(Date.parse(updatedAt));
    return Math.max(0, ...stamps.filter(Number.isFinite));
  }

  /** running 인데 러너도 없고 한참 조용한 위임을 중단 처리한다. */
  async function sweepStalledDelegations() {
    if (!delegationTracker) return;
    const now = Date.now();
    for (const entry of delegationTracker.list()) {
      if (entry.status !== 'running') continue;
      // 러너가 살아 있거나 디스패치 큐에서 차례를 기다리는 중이면 정상 작동이다.
      if (ctx.isSessionBusy?.(entry.targetSessionId)) continue;
      const idleMs = now - lastActivityMs(entry);
      // 원격은 네트워크 왕복 + 상대 대기열까지 포함하므로 더 길게 기다린다.
      if (idleMs < (entry.kind === 'remote' ? REMOTE_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS)) continue;
      const idleMinutes = Math.floor(idleMs / 60_000);
      logger.warn(
        { id: entry.id, targetSessionId: entry.targetSessionId, targetAgentId: entry.targetAgentId, idleMinutes },
        'delegation: stalled worker detected by sweep'
      );
      await abandonDelegation(
        entry.targetSessionId,
        `응답 없이 중단됨 (워커 프로세스 없음, ${idleMinutes}분간 활동 없음)`
      );
    }
  }

  const sweepTimer = setInterval(() => {
    sweepStalledDelegations().catch((err) => {
      logger.warn({ err: err.message }, 'delegation: sweep failed');
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  /** Escape special regex characters in a string. */
  function escapeForRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Queue the next loop iteration. The loop guard is re-evaluated at dequeue
   * time, not just here — otherwise an iteration queued behind a long turn would
   * still fire after the user stopped or escalated the loop.
   */
  async function sendLoopIteration(sessionId, prompt) {
    const loopStillActive = () => {
      const s = sessionsStore.get(sessionId);
      return !!s?.loop?.enabled && !s.loop.paused;
    };
    if (!loopStillActive()) return;
    try {
      await sessionsStore.appendMessage(sessionId, { role: 'user', content: prompt });
      ctx.dispatch(sessionId, { kind: 'loop', content: prompt, guard: loopStillActive });
    } catch (err) {
      eventBus.publish('chat.error', { sessionId, error: `Loop failed: ${err.message}` });
    }
  }

  /**
   * Ralph Loop continuation — after each assistant response, decide:
   * continue, complete, or escalate.
   */
  async function handleLoopContinuation(sessionId, responseText) {
    const session = sessionsStore.get(sessionId);
    const loop = session?.loop;
    if (!loop?.enabled || loop.paused) return;

    const text = responseText ?? '';
    const nextIter = (loop.currentIteration ?? 0) + 1;

    // (1) 완료/에스컬레이트 판정: 정규식으로 관대하게 (공백 허용, 대소문자 무관)
    const completionRegex = new RegExp(
      `<promise>\\s*${escapeForRegex(loop.completionPromise)}\\s*<\\/promise>`,
      'i'
    );
    const completed = completionRegex.test(text);

    const escalateMatch = text.match(/<escalate>([\s\S]*?)<\/escalate>/i);
    const escalated = !!escalateMatch;
    const escalateReason = escalateMatch?.[1]?.trim() ?? '';

    // (3) 진전 없음 감지: 최근 3개 응답이 길이차 10% 이내 + 첫 200자 동일이면 자동 에스컬레이트
    const recentResponses = [...(loop.recentResponses ?? []), text].slice(-3);
    let stagnated = false;
    if (!completed && !escalated && recentResponses.length >= 3) {
      const similar = (a, b) => {
        const maxLen = Math.max(a.length, b.length, 1);
        return (
          Math.abs(a.length - b.length) / maxLen <= 0.1 &&
          a.slice(0, 200) === b.slice(0, 200)
        );
      };
      const [r1, r2, r3] = recentResponses;
      if (similar(r1, r2) && similar(r2, r3)) stagnated = true;
    }

    if (completed || nextIter >= loop.maxIterations) {
      await sessionsStore.update(sessionId, { loop: null });
      eventBus.publish('session.loop.completed', {
        sessionId,
        iterations: nextIter,
        reason: completed ? 'promise' : 'max_iterations'
      });
      logger.info({ sessionId, iterations: nextIter, reason: completed ? 'promise' : 'max' }, 'ralph loop: completed');
    } else if (escalated || stagnated) {
      const reason = stagnated ? '진전 없음 감지' : escalateReason;
      await sessionsStore.update(sessionId, {
        loop: { ...loop, currentIteration: nextIter, paused: true, escalateReason: reason, recentResponses }
      });
      await sessionsStore.appendMessage(sessionId, {
        role: 'assistant',
        content: `🚨 **Loop 에스컬레이션** (${nextIter}/${loop.maxIterations})\n\n**이유**: ${reason}\n\n후속 지시를 보내주시면 Loop 가 재개됩니다.`
      }).catch(() => {});
      if (delegationTracker) {
        const del = delegationTracker.getByTarget(sessionId);
        if (del) {
          try {
            const originId = del.originSessionId;
            const origin = sessionsStore.get(originId);
            const msgs = origin?.messages ?? [];
            const recentTrigger = msgs.slice(-4).some((m) =>
              m?.role === 'user' && (m.content || '').startsWith('[위임 에스컬레이션]')
            );
            if (!recentTrigger) {
              const trigger =
                `[위임 에스컬레이션]\n\n` +
                `**대상**: ${del.targetAgentId}\n` +
                `**작업**: ${del.task}\n` +
                `**문제**: ${reason}\n\n` +
                `위임한 작업이 Ralph Loop 중 막혔습니다. 문제를 검토하고 사용자에게 상황을 설명한 뒤, 해결 방안 / 수정 지시 / 중단 중 선택지를 <choices> 로 제시해 주세요.`;
              await sessionsStore.appendMessage(originId, { role: 'user', content: trigger });
              ctx.dispatch(originId, { kind: 'escalation', content: trigger });
            }
          } catch (err) {
            logger.warn({ err: err.message }, 'escalation → origin planner trigger failed');
          }
        }
      }
      eventBus.publish('session.loop.escalated', {
        sessionId,
        iteration: nextIter,
        reason
      });
      logger.info({ sessionId, iteration: nextIter, reason }, 'ralph loop: escalated');
    } else {
      await sessionsStore.update(sessionId, {
        loop: { ...loop, currentIteration: nextIter, recentResponses }
      });
      eventBus.publish('session.loop.iteration', {
        sessionId,
        iteration: nextIter,
        maxIterations: loop.maxIterations
      });
      logger.info({ sessionId, iteration: nextIter, max: loop.maxIterations }, 'ralph loop: next iteration');

      // (2) 재전송 프롬프트: 진행상황 검토 규칙 항상 포함
      const rule = `[Loop ${nextIter}/${loop.maxIterations}] 이전까지 진행상황 검토 후 남은 작업만 수행. 완료 시 <promise>DONE</promise>, 막히면 <escalate>이유</escalate> 반드시 출력`;
      sendLoopIteration(sessionId, `${rule}\n\n${loop.prompt}`);
    }
  }

  return {
    extractDelegateJson,
    handleDelegation,
    resolveAgentId,
    resolveOverrideTier,
    resolveHost,
    getMaxConcurrent,
    hasAgentCapacity,
    executeDelegation,
    deliverRemoteResult,
    abandonDelegation,
    sweepStalledDelegations,
    handleLoopContinuation
  };
}
