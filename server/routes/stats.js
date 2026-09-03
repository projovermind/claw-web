import { Router } from 'express';

/** 로컬 타임존 기준 YYYY-MM-DD */
function localDayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 부동소수 누적 오차가 UI 로 새지 않도록 6자리 반올림 */
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function roundAll(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = round6(v);
  return out;
}

export function createStatsRouter({ sessionsStore, configStore, webConfig }) {
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

    // Accumulate stats from sessions — archived 세션 및 configStore에 없는 agentId 제외
    for (const session of allSessions) {
      const aid = session.agentId;
      if (!agentMap.has(aid)) continue; // 삭제된 에이전트 세션은 스킵
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

  // GET /api/stats/usage — 5시간/주간 rolling 토큰 사용량 + 비용(costUsd) 집계
  router.get('/usage', (_req, res) => {
    const now = Date.now();
    const window5h = now - 5 * 60 * 60 * 1000;
    const window7d = now - 7 * 24 * 60 * 60 * 1000;
    const window30d = now - 30 * 24 * 60 * 60 * 1000;

    let input5h = 0, output5h = 0;
    let input7d = 0, output7d = 0;
    let cost7d = 0, cost30d = 0;
    const costByAgent = {};
    const costByDay = {};
    const costByAccount = {};

    const agentsObj = configStore.getAgents ? configStore.getAgents() : {};
    // 메시지에는 백엔드 정보가 없으므로 에이전트 설정의 backendId 로 귀속한다.
    const accountOfAgent = (agentId) => {
      const a = agentsObj[agentId];
      return a?.backendId ?? a?.accountId ?? 'default';
    };

    for (const session of sessionsStore.list()) {
      const agentId = session.agentId ?? 'unknown';
      for (const m of session.messages ?? []) {
        if (!m.usage || !m.ts) continue;
        const ts = new Date(m.ts).getTime();
        if (isNaN(ts)) continue;
        const inp = m.usage.inputTokens ?? 0;
        const out = m.usage.outputTokens ?? 0;
        // 과거 메시지에는 costUsd 가 없다 → 0
        const cost = typeof m.usage.costUsd === 'number' ? m.usage.costUsd : 0;
        if (ts >= window7d) { input7d += inp; output7d += out; }
        if (ts >= window5h) { input5h += inp; output5h += out; }
        if (cost > 0 && ts >= window30d) {
          cost30d += cost;
          if (ts >= window7d) cost7d += cost;
          costByAgent[agentId] = (costByAgent[agentId] ?? 0) + cost;
          const day = localDayKey(ts);
          costByDay[day] = (costByDay[day] ?? 0) + cost;
          const acct = accountOfAgent(agentId);
          costByAccount[acct] = (costByAccount[acct] ?? 0) + cost;
        }
      }
    }

    res.json({
      window5h: { inputTokens: input5h, outputTokens: output5h, total: input5h + output5h },
      window7d: { inputTokens: input7d, outputTokens: output7d, total: input7d + output7d },
      // 0 = 미설정 (UI 는 게이지 대신 숫자만 표시)
      budget: {
        tokens5h: webConfig?.usage?.budget5h ?? 0,
        tokens7d: webConfig?.usage?.budget7d ?? 0
      },
      cost: {
        window7d: round6(cost7d),
        window30d: round6(cost30d),
        byAgent: roundAll(costByAgent),
        byDay: roundAll(costByDay),
        byAccount: roundAll(costByAccount)
      }
    });
  });

  return router;
}
