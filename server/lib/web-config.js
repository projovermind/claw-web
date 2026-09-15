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
  //   권장 85. 퍼센트와 함께 compact.js 의 MIN_HEADROOM_TOKENS(150K) 절대 하한도 걸리므로,
  //   1M 창에서 50 처럼 낮은 값을 넣어도 여유 150K 미만이 아니면 압축되지 않는다.
  //   (이 하한이 없던 시절 1M 창 + 50% 조합으로 한 세션이 15시간에 32회 압축됐다.)
  // delegationRetentionDays: 완료된 '[위임]' 워커 세션을 며칠 뒤 정리할지. 0 = 끄기.
  // delegationRetentionDryRun: true 면 실제 삭제 대신 대상 수만 로깅.
  // delegationReuse: 같은 플래너가 같은 에이전트에게 다시 위임할 때 직전 워커 세션을
  //   --resume 으로 재사용해 콜드스타트(페르소나 재주입 + 코드베이스 재탐색)를 없앤다.
  //   false 면 위임마다 새 워커 세션 (구 동작).
  // delegationReuseTtlMin: 마지막으로 쓴 지 이 분(分) 을 넘긴 워커 세션은 재사용하지 않는다.
  // delegationReuseMaxUses: 한 워커 세션에 밀어 넣을 수 있는 위임 수(최초 1건 포함).
  //   넘으면 새 세션으로 로테이션한다 — 무한 재사용은 컨텍스트가 쌓여 압축을 부른다.
  chat: {
    autoCompactPct: 0,
    delegationRetentionDays: 30,
    delegationRetentionDryRun: true,
    delegationReuse: true,
    delegationReuseTtlMin: 30,
    delegationReuseMaxUses: 5
  },
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
