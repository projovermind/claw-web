/**
 * Session compaction — shared by POST /api/sessions/:id/compact and the
 * chat route's automatic threshold-triggered compaction.
 */

/** 10 messages ≈ 5 user-assistant turns kept verbatim. */
const RECENT = 10;

/**
 * 자동 compact 는 창의 남은 여유가 이 값 미만일 때만 의미가 있다.
 *
 * 퍼센트 임계만 보면 창 크기 차이를 흡수할 수 없다. 1M 창에서 50% 는 여유가
 * 500K 남은 상태인데, 실측(2026-09-15) 으로 snm_planner 세션 하나가 15시간에
 * 32회 압축됐다 — 매번 여유 470~500K 를 남긴 채였다. 200K 창에서의 50% 와
 * 1M 창에서의 50% 를 같게 취급한 결과다.
 */
export const MIN_HEADROOM_TOKENS = 150_000;

/**
 * 같은 세션을 재압축하기 전에 요구하는 최소 재증가량.
 *
 * in-place 압축이 정상 동작하면 used 가 요약 크기까지 떨어지므로 이 조건은
 * 자연히 통과한다. 압축이 사실상 줄이지 못한 경우(요약이 이미 거대한 경우)에만
 * 걸려서 매 턴 재압축하는 폭주를 끊는다.
 */
export const MIN_REGROWTH_TOKENS = 50_000;

/** Build the markdown summary that replaces a session's history. */
export function buildCompactSummary(session) {
  const msgs = session.messages ?? [];
  const lines = [];
  lines.push(`# 세션 요약 (${session.title})`);
  lines.push(`원본 세션: ${session.id}`);
  lines.push(`에이전트: ${session.agentId}`);
  lines.push(`메시지 수: ${msgs.length}`);
  lines.push(`기간: ${msgs[0]?.ts ?? '?'} ~ ${msgs[msgs.length - 1]?.ts ?? '?'}`);
  lines.push('');
  lines.push('## 대화 요약');
  lines.push('');

  const older = msgs.slice(0, -RECENT);
  const recent = msgs.slice(-RECENT);

  if (older.length > 0) {
    lines.push(`### 이전 대화 (${older.length}개 메시지, 압축됨)`);
    for (const m of older) {
      const role = m.role === 'user' ? '👤' : '🤖';
      const content = (m.content ?? '').replace(/\n/g, ' ').slice(0, 200);
      lines.push(`- ${role} ${content}${(m.content ?? '').length > 200 ? '...' : ''}`);
    }
    lines.push('');
  }

  lines.push(`### 최근 대화 (${recent.length}개 메시지, 전문)`);
  lines.push('');
  for (const m of recent) {
    lines.push(`#### ${m.role === 'user' ? '👤 User' : '🤖 Assistant'}`);
    lines.push(m.content ?? '');
    lines.push('');
  }

  const toolCalls = msgs.flatMap((m) => m.toolCalls ?? []);
  if (toolCalls.length > 0) {
    lines.push('### 사용된 도구');
    const toolCounts = {};
    for (const tc of toolCalls) toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
    for (const [name, count] of Object.entries(toolCounts)) lines.push(`- ${name}: ${count}회`);
    lines.push('');
  }

  return lines.join('\n');
}

/** 이전 세대가 남긴 ' (compact)' 접미사를 모두 벗겨 원본 제목을 되돌린다. */
export function stripCompactSuffix(title) {
  return (title ?? '').replace(/(\s*\(compact\))+$/, '');
}

/** 압축 결과 세션의 첫 메시지 — 요약이 곧 새 컨텍스트다. */
function seedContent(summary) {
  return `[이전 세션에서 이어짐]\n\n${summary}\n\n위는 이전 대화의 요약입니다. 이 맥락을 바탕으로 이어서 작업해주세요.`;
}

/**
 * Compact a session into its summary.
 *
 * 두 가지 모드가 있고, 결과 세션은 어느 쪽이든 claudeSessionId 를 물려받지
 * 않는다 — 요약이 곧 컨텍스트이고, 그게 압축의 목적이다.
 *
 *   fork (기본, 수동 POST /compact 경로)
 *     새 세션을 만들어 요약을 심는다. 원본은 그대로 남는다. 사용자가 새 세션으로
 *     옮겨 타는 것을 전제로 한 동작.
 *
 *   inPlace (자동 압축 경로)
 *     같은 세션 id 를 유지하고 히스토리만 요약으로 교체한다. 원본 메시지는
 *     _archived 세션으로 옮겨 보존한다(사이드바에는 노출되지 않음).
 *     fork 는 자동 경로에서 아무 효과가 없었다 — 러너는 계속 원본 세션을 쓰므로
 *     컨텍스트가 줄지 않고, 다음 턴에 또 임계를 넘어 매 턴 포크가 반복됐다
 *     (실측 32회/세션, 고아 세션 32개 + 콜드스타트 32회). in-place 는 살아 있는
 *     세션을 실제로 줄이므로 프롬프트 캐시 손실이 압축당 1회로 끝난다.
 *
 * @throws {Error} code 'EMPTY_SESSION' when there is nothing to compact.
 * @returns {Promise<{newSessionId, archivedSessionId, inPlace, originalMessages, compactChars, originalChars, savings}>}
 */
