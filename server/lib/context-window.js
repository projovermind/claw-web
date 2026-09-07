/**
 * Context-window math — server-side port of client/src/lib/context-window.ts.
 *
 * Kept behaviourally identical so the auto-compact threshold the server applies
 * matches the gauge the user sees in the composer.
 */

/**
 * Heuristic mapping of a model id → max context window (tokens).
 *
 * Claude 4.6 이후의 Opus/Sonnet 과 Fable/Mythos 5 계열은 1M 창이다(기본값이며
 * 베타 게이트 아님). Haiku 는 4.5 기준 200K. 이 구분이 없으면 실측 1M 세션이
 * 200K 로 계산돼 게이지가 500% 를 가리키고, 자동 compact 임계도 무의미해진다.
 */
export function modelContextWindow(model) {
  if (!model) return 200_000;
  const m = String(model).toLowerCase();
  if (/(^|[-_])1m([-_]|$)/.test(m) || m.endsWith('-1m')) return 1_000_000;
  // Legacy small-context models
  if (m.includes('claude-instant')) return 100_000;
  if (m.includes('claude-2.0')) return 100_000;
  if (m.includes('claude-2.1')) return 200_000;
  // Haiku 는 1M 계열에 포함되지 않는다 — Opus/Sonnet 규칙보다 먼저 걸러낸다.
  if (m.includes('haiku')) return 200_000;
  // Opus/Sonnet 4.6+ 및 Opus 5 / Sonnet 5
  if (/claude-(opus|sonnet)-(4-6|4-7|4-8|5)(\b|[-_]|$)/.test(m)) return 1_000_000;
  // Fable / Mythos 5 계열
  if (/claude-(fable|mythos)-5(\b|[-_.]|$)/.test(m)) return 1_000_000;
  return 200_000;
}

/**
 * Resolve a model's context window using, in order:
 *   1. Explicit `contextWindows[model]` on the agent's backend
 *   2. Same lookup across any backend (stale backendId)
 *   3. Heuristic
 *
 * @param {object} backends  map of backendId → backend (backendsStore.getAll() shape)
 * @returns {{tokens:number, source:'backend'|'heuristic'}}
 */
export function resolveContextWindow(model, backendId, backends) {
  if (model && backends && typeof backends === 'object') {
    const preferredHit = backendId ? backends[backendId]?.contextWindows?.[model] : null;
    if (typeof preferredHit === 'number' && preferredHit > 0) {
      return { tokens: preferredHit, source: 'backend' };
    }
    for (const b of Object.values(backends)) {
      const hit = b?.contextWindows?.[model];
      if (typeof hit === 'number' && hit > 0) return { tokens: hit, source: 'backend' };
    }
  }
  return { tokens: modelContextWindow(model), source: 'heuristic' };
}

/**
 * Tokens actually occupying the context window for a finished turn.
 * `contextTokens` (last inner call's prompt size) is the truthful value;
 * older messages only carry the tool-loop SUM, which overflows — cap it.
 */
export function usedContextTokens(usage, max) {
  if (!usage) return 0;
  const ctx = usage.contextTokens;
  if (typeof ctx === 'number' && ctx > 0) return ctx;
  const legacy = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  return max > 0 ? Math.min(legacy, max) : legacy;
}

/**
 * Context load of a session's most recent assistant turn.
 * @returns {{used:number, max:number, pct:number}|null} null when unknown.
 */
export function sessionContextUsage(session, { model, backendId, backends } = {}) {
  const msgs = session?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !m.usage) continue;
    const { tokens: max } = resolveContextWindow(m.model ?? model ?? null, backendId, backends);
    const used = usedContextTokens(m.usage, max);
    if (used <= 0) return null;
    return { used, max, pct: max > 0 ? (used / max) * 100 : 0 };
  }
  return null;
}
