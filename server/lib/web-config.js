import fs from 'node:fs';

const DEFAULTS = {
  port: 3838,
  features: {
    dashboard: true,
    agentsPage: true,
    dragAndDrop: true,
    chat: true,
    activityFeed: true,
    mdEditor: false,
    logsViewer: false,
    tokenManager: false
  },
  auth: { enabled: false, token: null },
  editor: { scheme: 'vscode', pathMap: {} },
  // autoCompactPct: 0 = 끄기. >0 이면 턴 종료 후 컨텍스트 사용률이 이 % 이상일 때 자동 compact.
  chat: { autoCompactPct: 0 },
  // 토큰 예산 (0 = 미설정). GET /api/stats/usage 가 budget 으로 되돌려 준다.
  usage: { budget5h: 0, budget7d: 0 }
};

export function loadWebConfig(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    ...DEFAULTS,
    ...parsed,
    features: { ...DEFAULTS.features, ...(parsed.features ?? {}) },
    auth: { ...DEFAULTS.auth, ...(parsed.auth ?? {}) },
    editor: { ...DEFAULTS.editor, ...(parsed.editor ?? {}) },
    chat: { ...DEFAULTS.chat, ...(parsed.chat ?? {}) },
    usage: { ...DEFAULTS.usage, ...(parsed.usage ?? {}) }
  };
}
