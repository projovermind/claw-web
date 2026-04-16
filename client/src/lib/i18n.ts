import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'ko' | 'en';

const DICT: Record<Lang, Record<string, string>> = {
  ko: {
    // Sidebar
    'nav.dashboard': '대시보드',
    'nav.agents': '에이전트',
    'nav.projects': '프로젝트',
    'nav.skills': '스킬',
    'nav.chat': '채팅',
    'nav.settings': '설정',
    'lang.ko': '한국어',
    'lang.en': 'English',

    // Dashboard
    'dashboard.title': '작업 상태',
    'dashboard.stat.agents': '에이전트',
    'dashboard.stat.botStatus': '봇 상태',
    'dashboard.stat.botOnline': '온라인',
    'dashboard.stat.botOffline': '오프라인',
    'dashboard.stat.botPid': 'Bot PID',
    'dashboard.stat.webUptime': 'Web Uptime',
    'dashboard.stat.running': '실행 중',
    'dashboard.stat.sessions': '세션',
    'dashboard.activeRuns': '현재 실행 중',
    'dashboard.noActiveRuns': '지금 돌고 있는 작업 없음',
    'dashboard.recentSessions': '최근 세션',
    'dashboard.noSessions': '세션 기록 없음',
    'dashboard.hierarchy': 'Agent Hierarchy',
    'dashboard.quickAccess': '빠른 접근',
    'dashboard.systemStatus': '시스템 상태',
    'dashboard.uptime': '가동 시간',
    'dashboard.tunnel': '터널',
    'dashboard.backend': '백엔드',
    'dashboard.austerityLabel': '긴축모드',
    'dashboard.on': 'ON',
    'dashboard.off': 'OFF',
    'dashboard.projectActivity': '프로젝트 활동 (24h)',
    'dashboard.noProjectActivity': '24h 이내 활동 없음',
    'dashboard.runningLabel': '실행 중',
    'dashboard.ws.live': 'Live',
    'dashboard.ws.connecting': '연결 중…',
    'dashboard.ws.disconnected': '연결 끊김',
    // Activity Feed
    'activity.title': '활동 피드',
    'activity.empty': '아직 활동 없음. 에이전트를 만들거나 채팅을 시작하면 여기 기록됨.',
    'activity.agentCreated': '에이전트 생성',
    'activity.agentUpdated': '에이전트 수정',
    'activity.agentDeleted': '에이전트 삭제',
    'activity.projectCreated': '프로젝트 생성',
    'activity.projectUpdated': '프로젝트 수정',
    'activity.projectDeleted': '프로젝트 삭제',
    'activity.skillCreated': '스킬 생성',
    'activity.skillUpdated': '스킬 수정',
    'activity.skillDeleted': '스킬 삭제',
    'activity.chatStarted': '채팅 시작',
    'activity.chatDone': '채팅 완료',
    'activity.chatError': '채팅 에러',
    'activity.sessionCreated': '세션 생성',
    'activity.sessionDeleted': '세션 삭제',
    'activity.uploadCreated': '파일 업로드',
    'activity.uploadDeleted': '파일 삭제',
    'activity.backendsUpdated': '백엔드 설정 변경',
    'activity.settingsUpdated': '설정 변경',
    // Agent Stats
    'agentStats.title': '에이전트 사용량',
    'agentStats.empty': '통계 데이터 없음',
    'agentStats.colAgent': '에이전트',
    'agentStats.colSessions': '세션',
    'agentStats.colMsgs': '메시지',
    'agentStats.colTokens': '토큰',
    'agentStats.colLast': '최근',
    // Chat picker
    'chat.picker.main': '메인 에이전트',
    'chat.picker.noLead': '(리드 없음)',

    // Hierarchy
    'hier.unassigned': '미배치 에이전트',
    'hier.search': '미배치 에이전트 검색',
    'hier.empty.unassigned': '미배치 에이전트 없음 — Agents 탭에서 추가하거나 트리에서 이리로 드래그',
    'hier.empty.search': '결과 없음',
    'hier.main': 'Main',
    'hier.main.empty': '최상위 에이전트(하이브마인드)를 드롭하세요',
    'hier.projects': 'Projects',
    'hier.lead': 'Lead',
    'hier.lead.empty': '프로젝트 대표 에이전트 드롭',
    'hier.addons': 'Addons',
    'hier.addons.empty': '에드온 에이전트 드롭',

    // Agents page
    'agents.title': '에이전트',
    'agents.add': '에이전트 추가',
    'agents.add.full': '상세 모달 열기',
    'agents.quickHint': '빠른 생성 — 자세한 설정(systemPrompt, 권한)은 "상세 모달 열기" 또는 생성 후 편집',
    'agents.edit': '편집',
    'agents.delete': '삭제',
    'agents.confirm.delete': '에이전트 "{name}"를 삭제할까요?',
    'agents.help':
      '이름/아바타/모델/AI회사/시스템프롬프트는 여기서 수정해. 위치(프로젝트·계층)는 Dashboard에서 드래그로만 바뀐다. Lightweight Mode ⚡를 켜면 systemPrompt 주입 없이 Claude Code 기본 동작으로 돌아감.',
    'agents.location.moveHint': 'Dashboard에서 이동',
    'agents.location.main': '🟡 Main',
    'agents.location.unassigned': '⚪ Unassigned',
    'agents.lightweight.on': 'Lightweight ON',
    'agents.lightweight.off': 'Lightweight OFF',
    'agents.modal.create': '새 에이전트',
    'agents.modal.edit': '에이전트 편집',
    'agents.field.id': 'ID (고유 식별자)',
    'agents.field.name': '이름',
    'agents.field.avatar': '아바타 (이모지)',
    'agents.field.backend': 'AI 회사 (Backend)',
    'agents.field.model': '모델',
    'agents.field.systemPrompt': 'System Prompt (MD)',
    'agents.field.systemPrompt.placeholder': '에이전트 역할, 규칙, 컨텍스트를 Markdown으로 작성',
    'agents.help.id':
      '이후 변경 불가. 소문자/숫자/하이픈만. `bot.js`의 config.json 키로 사용되고, 채팅 세션 및 디스코드 봇 채널 바인딩에서 식별자로 쓰여.',
    'agents.help.name': '에이전트 카드·팔레트·채팅 피커에 표시되는 사람 읽기용 이름. 공백/한글/이모지 OK.',
    'agents.help.avatar':
      '카드·메시지 말풍선에 앞에 붙는 이모지 1~2자. 시각 구분용 — 없으면 🤖 기본.',
    'agents.help.backend':
      '이 에이전트가 어느 LLM 제공자를 쓸지. "Claude (CLI)"는 Claude Code의 `claude -p`를 자식 프로세스로 호출 (OAuth 키체인 사용). 다른 백엔드는 Settings → AI Backends에서 추가한 뒤 여기서 선택.',
    'agents.help.model':
      '짧은 별칭(opus/sonnet/haiku) → 내부에서 실제 모델 ID로 변환. haiku는 Sonnet 4.6로 강제 대체됨 (bot 정책).',
    'agents.help.systemPrompt':
      '모든 호출의 시작에 `--append-system-prompt`로 주입됨. 에이전트 역할, 접근 권한, 프로젝트 컨텍스트, 빌드/배포 명령 등 Markdown으로 자유 기재. ⚡Lightweight Mode를 ON하면 이게 무시되고 workingDir의 CLAUDE.md가 대신 주입됨.',
    'common.cancel': '취소',
    'common.save': '저장',
    'common.create': '생성',
    'common.saving': '저장 중…',

    // Settings
    'settings.title': 'Settings',
    'settings.tab.backends': 'AI Backends',
    'settings.tab.access': 'Access & Tokens',
    'settings.tab.features': 'Features',
    'settings.global': 'Global',
    'settings.activeBackend': 'Active Backend',
    'settings.austerity': '긴축모드 (Austerity)',
    'settings.austerity.hint':
      '긴축모드가 ON이면 모든 채팅 호출이 해당 백엔드로 강제 라우팅됨.',
    'settings.backends.add': '백엔드 추가',
    'settings.backends.new': '새 Backend (OpenAI-compatible)',
    'settings.access.title': '원격 접속 인증',
    'settings.access.hint':
      'Tailscale/Cloudflare Tunnel로 웹을 외부 노출할 때 ON. OFF면 인증 없이 바로 접근 가능(로컬 전용).',
    'settings.access.token': 'Bearer Token 변경',
    'settings.access.token.new': '새 토큰 (영문/숫자 16자 이상 권장)',
    'settings.access.token.set': '설정됨',
    'settings.access.token.unset': '미설정',
    'settings.access.token.remove': '토큰 제거',
    'settings.access.restart':
      '토큰 강제 적용은 서버 재시작 후 활성화.',
    'settings.features.hint':
      '각 기능은 개별 토글 가능. OFF로 바꾸면 사이드바에서 숨겨지고 해당 API도 비활성(Phase 4).'
  },

  en: {
    'nav.dashboard': 'Dashboard',
    'nav.agents': 'Agents',
    'nav.projects': 'Projects',
    'nav.skills': 'Skills',
    'nav.chat': 'Chat',
    'nav.settings': 'Settings',
    'lang.ko': '한국어',
    'lang.en': 'English',

    'dashboard.title': 'Work Status',
    'dashboard.stat.agents': 'Agents',
    'dashboard.stat.botStatus': 'Bot Status',
    'dashboard.stat.botOnline': 'Online',
    'dashboard.stat.botOffline': 'Offline',
    'dashboard.stat.botPid': 'Bot PID',
    'dashboard.stat.webUptime': 'Web Uptime',
    'dashboard.stat.running': 'Running',
    'dashboard.stat.sessions': 'Sessions',
    'dashboard.activeRuns': 'Active runs',
    'dashboard.noActiveRuns': 'No active runs',
    'dashboard.recentSessions': 'Recent sessions',
    'dashboard.noSessions': 'No sessions yet',
    'dashboard.hierarchy': 'Agent Hierarchy',
    'dashboard.quickAccess': 'Quick Access',
    'dashboard.systemStatus': 'System Status',
    'dashboard.uptime': 'Uptime',
    'dashboard.tunnel': 'Tunnel',
    'dashboard.backend': 'Backend',
    'dashboard.austerityLabel': 'Austerity',
    'dashboard.on': 'ON',
    'dashboard.off': 'OFF',
    'dashboard.projectActivity': 'Project Activity (24h)',
    'dashboard.noProjectActivity': 'No activity in 24h',
    'dashboard.runningLabel': 'running',
    'dashboard.ws.live': 'Live',
    'dashboard.ws.connecting': 'Connecting…',
    'dashboard.ws.disconnected': 'Disconnected',
    'activity.title': 'Activity Feed',
    'activity.empty': 'No activity yet. Create an agent or start a chat to see logs here.',
    'activity.agentCreated': 'Agent created',
    'activity.agentUpdated': 'Agent updated',
    'activity.agentDeleted': 'Agent deleted',
    'activity.projectCreated': 'Project created',
    'activity.projectUpdated': 'Project updated',
    'activity.projectDeleted': 'Project deleted',
    'activity.skillCreated': 'Skill created',
    'activity.skillUpdated': 'Skill updated',
    'activity.skillDeleted': 'Skill deleted',
    'activity.chatStarted': 'Chat started',
    'activity.chatDone': 'Chat done',
    'activity.chatError': 'Chat error',
    'activity.sessionCreated': 'Session created',
    'activity.sessionDeleted': 'Session deleted',
    'activity.uploadCreated': 'File uploaded',
    'activity.uploadDeleted': 'File deleted',
    'activity.backendsUpdated': 'Backend config changed',
    'activity.settingsUpdated': 'Settings changed',
    'agentStats.title': 'Agent Usage',
    'agentStats.empty': 'No stats data',
    'agentStats.colAgent': 'Agent',
    'agentStats.colSessions': 'Sessions',
    'agentStats.colMsgs': 'Msgs',
    'agentStats.colTokens': 'Tokens',
    'agentStats.colLast': 'Last',
    'chat.picker.main': 'Main Agents',
    'chat.picker.noLead': '(no lead)',

    'hier.unassigned': 'Unassigned Agents',
    'hier.search': 'Search unassigned agents',
    'hier.empty.unassigned':
      'No unassigned agents — add one in the Agents tab, or drag a placed agent here',
    'hier.empty.search': 'No results',
    'hier.main': 'Main',
    'hier.main.empty': 'Drop the top-level agent (Hivemind) here',
    'hier.projects': 'Projects',
    'hier.lead': 'Lead',
    'hier.lead.empty': 'Drop project lead here',
    'hier.addons': 'Addons',
    'hier.addons.empty': 'Drop addon agents here',

    'agents.title': 'Agents',
    'agents.add': 'Add agent',
    'agents.add.full': 'Open full modal',
    'agents.quickHint':
      'Quick create — for advanced settings (systemPrompt, permissions) use "Open full modal" or edit after creation',
    'agents.edit': 'Edit',
    'agents.delete': 'Delete',
    'agents.confirm.delete': 'Delete agent "{name}"?',
    'agents.help':
      'Edit name/avatar/model/AI company/system prompt here. Location (project/tier) is changed only via drag-and-drop in the Dashboard. Lightweight Mode ⚡ skips systemPrompt injection and falls back to Claude Code default behavior.',
    'agents.location.moveHint': 'move via Dashboard',
    'agents.location.main': '🟡 Main',
    'agents.location.unassigned': '⚪ Unassigned',
    'agents.lightweight.on': 'Lightweight ON',
    'agents.lightweight.off': 'Lightweight OFF',
    'agents.modal.create': 'New agent',
    'agents.modal.edit': 'Edit agent',
    'agents.field.id': 'ID (unique identifier)',
    'agents.field.name': 'Name',
    'agents.field.avatar': 'Avatar (emoji)',
    'agents.field.backend': 'AI Company (Backend)',
    'agents.field.model': 'Model',
    'agents.field.systemPrompt': 'System Prompt (MD)',
    'agents.field.systemPrompt.placeholder':
      'Describe the agent role, rules, and context in Markdown',
    'agents.help.id':
      "Immutable after creation. Lowercase / digits / hyphen only. Used as the config.json key and as the identifier for chat sessions and Discord bot channel bindings.",
    'agents.help.name':
      'Human-readable name shown on cards, palette, and chat picker. Spaces and Unicode allowed.',
    'agents.help.avatar':
      '1-2 emoji chars prepended to card and chat bubbles for visual distinction. Defaults to 🤖.',
    'agents.help.backend':
      'Which LLM provider this agent uses. "Claude (CLI)" spawns Claude Code via `claude -p` as a child process (using keychain OAuth). Custom backends can be added in Settings → AI Backends.',
    'agents.help.model':
      'Short alias (opus/sonnet/haiku) translated to the full model ID at runtime. haiku is force-replaced with Sonnet 4.6 per bot policy.',
    'agents.help.systemPrompt':
      'Injected on every call via `--append-system-prompt`. Describe the role, access, project context, build/deploy commands as free-form Markdown. ⚡Lightweight Mode skips this and falls back to the workingDir\'s CLAUDE.md.',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.create': 'Create',
    'common.saving': 'Saving…',

    'settings.title': 'Settings',
    'settings.tab.backends': 'AI Backends',
    'settings.tab.access': 'Access & Tokens',
    'settings.tab.features': 'Features',
    'settings.global': 'Global',
    'settings.activeBackend': 'Active Backend',
    'settings.austerity': 'Austerity Mode',
    'settings.austerity.hint':
      'When austerity mode is ON, all chat calls are forced to route through the selected backend.',
    'settings.backends.add': 'Add backend',
    'settings.backends.new': 'New Backend (OpenAI-compatible)',
    'settings.access.title': 'Remote Access Auth',
    'settings.access.hint':
      'Turn ON when exposing the web via Tailscale/Cloudflare Tunnel. OFF means open access (local only).',
    'settings.access.token': 'Bearer Token',
    'settings.access.token.new': 'New token (16+ alphanumeric chars recommended)',
    'settings.access.token.set': 'set',
    'settings.access.token.unset': 'unset',
    'settings.access.token.remove': 'Remove token',
    'settings.access.restart': 'Token enforcement takes effect after server restart.',
    'settings.features.hint':
      'Each feature can be toggled individually. OFF hides it from the sidebar and disables the API (Phase 4).'
  }
};

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
}

export const useI18nStore = create<I18nState>()(
  persist(
    (set) => ({
      lang: 'ko',
      setLang: (lang) => set({ lang })
    }),
    { name: 'claw-lang' }
  )
);

export function useT() {
  const lang = useI18nStore((s) => s.lang);
  return (key: string, vars?: Record<string, string | number>) => {
    const raw = DICT[lang][key] ?? DICT.ko[key] ?? key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
  };
}
