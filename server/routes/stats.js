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

  return router;
}
