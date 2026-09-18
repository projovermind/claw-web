/**
 * Session compaction — shared by POST /api/sessions/:id/compact and the
 * chat route's automatic threshold-triggered compaction.
 */

/** 10 messages ≈ 5 user-assistant turns kept verbatim. */
const RECENT = 10;

/**
 * 압축 요약이 지켜야 할 상한들.
 *
 * 요약이 원본만큼 커지면 압축이 아니다. 예전 구현은 '앞 200자 절단' 하나로만
 * 줄였는데, 메시지가 1000개인 세션에서는 그것만으로 200KB 요약이 나왔다.
 * 그래서 (a) 메시지별 길이, (b) 나열할 메시지 수, (c) 추출 섹션의 항목 수를
 * 각각 제한한다. 잘려 나간 메시지도 아래 추출 섹션(파일/결정/미해결)에는
 * 여전히 반영되므로 '무엇을 하던 세션인지' 는 남는다.
 */
const OLDER_HEAD_CHARS = 180;
const OLDER_TAIL_CHARS = 180;
const MAX_OLDER_LISTED = 120;
const MAX_FILES = 40;
const MAX_DECISIONS = 20;
const MAX_UNRESOLVED = 20;
const STATE_CHARS = 700;
/**
 * 최근 툴 호출은 원문 유지가 원칙이다. 다만 두 방향으로 새는 것을 막는다:
 *   인자 하나가 거대한 경우(Write 의 content) → TOOL_ARG_CHARS
 *   호출 건수가 많은 경우 → 총량 예산. 실측 sess_S5Bhvli2EJJt 는 최근 10개
 *   메시지에 툴 호출이 385건(인자 114KB) 이라, 건당 상한만으로는 요약이 원본보다
 *   커졌다. 예산은 뒤에서부터 채워 가장 최근 호출을 원문으로 남기고, 못 담은
 *   앞쪽은 이름·횟수로 접는다.
 */
const TOOL_ARG_CHARS = 1_500;
const RECENT_TOOL_BUDGET_CHARS = 20_000;
const MAX_RECENT_TOOL_CALLS = 40;

/**
 * 압축할 가치가 있는 최소 사용량.
 *
 * 압축은 공짜가 아니다 — 프롬프트 캐시가 날아가고 콜드스타트가 한 번 붙는다.
 * 그보다 적게 쌓인 세션을 줄여 봐야 회수할 토큰이 비용보다 적다. 그래서 '언제'
 * 압축할지는 사용자가 정한 퍼센트가 결정하고, 여기서는 '애초에 줄일 게 있는가'
 * 만 본다.
 *
 * 이전 세대의 여유(headroom) 하한이 이 자리에 있었는데, 그건 창 크기에 묶여
 * 있어서 1M 창에서는 퍼센트를 어떻게 설정하든 used 가 800K 를 넘기 전에는
 * 압축이 막혔다 — 사용자가 85% 로 낮춰 잡아도 무시됐다는 뜻이다.
 * 애초에 그 하한이 막으려던 32회 폭주는 fork 압축 버그였고 in-place 로
 * 해결됐다. 재압축 폭주는 아래 MIN_REGROWTH_TOKENS 히스테리시스가 잡는다.
 */
export const MIN_COMPACTABLE_TOKENS = 100_000;

/**
 * 같은 세션을 재압축하기 전에 요구하는 최소 재증가량.
 *
 * in-place 압축이 정상 동작하면 used 가 요약 크기까지 떨어지므로 이 조건은
 * 자연히 통과한다. 압축이 사실상 줄이지 못한 경우(요약이 이미 거대한 경우)에만
 * 걸려서 매 턴 재압축하는 폭주를 끊는다.
 */
export const MIN_REGROWTH_TOKENS = 50_000;

const flat = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 본문에서 파일 경로를 긁어낸다.
 *
 * 압축 후에도 '어느 파일을 만지던 중이었나' 는 남아야 한다. 슬래시가 최소 한 번
 * 있고 확장자로 끝나는 토큰만 인정한다 — 산문 속 단어가 경로로 오인되지 않게.
 * `path:12` / `path:12-30` 처럼 붙는 줄 번호는 떼어 낸 뒤 경로만 모은다.
 */
const PATH_RE = /(?:[\w.@~-]*\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}(?=[:)\],'"`\s]|$)/g;

export function extractFilePaths(text) {
  const out = [];
  for (const raw of flat(text).match(PATH_RE) ?? []) {
    if (raw.includes('://') || raw.startsWith('//')) continue; // URL
    if (raw.includes('node_modules/')) continue;
    out.push(raw);
  }
  return out;
}