export async function compactSession({ session, sessionsStore, eventBus, inPlace = false }) {
  const msgs = session.messages ?? [];
  if (msgs.length === 0) {
    const err = new Error('No messages to compact');
    err.code = 'EMPTY_SESSION';
    throw err;
  }

  const summary = buildCompactSummary(session);
  const originalChars = msgs.reduce((s, m) => s + (m.content ?? '').length, 0);
  const compactChars = summary.length;
  const savings = Math.round((1 - compactChars / Math.max(originalChars, 1)) * 100);

  // 세대마다 접미사를 덧붙이면 제목이 "T (compact) (compact)" 로 자란다.
  // 혈통은 compactRoot/compactGen 이 들고 있으므로 제목은 원본 그대로 둔다.
  const title = stripCompactSuffix(session.title);
  const compactRoot = session.compactRoot ?? session.id;
  const compactGen = (session.compactGen ?? 0) + 1;

  let newSessionId;
  let archivedSessionId = null;

  if (inPlace) {
    // 원본 히스토리 보존용 아카이브. 압축 전 claudeSessionId 도 같이 들고 가서
    // 나중에 원본 대화를 되짚을 수 있게 한다.
    const archived = await sessionsStore.create({
      agentId: session.agentId,
      title,
      messages: msgs,
      claudeSessionId: session.claudeSessionId ?? null,
      compactRoot,
      compactGen: session.compactGen ?? 0,
      _archived: true
    });
    archivedSessionId = archived.id;

    await sessionsStore.setMessages(session.id, [
      { role: 'user', content: seedContent(summary), ts: new Date().toISOString() }
    ]);
    // claudeSessionId 를 비워야 다음 턴이 fresh start 로 잡혀 persona/skills 가
    // 재주입된다 (message-sender 의 isFirstMsg 판정).
    await sessionsStore.update(session.id, {
      claudeSessionId: null,
      personaBakedInto: null,
      compactRoot,
      compactGen
    });
    newSessionId = session.id;
  } else {
    const newSession = await sessionsStore.create({ agentId: session.agentId, title, compactRoot, compactGen });
    await sessionsStore.appendMessage(newSession.id, { role: 'user', content: seedContent(summary) });
    newSessionId = newSession.id;
  }

  const result = {
    newSessionId,
    archivedSessionId,
    inPlace,
    originalMessages: msgs.length,
    compactChars,
    originalChars,
    savings
  };

  if (eventBus) {
    eventBus.publish('session.compacted', {
      originalSessionId: session.id,
      newSessionId,
      archivedSessionId,
      inPlace,
      originalMessages: msgs.length,
      compactChars,
      savings
    });
  }

  return result;
}

/**
 * Should this session be auto-compacted?
 *
 * 세 관문을 모두 통과해야 한다:
 *   1. 퍼센트 임계 (사용자 설정)
 *   2. 절대 여유 하한 — 창에 아직 MIN_HEADROOM_TOKENS 넘게 남아 있으면 압축 무의미
 *   3. 재증가 히스테리시스 — 지난 자동 압축 '후' 상태에서 의미 있게 자랐어야 한다
 *
 * 3번의 기준점은 반드시 압축 '후' 사용량(postCompactTokens)이다. 압축 '전' 값을 쓰면
 * 문턱이 사이클마다 MIN_REGROWTH_TOKENS 씩 올라가는 래칫이 되어, 1M 창에서는 몇
 * 사이클 만에 문턱이 창 크기를 넘어 압축이 영원히 불가능해진다.
 *
 * @param {number} pct  threshold percentage (0 = disabled)
 * @param {{pct:number, used:number, max:number}|null} usage  from sessionContextUsage()
 * @param {{lastAutoCompact?:{postCompactTokens?:number|null}}|null} session  히스테리시스 판단용
 */
export function shouldAutoCompact(pct, usage, session = null) {
  if (!pct || typeof pct !== 'number' || pct <= 0) return false;
  if (!usage || typeof usage.pct !== 'number') return false;
  if (usage.pct < pct) return false;

  const max = usage.max ?? 0;
  const used = usage.used ?? 0;
  if (max > 0 && max - used > MIN_HEADROOM_TOKENS) return false;

  const lastUsed = session?.lastAutoCompact?.postCompactTokens;
  if (typeof lastUsed === 'number' && used < lastUsed + MIN_REGROWTH_TOKENS) return false;

  return true;
}

/**
 * 히스테리시스 기준점(압축 후 사용량)을 뒤늦게 확정한다.
 *
 * in-place 압축 직후의 세션에는 usage 를 실은 assistant 턴이 없어서 '압축 후'
 * 사용량을 그 자리에서 알 수 없다. 그래서 압축 시점에는 기준점을 비워 두고
 * (postCompactTokens: null) 압축 후 처음 측정된 값으로 여기서 채운다.
 *
 * postCompactTokens 키가 아예 없는 기록은 압축 '전' 값을 담던 옛 형식이라
 * 신뢰할 수 없다 — 채우지 않고 무시한다. 히스테리시스가 한 번 건너뛰어지고
 * 다음 압축 때 새 형식으로 교체된다.
 *
 * @param {{lastAutoCompact?:object}|null} session
 * @param {{used:number}|null} usage  from sessionContextUsage()
 * @returns {object|null} 저장할 새 lastAutoCompact, 갱신할 게 없으면 null
 */
export function settleAutoCompactBaseline(session, usage) {
  const last = session?.lastAutoCompact;
  if (!last || last.postCompactTokens !== null) return null;
  const used = usage?.used;
  if (typeof used !== 'number' || used <= 0) return null;
  return { ...last, postCompactTokens: used };
}
