/**
 * Session compaction — shared by POST /api/sessions/:id/compact and the
 * chat route's automatic threshold-triggered compaction.
 */

/** 10 messages ≈ 5 user-assistant turns kept verbatim. */
const RECENT = 10;

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

/**
 * Compact a session into a fresh one seeded with its summary.
 * The new session deliberately does NOT inherit claudeSessionId — the summary
 * IS the context, which is the whole point of compacting.
 *
 * @throws {Error} code 'EMPTY_SESSION' when there is nothing to compact.
 * @returns {Promise<{newSessionId, originalMessages, compactChars, originalChars, savings}>}
 */
export async function compactSession({ session, sessionsStore, eventBus }) {
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

  const newSession = await sessionsStore.create({
    agentId: session.agentId,
    title: `${session.title} (compact)`
  });

  await sessionsStore.appendMessage(newSession.id, {
    role: 'user',
    content: `[이전 세션에서 이어짐]\n\n${summary}\n\n위는 이전 대화의 요약입니다. 이 맥락을 바탕으로 이어서 작업해주세요.`
  });

  const result = {
    newSessionId: newSession.id,
    originalMessages: msgs.length,
    compactChars,
    originalChars,
    savings
  };

  if (eventBus) {
    eventBus.publish('session.compacted', {
      originalSessionId: session.id,
      newSessionId: newSession.id,
      originalMessages: msgs.length,
      compactChars,
      savings
    });
  }

  return result;
}

/**
 * Should this session be auto-compacted?
 * @param {number} pct  threshold percentage (0 = disabled)
 * @param {{pct:number}|null} usage  from sessionContextUsage()
 */
export function shouldAutoCompact(pct, usage) {
  if (!pct || typeof pct !== 'number' || pct <= 0) return false;
  if (!usage || typeof usage.pct !== 'number') return false;
  return usage.pct >= pct;
}
