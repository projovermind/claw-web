/**
 * Context-window math — server-side port of client/src/lib/context-window.ts.
 *
 * Kept behaviourally identical so the auto-compact threshold the server applies
 * matches the gauge the user sees in the composer.
 */

/** Heuristic mapping of a model id → max context window (tokens). */
export function modelContextWindow(model) {
  if (!model) return 200_000;
  const m = String(model).toLowerCase();
  if (/(^|[-_])1m([-_]|$)/.test(m) || m.endsWith('-1m')) return 1_000_000;
  if (m.includes('claude-instant')) return 100_000;
  if (m.includes('claude-2.0')) return 100_000;
  if (m.includes('claude-2.1')) return 200_000;
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
