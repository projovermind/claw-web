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
  //   권장 85. 압축 시점은 이 퍼센트가 정한다. compact.js 는 '줄일 게 있는가'
  //   (MIN_COMPACTABLE_TOKENS 100K)와 재압축 히스테리시스만 추가로 본다.
  // delegationRetentionDays: 완료된 '[위임]' 워커 세션을 며칠 뒤 정리할지. 0 = 끄기.
  // delegationRetentionDryRun: true 면 실제 삭제 대신 대상 수만 로깅.
  // delegationReuse: 같은 플래너가 같은 에이전트에게 다시 위임할 때 직전 워커 세션을
  //   --resume 으로 재사용해 콜드스타트(페르소나 재주입 + 코드베이스 재탐색)를 없앤다.
  //   false 면 위임마다 새 워커 세션 (구 동작).
  // delegationReuseTtlMin: 직전 작업을 끝낸 지 이 분(分) 을 넘긴 워커 세션은 재사용하지
  //   않는다. 기준은 '위임을 보낸 시각' 이 아니라 '끝난 시각' — 실측 재위임 간격이
  //   48/53/91분이라 30분으로는 적중할 수가 없었다.
  // delegationReuseMaxUses: 한 워커 세션에 밀어 넣을 수 있는 위임 수(최초 1건 포함).
  //   넘으면 새 세션으로 로테이션한다 — 무한 재사용은 컨텍스트가 쌓여 압축을 부른다.
  // worktreeIsolation: maxConcurrent>1 인 에이전트의 워커마다 전용 git worktree 를
  //   붙여 동시 편집 충돌을 없앤다. false(기본) 면 지금까지처럼 모든 워커가 원본
  //   workingDir 을 공유한다 — 쓰기 작업 에이전트는 maxConcurrent 1 로 둘 것.
  // worktreeRoot: 슬롯 디렉토리를 만들 위치. 기본 ~/.claw-web/worktrees.
  //   레포 안에 두면 main 트리의 glob(테스트 탐색 등)이 슬롯 사본까지 집어삼킨다.
  // worktreeLinks: 새 worktree 에 primary 에서 symlink 로 끌어올 gitignore 된
  //   디렉토리. worktree 는 tracked 파일만 체크아웃하므로 이것 없이는 워커가
  //   빌드/테스트를 못 돈다.
  // worktreeIncludePrimary: true(기본) 면 slot 0 = 원본 workingDir — 워커 한 명은
  //   지금처럼 공유 트리에서 일한다(변경이 바로 보인다). false 면 모든 워커가
  //   worktree 로 빠져 공유 트리는 사람/리드 세션 전용이 된다.
  chat: {
    autoCompactPct: 0,
    delegationRetentionDays: 30,
    delegationRetentionDryRun: true,
    delegationReuse: true,
    delegationReuseTtlMin: 90,
    delegationReuseMaxUses: 5,
    worktreeIsolation: false,
    worktreeRoot: null,
    worktreeLinks: ['node_modules'],
    worktreeIncludePrimary: true
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