/** 메시지 한 건에서 경로 후보를 모은다 — 본문 + 툴 인자의 경로성 필드. */
function messageFilePaths(m) {
  const out = extractFilePaths(m.content);
  for (const tc of m.toolCalls ?? []) {
    const input = tc?.input ?? {};
    for (const key of ['file_path', 'path', 'notebook_path', 'filePath']) {
      if (typeof input[key] === 'string') out.push(input[key]);
    }
    if (typeof input.command === 'string') out.push(...extractFilePaths(input.command));
  }
  return out;
}

const DECISION_RE = /(결정|결론|채택|합의|확정|방침|하기로|대신에|대신\s|선택했|가기로|쓰기로|decided|chose|instead of|we'll use|going with)/i;
const UNRESOLVED_RE = /(TODO|FIXME|XXX|미해결|미완|남은\s*(작업|문제|항목)|보류|실패|에러|오류|안\s*됨|막혔|막힘|확인\s*필요|blocked|failing|failed|error:|not working|⚠️)/i;

/**
 * 줄 단위로 마커에 걸리는 문장만 뽑는다.
 *
 * 메시지 전체를 요약할 수는 없다(LLM 호출 없이 도는 경로다). 대신 사람이 결정과
 * 미해결을 적을 때 실제로 쓰는 어휘를 앵커로 삼아 그 줄만 남긴다. 앞 200자
 * 절단은 이런 줄이 메시지 뒤쪽에 있으면 통째로 버렸다.
 */
function pickLines(text, re, limit = 240) {
  const out = [];
  for (const line of (text ?? '').split('\n')) {
    const t = line.replace(/^[\s>*\-+#|]+/, '').trim();
    if (t.length < 8 || t.length > 600) continue;
    if (!re.test(t)) continue;
    out.push(t.length > limit ? `${t.slice(0, limit)}…` : t);
  }
  return out;
}

/** 뒤쪽 우선으로 중복을 걷어내고 상한까지만 남긴다 (최신이 더 쓸모 있다). */
function tailUnique(items, limit) {
  const seen = new Set();
  const out = [];
  for (let i = items.length - 1; i >= 0 && out.length < limit; i--) {
    const v = items[i];
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.reverse();
}

/** 툴 호출 한 건을 원문 그대로 — 단, 인자 하나가 지나치게 길면 잘라서. */
export function renderToolCall(tc) {
  const name = tc?.name ?? 'unknown';
  const input = tc?.input;
  if (!input || typeof input !== 'object' || Object.keys(input).length === 0) return `\`${name}\``;
  const parts = [];
  for (const [k, v] of Object.entries(input)) {
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    s = s ?? String(v);
    if (s.length > TOOL_ARG_CHARS) s = `${s.slice(0, TOOL_ARG_CHARS)}… (${s.length}자 중 앞부분)`;
    parts.push(`${k}=${s}`);
  }
  return `\`${name}\` ${parts.join(' | ')}`;
}

/** `Edit×2, Bash` — 원문을 못 실을 때 '무엇을 했는지' 만이라도 남기는 형태. */
function toolCountLabel(toolCalls) {
  const counts = {};
  for (const tc of toolCalls) {
    const n = tc?.name ?? 'unknown';
    counts[n] = (counts[n] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
    .join(', ');
}

/**
 * 최근 구간에서 원문으로 실을 툴 호출을 고른다.
 *
 * 예산을 뒤에서부터 소진한다 — 압축 직후 이어서 작업할 때 필요한 것은 방금 무엇을
 * 어떤 인자로 실행했는지이지, 10턴 전의 인자가 아니다.
 */
function selectVerbatimToolCalls(recent) {
  const all = recent.flatMap((m) => m.toolCalls ?? []);
  const selected = new Set();
  let budget = RECENT_TOOL_BUDGET_CHARS;
  for (let i = all.length - 1; i >= 0 && selected.size < MAX_RECENT_TOOL_CALLS; i--) {
    const cost = renderToolCall(all[i]).length + 3;
    if (cost > budget) break;
    budget -= cost;
    selected.add(all[i]);
  }
  return selected;
}

/** 이전 대화용 한 줄 다이제스트 — 앞뒤를 같이 남긴다. 결론은 대개 뒤에 있다. */
function digestMessage(m) {
  const content = flat(m.content);
  const head = content.slice(0, OLDER_HEAD_CHARS);
  const body =
    content.length > OLDER_HEAD_CHARS + OLDER_TAIL_CHARS
      ? `${head} … ${content.slice(-OLDER_TAIL_CHARS)}`
      : content;
  const tcs = m.toolCalls ?? [];
  return tcs.length === 0 ? body : `${body} [${toolCountLabel(tcs)}]`;
}

/**
 * Build the markdown summary that replaces a session's history.
 *
 * 기계적 절단이 아니라 '남겨야 할 것' 을 먼저 뽑고 나머지를 줄인다:
 *   작업 상태 / 관련 파일 / 주요 결정 / 미해결 항목 → 전 구간에서 추출
 *   최근 대화 → 본문 + 툴 호출 인자까지 원문
 *   이전 대화 → 앞뒤 다이제스트 + 사용한 툴 이름
 */
export function buildCompactSummary(session) {
  const msgs = session.messages ?? [];
  const lines = [];
  lines.push(`# 세션 요약 (${session.title})`);
  lines.push(`원본 세션: ${session.id}`);
  lines.push(`에이전트: ${session.agentId}`);
  lines.push(`메시지 수: ${msgs.length}`);
  lines.push(`기간: ${msgs[0]?.ts ?? '?'} ~ ${msgs[msgs.length - 1]?.ts ?? '?'}`);
  lines.push('');

  const older = msgs.slice(0, -RECENT);
  const recent = msgs.slice(-RECENT);

  // ── 작업 상태: 마지막 지시와 마지막 응답의 끝. 압축 후 첫 턴이 "그래서 지금
  //    뭐 하던 중이었지" 로 시작하지 않게 하는 것이 요약의 1순위 역할이다.
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const lastAssistant = [...msgs].reverse().find((m) => m.role !== 'user');
  if (lastUser || lastAssistant) {
    lines.push('## 작업 상태');
    lines.push('');
    if (lastUser) {
      const c = flat(lastUser.content);
      lines.push(`- 마지막 지시: ${c.length > STATE_CHARS ? `${c.slice(0, STATE_CHARS)}…` : c}`);
    }
    if (lastAssistant) {
      const c = flat(lastAssistant.content);
      lines.push(`- 마지막 진행: ${c.length > STATE_CHARS ? `…${c.slice(-STATE_CHARS)}` : c}`);
    }
    lines.push('');
  }

  const files = tailUnique(msgs.flatMap(messageFilePaths), MAX_FILES);
  if (files.length > 0) {
    lines.push('## 관련 파일');
    lines.push('');
    for (const f of files) lines.push(`- \`${f}\``);
    lines.push('');
  }

  const decisions = tailUnique(msgs.flatMap((m) => pickLines(m.content, DECISION_RE)), MAX_DECISIONS);
  if (decisions.length > 0) {
    lines.push('## 주요 결정');
    lines.push('');
    for (const d of decisions) lines.push(`- ${d}`);
    lines.push('');
  }

  const unresolved = tailUnique(msgs.flatMap((m) => pickLines(m.content, UNRESOLVED_RE)), MAX_UNRESOLVED);
  if (unresolved.length > 0) {
    lines.push('## 미해결 항목');
    lines.push('');
    for (const u of unresolved) lines.push(`- ${u}`);
    lines.push('');
  }

  lines.push('## 대화 요약');
  lines.push('');

  if (older.length > 0) {
    const listed = older.slice(-MAX_OLDER_LISTED);
    const dropped = older.length - listed.length;
    lines.push(`### 이전 대화 (${older.length}개 메시지, 압축됨)`);
    if (dropped > 0) {
      lines.push(`_앞쪽 ${dropped}개는 목록에서 생략 — 위 추출 섹션에는 반영됨_`);
    }
    for (const m of listed) {
      const role = m.role === 'user' ? '👤' : '🤖';
      lines.push(`- ${role} ${digestMessage(m)}`);
    }
    lines.push('');
  }

  const verbatimTools = selectVerbatimToolCalls(recent);
  lines.push(`### 최근 대화 (${recent.length}개 메시지, 전문)`);
  lines.push('');
  for (const m of recent) {
    lines.push(`#### ${m.role === 'user' ? '👤 User' : '🤖 Assistant'}`);
    lines.push(m.content ?? '');
    const tcs = m.toolCalls ?? [];
    if (tcs.length > 0) {
      const shown = tcs.filter((tc) => verbatimTools.has(tc));
      const folded = tcs.filter((tc) => !verbatimTools.has(tc));
      lines.push('');
      lines.push('**툴 호출:**');
      if (folded.length > 0) lines.push(`- _앞선 ${folded.length}건 접힘: ${toolCountLabel(folded)}_`);
      for (const tc of shown) lines.push(`- ${renderToolCall(tc)}`);
    }
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
 *   1. 퍼센트 임계 (사용자 설정) — 압축 시점은 오직 이것이 정한다
 *   2. 압축 가치 하한 — MIN_COMPACTABLE_TOKENS 도 안 쌓였으면 줄일 게 없다
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

  const used = usage.used ?? 0;
  if (used < MIN_COMPACTABLE_TOKENS) return false;

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
