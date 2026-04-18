import { Router } from 'express';

export function createStatsRouter({ sessionsStore, configStore }) {
  const router = Router();

  // GET /api/stats/agents — per-agent usage statistics
  router.get('/agents', (_req, res) => {
    const allSessions = sessionsStore.list();
    const agentsObj = configStore.getAgents ? configStore.getAgents() : {};
    const agentMap = new Map();

    // Initialize from known agents
    for (const [id, a] of Object.entries(agentsObj)) {
      agentMap.set(id, {
        id,
        name: a.name ?? id,
        sessionCount: 0,
        messageCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        lastActive: null,
      });
    }

    // Accumulate stats from sessions
    for (const session of allSessions) {
      const aid = session.agentId;
      if (!agentMap.has(aid)) {
        agentMap.set(aid, {
          id: aid,
          name: aid,
          sessionCount: 0,
          messageCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          lastActive: null,
        });
      }
      const entry = agentMap.get(aid);
      entry.sessionCount += 1;
      const msgs = session.messages ?? [];
      entry.messageCount += msgs.length;
      for (const m of msgs) {
        if (m.usage) {
          entry.totalInputTokens += m.usage.inputTokens ?? 0;
          entry.totalOutputTokens += m.usage.outputTokens ?? 0;
        }
      }
      const ts = session.updatedAt ?? session.createdAt;
      if (ts && (!entry.lastActive || ts > entry.lastActive)) {
        entry.lastActive = ts;
      }
    }

    const result = Array.from(agentMap.values()).sort(
      (a, b) => (b.totalInputTokens + b.totalOutputTokens) - (a.totalInputTokens + a.totalOutputTokens)
    );
    res.json({ agents: result });
  });

  // GET /api/stats/usage — 5시간/주간 rolling 토큰 사용량
  router.get('/usage', (_req, res) => {
    const now = Date.now();
    const window5h = now - 5 * 60 * 60 * 1000;
    const window7d = now - 7 * 24 * 60 * 60 * 1000;

    let input5h = 0, output5h = 0;
    let input7d = 0, output7d = 0;

    for (const session of sessionsStore.list()) {
      for (const m of session.messages ?? []) {
        if (!m.usage || !m.ts) continue;
        const ts = new Date(m.ts).getTime();
        if (isNaN(ts)) continue;
        const inp = m.usage.inputTokens ?? 0;
        const out = m.usage.outputTokens ?? 0;
        if (ts >= window7d) { input7d += inp; output7d += out; }
        if (ts >= window5h) { input5h += inp; output5h += out; }
      }
    }

    res.json({
      window5h: { inputTokens: input5h, outputTokens: output5h, total: input5h + output5h },
      window7d: { inputTokens: input7d, outputTokens: output7d, total: input7d + output7d }
    });
  });

  return router;
}
