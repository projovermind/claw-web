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
    'agents.moveLabel': '이동 / 관리',
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
    'settings.title': '설정',
    'settings.tab.backends': 'AI 백엔드',
    'settings.tab.access': '접근/토큰',
    'settings.tab.features': '기능',
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
      '각 기능은 개별 토글 가능. OFF로 바꾸면 사이드바에서 숨겨지고 해당 API도 비활성(Phase 4).',

    // Common
    'common.close': '닫기',
    'common.add': '추가',
    'common.edit': '편집',
    'common.delete': '삭제',
    'common.remove': '제거',
    'common.removeAll': '전체 제거',
    'common.loading': '로딩 중...',
    'common.searching': '검색 중…',
    'common.updating': '업데이트 중…',
    'common.new': '새',
    'common.find': '찾기',
    'common.refresh': '새로고침',
    'common.selectFolder': '폴더 선택',
    'common.noResults': '결과 없음',
    'common.conflict': '충돌 감지',
    'common.overwriteWithMine': '내 수정으로 덮어쓰기',
    'common.reloadFromDisk': '디스크에서 다시 불러오기',
    'common.error': '오류 발생',
    'common.imageLoadFail': '이미지 로드 실패',

    // Projects page
    'projects.title': 'Projects',
    'projects.intro':
      '프로젝트는 대시보드 계층 트리에서 에이전트가 배치되는 버킷이야. 여기 등록된 path가 해당 프로젝트에 배치된 에이전트의 workingDir로 자동 동기화됨. 📁 경로 수정해도 실제 폴더는 건드리지 않아 — projects.json 참조값만 바뀌고, 배치된 에이전트 workingDir이 cascade 업데이트돼.',
    'projects.add': '+ 프로젝트 추가',
    'projects.create': '프로젝트 생성',
    'projects.dashboard': '프로젝트 대시보드',
    'projects.dashboardHint': '프로젝트를 클릭하면 대시보드가 열립니다',
    'projects.statProjects': '프로젝트',
    'projects.statPlaced': '배치된 에이전트',
    'projects.statUnassigned': '미배치',
    'projects.fieldId': 'ID',
    'projects.fieldIdHelp': '이후 변경 불가. 소문자/숫자/하이픈만.',
    'projects.fieldName': '이름',
    'projects.fieldNameHelp': '대시보드에 표시되는 이름.',
    'projects.fieldPath': '경로 (Path)',
    'projects.fieldPathHelp': '절대 경로. Claude CLI의 cwd로 쓰이고 CLAUDE.md가 자동 로드됨.',
    'projects.fieldColor': '색상',
    'projects.fieldColorHelp': '카드 헤더 엑센트.',
    'projects.dragHint': '드래그로 순서 변경',
    'projects.edit': '프로젝트 편집',
    'projects.idImmutable': 'ID (변경 불가)',
    'projects.pathChangeHelp':
      '수정 시 이 프로젝트에 배치된 에이전트의 workingDir이 자동 cascade 업데이트됨. 실제 폴더는 건드리지 않음.',
    'projects.defaultSkills': '기본 스킬 (Default Skills)',
    'projects.defaultSkillsHelp':
      '이 프로젝트에 배치된 모든 에이전트(Lead + Addon)가 자동 상속함. 에이전트 개별 설정에서 추가 스킬을 더할 수는 있지만 상속된 스킬은 빼지 못해. 전역 일괄 분배에 최적.',
    'projects.defaultSkillsInherit': '💡 배치된 에이전트 {count}명이 이 스킬들을 자동으로 받게 돼.',
    'projects.defaultAllowedTools': '기본 허용 도구 (Default Allowed Tools)',
    'projects.defaultAllowedToolsHelp':
      '이 프로젝트의 모든 에이전트가 자동으로 호출할 수 있는 Claude 도구. 에이전트 개별 설정에서 추가로 도구를 더할 수는 있음. 비우면 상속 없음(Claude 기본값).',
    'projects.defaultDisallowedTools': '기본 차단 도구 (Default Disallowed Tools)',
    'projects.defaultDisallowedToolsHelp':
      '이 프로젝트의 모든 에이전트가 절대 못 쓰는 도구. 에이전트 개별 설정보다 우선. 예: router 계열 에이전트는 Edit/Write/Bash 차단.',
    'projects.pathChangeWarn':
      '경로를 변경하면 이 프로젝트에 배치된 {count}개 에이전트의 workingDir이 새 경로로 자동 업데이트됨. 실제 폴더는 건드리지 않아.',
    'projects.settings': '설정',
    'projects.mdLoading': '로딩 중...',
    'projects.mdErrorPrefix': '에러',
    'projects.mdNoFile': '⚠ 파일 없음 — 저장하면 새로 생성됨',
    'projects.mdSaveToFile': '파일에 저장',
    'projects.mdConflictPrompt':
      '파일이 외부에서 수정됐어. 디스크에 있는 최신 내용을 무조건 덮어쓸까, 아니면 다시 불러올까?',
    'projects.mdEditorHint':
      '💡 이 파일은 해당 프로젝트 폴더의 CLAUDE.md. Claude CLI가 이 프로젝트를 cwd로 실행할 때 자동으로 로드해서 컨텍스트로 쓰임. Lightweight Mode 에이전트는 이 내용이 systemPrompt 역할을 해. 저장 시 실제 파일 시스템에 쓰여.',
    'projects.mdPlaceholder':
      '# 프로젝트 이름\n\n## 기술 스택\n- ...\n\n## 빌드 & 배포\n```bash\n...\n```\n\n## 에이전트 가이드라인\n- ...',
    'projects.editTitle': '프로젝트 편집:',
    'projects.cardDragReorder': '드래그로 순서 변경',
    'projects.confirmDelete':
      '"{name}" 프로젝트를 삭제할까요?\n\n파일 시스템 폴더는 건드리지 않아 — projects.json 항목만 제거됨.',
    'projects.confirmDeleteWithAgents':
      '"{name}" 프로젝트를 삭제할까요?\n\n⚠️ 이 프로젝트에 {count}개 에이전트가 배치돼 있어. 삭제하면 그 에이전트들은 자동으로 "미배치"로 돌아가. (파일 시스템 폴더는 건드리지 않아 — projects.json 항목만 제거됨)',

    // Project dashboard widgets
    'projects.notes': '메모',
    'projects.notesPlaceholder': '프로젝트 메모, 목표, 주의사항 등을 자유롭게 작성...',
    'projects.notesEmpty': '메모 없음 — 편집 버튼을 눌러 작성하세요',
    'projects.goals': '목표',
    'projects.goalInput': '목표 입력...',
    'projects.timeline': '에이전트 타임라인',
    'projects.timelineAgentCount': '{count}명',
    'projects.timelineEmpty': '최근 활동 없음',
    'projects.tokenUsage': '토큰 사용량',
    'projects.customWidgets': '커스텀 위젯',
    'projects.widgetsEmpty': '위젯 없음 — 추가 버튼으로 URL, 메모 등을 고정하세요',
    'projects.widgetTitle': '위젯 제목',
    'projects.widgetLink': '링크',
    'projects.widgetText': '텍스트',
    'projects.widgetKV': '키-값',
    'projects.widgetKVPlaceholder': 'KEY=VALUE (줄바꿈 구분)',
    'projects.widgetMd': '마크다운',
    'projects.widgetTextPlaceholder': '내용 입력',
    'projects.widgetMdPlaceholder': '## 제목\n내용...',
    'projects.agentCount': '🤖',
    'projects.msgCount': '{count}개',

    // Agents page extras
    'agents.totalLabel': '총',
    'agents.create': '⊕ 새 에이전트',
    'agents.quickId': 'id',
    'agents.quickAvatarPlaceholder': '🤖',
    'agents.clonePrompt': '복제할 에이전트의 새 ID를 입력하세요 (소문자/숫자/하이픈/언더스코어만):',
    'agents.conflictConfirm':
      '이 에이전트가 다른 창/탭에서 수정됐어.\n\n확인: 내 수정으로 덮어쓰기\n취소: 취소하고 최신 상태 불러오기',
    'agents.saveFailed': '저장 실패',
    'agents.namePlaceholder': '하이브마인드, 알고리즘 개발자...',
    'agents.toolsTitle': '도구 설정',
    'agents.toolsDesc': '이 에이전트가 호출할 수 있는 Claude 도구를 제한. Claude CLI에',
    'agents.toolsDescInherit': '프로젝트 {name}의 기본 도구가 자동 상속됨 (↑ 표시).',
    'agents.allowedTools': '허용 도구 (allowedTools)',
    'agents.allowedToolsHelp': '체크된 도구만 Claude가 호출 가능. 비어있으면 Claude 기본값 (전부 허용).',
    'agents.disallowedTools': '차단 도구 (disallowedTools)',
    'agents.disallowedToolsHelp': '체크된 도구는 명시적으로 차단. allowedTools보다 우선. 예: router 에이전트는 Edit/Write/Bash 차단.',
    'agents.skills': 'Skills',
    'agents.skillsHelpWithInherit':
      '선택된 스킬들이 채팅 호출 시 systemPrompt에 concat돼. 현재 프로젝트의 기본 스킬 {count}개는 자동 상속됨 (체크 해제 불가).',
    'agents.skillsHelpNoInherit':
      '선택된 스킬들이 채팅 호출 시 systemPrompt에 concat됨. 프로젝트에 배치하면 해당 프로젝트의 기본 스킬이 자동 상속돼.',
    'agents.modal.locationHint':
      '이름/아바타/모델/AI회사/시스템프롬프트는 여기서 수정. 위치(프로젝트·계층)는 Dashboard에서 드래그로만 바뀐다.',

    // Chat page
    'chat.sessionSelectHint': '프로젝트를 선택하고 세션을 시작하세요',
    'chat.loading': 'Loading...',
    'chat.running': 'running',
    'chat.searchPlaceholder': '메시지 검색...',
    'chat.attachmentHeader': '[첨부 파일]',
    'chat.attachmentFooter': '위 경로의 파일들을 Read 도구로 확인해주세요.',
    'chat.escalation': '에스컬레이션',
    'chat.loopStopConfirm': '루프 중단?',
    'chat.clearConfirm': '현재 세션을 삭제하고 새로 시작할까?',
    'chat.renamePrompt': '새 세션 제목:',
    'chat.exportFailed': 'Export 실패',
    'chat.helpMessage':
      '사용 가능한 명령어:\n\n/commit — 커밋\n/review — 코드 리뷰\n/test — 테스트\n/plan — 계획\n/fix — 버그 수정\n/loop — Ralph Loop\n/run — Background task\n/clear — 세션 초기화\n/new — 새 세션\n/rename — 이름 변경\n/export — 내보내기\n/pin — 고정\n/search — 검색\n/help — 도움말',
    'chat.mobileProject': '프로젝트',
    'chat.mobileGlobal': '글로벌',
    'chat.mobileSessionSelect': '세션 선택',
    'chat.mobileNewSession': '새 세션',
    'chat.mobileNoSessions': '세션 없음',
    'chat.pin': '고정',
    'chat.unpin': '고정 해제',
    'chat.thinkingEffort': 'Thinking Effort',

    // Chat sidebar
    'chat.sidebar.project': '프로젝트',
    'chat.sidebar.recentSessions': '최근 세션',
    'chat.sidebar.selectProject': '프로젝트 선택',
    'chat.sidebar.sessions': '세션',
    'chat.sidebar.noSessions': '세션 없음',
    'chat.sidebar.deleteCount': '{count}개 삭제',
    'chat.sidebar.deleteCountConfirm': '{count}개 세션을 삭제할까?',
    'chat.sidebar.multiSelect': '다중 선택',
    'chat.sidebar.deleteConfirm': '"{title}" 삭제?',
    'chat.sidebar.exportFailed': 'Export 실패',

    // Chat input
    'chat.input.uploading': '업로드 중…',
    'chat.input.attached': '첨부됨 · {count}개',
    'chat.input.disabledPlaceholder': '세션을 선택하세요',
    'chat.input.placeholder': '메시지 입력 · / 커맨드 · @파일',
    'chat.input.taskFailed': '태스크 시작 실패',
    'chat.input.loopFailed': '루프 시작 실패',
    'chat.input.attachOnly': '(파일만 첨부)',
    'chat.input.attachBtn': '파일 첨부',
    'chat.input.abortBtn': '중단',
    'chat.input.sendBtn': '전송',

    // At-file popover
    'atfile.noWorkingDir': '에이전트의 workingDir이 설정돼 있지 않아서 파일 검색 불가',
    'atfile.searchPrompt': '파일명을 입력하면 프로젝트 내 파일을 검색합니다',

    // Agent picker popover
    'agentPicker.selectPlaceholder': '— 에이전트 선택 —',
    'agentPicker.searchPlaceholder': '이름 / id / 모델 / 프로젝트 검색',
    'agentPicker.main': 'Main',
    'agentPicker.unassigned': 'Unassigned',
    'agentPicker.summary': '{agents}개 에이전트 · {projects}개 프로젝트',

    // Streaming message
    'stream.generating': '응답 생성 중…',
    'stream.toolProgress': '작업 {count}단계 · 진행 중…',

    // Tool call card
    'tools.removed': '- 삭제',
    'tools.added': '+ 추가',
    'tools.read': '읽기',
    'tools.writeFull': '전체 쓰기',
    'tools.download': '다운로드',
    'tools.emptyEdit': 'empty edit',

    // Skills page
    'skills.title': '스킬',
    'skills.intro':
      '스킬은 재사용 가능한 Markdown 지침. 에이전트 편집 모달에서 선택하면, 채팅 호출 시 선택된 스킬들의 본문이',
    'skills.introSuffix': '에 concat되어 주입돼. 여러 에이전트가 같은 스킬을 공유 가능 (TDD 워크플로, 코드 리뷰 규칙, 배포 체크리스트 등).',
    'skills.add': '+ 스킬 추가',
    'skills.namePlaceholder': '이름 (예: TDD Workflow)',
    'skills.descPlaceholder': '설명 (한 줄)',
    'skills.createEmpty': '생성 (빈 본문)',
    'skills.searchPlaceholder': '스킬 검색',
    'skills.mySkills': '내 스킬',
    'skills.systemSkills': '시스템 스킬',
    'skills.rescan': '~/.claude/plugins 재스캔',
    'skills.emptyNoSearch': '아직 스킬 없음 — 위에서 생성하세요',
    'skills.selectHint': '왼쪽에서 스킬을 선택하거나 새로 생성하세요.',
    'skills.editTitle': '스킬 편집',
    'skills.name': '이름',
    'skills.desc': '설명',
    'skills.descLongPlaceholder': '한 줄 요약 (이 스킬이 뭐고 언제 써야 하는지)',
    'skills.contentLabel': 'Content (Markdown)',
    'skills.contentPlaceholder':
      '## TDD Workflow\n\n1. 실패하는 테스트 작성\n2. 테스트 돌려서 실패 확인\n3. 통과하는 최소 구현\n...',

    // Framework actions
    'framework.seedDesc': '새 프로젝트 기획',
    'framework.paulDesc': 'Plan→Apply→Unify',
    'framework.aegisDesc': '보안 감사',
    'framework.skillDesc': '스킬 생성',

    // Sidebar / Commands palette
    'sidebar.searchPlaceholder': '검색…',
    'sidebar.searchAria': '검색',
    'common.revert': '되돌리기',
    'common.default': '기본값',
    'common.preview': '미리보기',

    // Settings tabs (신규)
    'settings.tab.appearance': '외관',
    'settings.tab.hooks': '훅',
    'settings.tab.mcp': 'MCP 서버',
    'settings.tab.schedules': '스케줄',

    // Appearance tab
    'appearance.appNameTitle': '앱 이름',
    'appearance.appNameDesc': '좌측 상단 + 탭 제목에 표시됩니다.',
    'appearance.bubbleTitle': '채팅 버블 색상',
    'appearance.bubbleUser': '사용자 (내 메시지)',
    'appearance.bubbleAssistant': '에이전트 응답',
    'appearance.previewUser': '미리보기 — 사용자 메시지',
    'appearance.previewAssistant': '미리보기 — 에이전트 응답입니다.',

    // Chat session dots/status titles
    'chat.session.unread': '안 읽음',
    'chat.session.running': '실행 중',
    // Tool calls
    'chat.toolUsed': '도구 {count}회 사용',
    // Choices
    'chat.choices.recommended': '추천',
    'chat.choices.custom': '기타 (직접 입력)',
    'chat.choices.customPlaceholder': '직접 입력...',
    'chat.choices.send': '전송',
    // Queued message badge
    'chat.queued': '대기 중',

    // Command palette
    'palette.placeholder': '검색: 에이전트, 프로젝트, 스킬, 세션, 페이지…',
    'palette.empty': '결과 없음',
    'palette.hint.move': '이동',
    'palette.hint.select': '선택',
    'palette.hint.toggle': '열기/닫기',
    'palette.kind.agent': '에이전트',
    'palette.kind.project': '프로젝트',
    'palette.kind.skill': '스킬',
    'palette.kind.session': '세션'
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
    'agents.moveLabel': 'Move / Manage',
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
      'Each feature can be toggled individually. OFF hides it from the sidebar and disables the API (Phase 4).',

    // Common
    'common.close': 'Close',
    'common.add': 'Add',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'common.remove': 'Remove',
    'common.removeAll': 'Remove all',
    'common.loading': 'Loading...',
    'common.searching': 'Searching…',
    'common.updating': 'Updating…',
    'common.new': 'New',
    'common.find': 'Find',
    'common.refresh': 'Refresh',
    'common.selectFolder': 'Select folder',
    'common.noResults': 'No results',
    'common.conflict': 'Conflict detected',
    'common.overwriteWithMine': 'Overwrite with my changes',
    'common.reloadFromDisk': 'Reload from disk',
    'common.error': 'Error',
    'common.imageLoadFail': 'Failed to load image',

    // Projects page
    'projects.title': 'Projects',
    'projects.intro':
      'Projects are buckets where agents are placed in the Dashboard hierarchy tree. The path registered here automatically syncs to the workingDir of agents placed in this project. 📁 Editing the path does not touch actual folders — only the projects.json reference is updated, and placed agents workingDir cascade-updates.',
    'projects.add': '+ Add Project',
    'projects.create': 'Create Project',
    'projects.dashboard': 'Project Dashboard',
    'projects.dashboardHint': 'Click a project to open its dashboard',
    'projects.statProjects': 'Projects',
    'projects.statPlaced': 'Placed Agents',
    'projects.statUnassigned': 'Unassigned',
    'projects.fieldId': 'ID',
    'projects.fieldIdHelp': 'Immutable after creation. Lowercase/digits/hyphen only.',
    'projects.fieldName': 'Name',
    'projects.fieldNameHelp': 'Name shown on the dashboard.',
    'projects.fieldPath': 'Path',
    'projects.fieldPathHelp': 'Absolute path. Used as the Claude CLI cwd and auto-loads CLAUDE.md.',
    'projects.fieldColor': 'Color',
    'projects.fieldColorHelp': 'Card header accent.',
    'projects.dragHint': 'Drag to reorder',
    'projects.edit': 'Edit Project',
    'projects.idImmutable': 'ID (immutable)',
    'projects.pathChangeHelp':
      'Changing this auto-cascades the workingDir of agents placed in this project. Actual folders are untouched.',
    'projects.defaultSkills': 'Default Skills',
    'projects.defaultSkillsHelp':
      'Automatically inherited by all agents placed in this project (Lead + Addon). Agents can add more skills individually but cannot remove inherited ones. Ideal for global distribution.',
    'projects.defaultSkillsInherit': '💡 {count} placed agents will automatically receive these skills.',
    'projects.defaultAllowedTools': 'Default Allowed Tools',
    'projects.defaultAllowedToolsHelp':
      'Claude tools that all agents in this project can automatically call. Agents can add more individually. Leave empty for no inheritance (Claude defaults).',
    'projects.defaultDisallowedTools': 'Default Disallowed Tools',
    'projects.defaultDisallowedToolsHelp':
      'Tools all agents in this project can never use. Takes precedence over per-agent settings. Example: block Edit/Write/Bash for router agents.',
    'projects.pathChangeWarn':
      'Changing the path will auto-update the workingDir of {count} agents placed in this project. Actual folders are untouched.',
    'projects.settings': 'Settings',
    'projects.mdLoading': 'Loading...',
    'projects.mdErrorPrefix': 'Error',
    'projects.mdNoFile': '⚠ No file — will be created on save',
    'projects.mdSaveToFile': 'Save to file',
    'projects.mdConflictPrompt':
      'The file has been modified externally. Should I overwrite with the latest disk content or reload?',
    'projects.mdEditorHint':
      '💡 This is the CLAUDE.md in the project folder. The Claude CLI loads it as context when running with this project as cwd. For Lightweight Mode agents, this replaces the systemPrompt. Saved to the actual filesystem.',
    'projects.mdPlaceholder':
      '# Project Name\n\n## Tech Stack\n- ...\n\n## Build & Deploy\n```bash\n...\n```\n\n## Agent Guidelines\n- ...',
    'projects.editTitle': 'Edit project:',
    'projects.cardDragReorder': 'Drag to reorder',
    'projects.confirmDelete':
      'Delete project "{name}"?\n\nActual filesystem folders are untouched — only the projects.json entry is removed.',
    'projects.confirmDeleteWithAgents':
      'Delete project "{name}"?\n\n⚠️ {count} agents are placed in this project. Deleting returns them to "Unassigned". (Filesystem folders untouched — only projects.json is updated.)',

    // Project dashboard widgets
    'projects.notes': 'Notes',
    'projects.notesPlaceholder': 'Write project notes, goals, reminders, etc.',
    'projects.notesEmpty': 'No notes — click edit to write',
    'projects.goals': 'Goals',
    'projects.goalInput': 'Enter goal...',
    'projects.timeline': 'Agent Timeline',
    'projects.timelineAgentCount': '{count} agents',
    'projects.timelineEmpty': 'No recent activity',
    'projects.tokenUsage': 'Token Usage',
    'projects.customWidgets': 'Custom Widgets',
    'projects.widgetsEmpty': 'No widgets — use Add to pin URLs, notes, etc.',
    'projects.widgetTitle': 'Widget title',
    'projects.widgetLink': 'Link',
    'projects.widgetText': 'Text',
    'projects.widgetKV': 'Key-Value',
    'projects.widgetKVPlaceholder': 'KEY=VALUE (newline separated)',
    'projects.widgetMd': 'Markdown',
    'projects.widgetTextPlaceholder': 'Enter content',
    'projects.widgetMdPlaceholder': '## Title\nContent...',
    'projects.agentCount': '🤖',
    'projects.msgCount': '{count} msgs',

    // Agents page extras
    'agents.totalLabel': 'Total',
    'agents.create': '⊕ New Agent',
    'agents.quickId': 'id',
    'agents.quickAvatarPlaceholder': '🤖',
    'agents.clonePrompt': 'Enter a new ID for the cloned agent (lowercase/digits/hyphen/underscore only):',
    'agents.conflictConfirm':
      'This agent was modified in another window/tab.\n\nOK: overwrite with my changes\nCancel: discard and reload latest state',
    'agents.saveFailed': 'Save failed',
    'agents.namePlaceholder': 'Hivemind, Algorithm Dev...',
    'agents.toolsTitle': 'Tool Settings',
    'agents.toolsDesc': 'Restrict the Claude tools this agent can call. Passed to Claude CLI as',
    'agents.toolsDescInherit': 'Project {name}\'s default tools are auto-inherited (↑ indicator).',
    'agents.allowedTools': 'Allowed Tools (allowedTools)',
    'agents.allowedToolsHelp': 'Claude can only call checked tools. Empty = Claude defaults (all allowed).',
    'agents.disallowedTools': 'Disallowed Tools (disallowedTools)',
    'agents.disallowedToolsHelp': 'Checked tools are explicitly blocked. Takes precedence over allowedTools. Example: router agents block Edit/Write/Bash.',
    'agents.skills': 'Skills',
    'agents.skillsHelpWithInherit':
      'Selected skills are concatenated into the systemPrompt on chat calls. {count} default skills from the current project are auto-inherited (cannot uncheck).',
    'agents.skillsHelpNoInherit':
      'Selected skills are concatenated into the systemPrompt on chat calls. Placing the agent in a project auto-inherits that project\'s default skills.',
    'agents.modal.locationHint':
      'Edit name/avatar/model/backend/system prompt here. Location (project/tier) is changed via drag-and-drop in the Dashboard only.',

    // Chat page
    'chat.sessionSelectHint': 'Select a project and start a session',
    'chat.loading': 'Loading...',
    'chat.running': 'running',
    'chat.searchPlaceholder': 'Search messages...',
    'chat.attachmentHeader': '[Attached files]',
    'chat.attachmentFooter': 'Please use the Read tool to review the files above.',
    'chat.escalation': 'Escalation',
    'chat.loopStopConfirm': 'Stop loop?',
    'chat.clearConfirm': 'Delete the current session and start fresh?',
    'chat.renamePrompt': 'New session title:',
    'chat.exportFailed': 'Export failed',
    'chat.helpMessage':
      'Available commands:\n\n/commit — commit\n/review — code review\n/test — test\n/plan — plan\n/fix — bug fix\n/loop — Ralph Loop\n/run — Background task\n/clear — reset session\n/new — new session\n/rename — rename\n/export — export\n/pin — pin\n/search — search\n/help — help',
    'chat.mobileProject': 'Project',
    'chat.mobileGlobal': 'Global',
    'chat.mobileSessionSelect': 'Select session',
    'chat.mobileNewSession': 'New session',
    'chat.mobileNoSessions': 'No sessions',
    'chat.pin': 'Pin',
    'chat.unpin': 'Unpin',
    'chat.thinkingEffort': 'Thinking Effort',

    // Chat sidebar
    'chat.sidebar.project': 'Project',
    'chat.sidebar.recentSessions': 'Recent Sessions',
    'chat.sidebar.selectProject': 'Select project',
    'chat.sidebar.sessions': 'Sessions',
    'chat.sidebar.noSessions': 'No sessions',
    'chat.sidebar.deleteCount': 'Delete {count}',
    'chat.sidebar.deleteCountConfirm': 'Delete {count} sessions?',
    'chat.sidebar.multiSelect': 'Multi-select',
    'chat.sidebar.deleteConfirm': 'Delete "{title}"?',
    'chat.sidebar.exportFailed': 'Export failed',

    // Chat input
    'chat.input.uploading': 'Uploading…',
    'chat.input.attached': 'Attached · {count}',
    'chat.input.disabledPlaceholder': 'Select a session',
    'chat.input.placeholder': 'Type a message · / commands · @file',
    'chat.input.taskFailed': 'Task start failed',
    'chat.input.loopFailed': 'Loop start failed',
    'chat.input.attachOnly': '(attachments only)',
    'chat.input.attachBtn': 'Attach file',
    'chat.input.abortBtn': 'Abort',
    'chat.input.sendBtn': 'Send',

    // At-file popover
    'atfile.noWorkingDir': 'Agent has no workingDir — file search disabled',
    'atfile.searchPrompt': 'Type a filename to search within the project',

    // Agent picker popover
    'agentPicker.selectPlaceholder': '— Select agent —',
    'agentPicker.searchPlaceholder': 'Search by name / id / model / project',
    'agentPicker.main': 'Main',
    'agentPicker.unassigned': 'Unassigned',
    'agentPicker.summary': '{agents} agents · {projects} projects',

    // Streaming message
    'stream.generating': 'Generating response…',
    'stream.toolProgress': '{count} tool steps · in progress…',

    // Tool call card
    'tools.removed': '- removed',
    'tools.added': '+ added',
    'tools.read': 'read',
    'tools.writeFull': 'full write',
    'tools.download': 'Download',
    'tools.emptyEdit': 'empty edit',

    // Skills page
    'skills.title': 'Skills',
    'skills.intro':
      'Skills are reusable Markdown instructions. When selected in an agent edit modal, the body of the chosen skills is concatenated into',
    'skills.introSuffix': ' on chat calls. Multiple agents can share the same skill (TDD workflow, code review rules, deployment checklist, etc.).',
    'skills.add': '+ Add Skill',
    'skills.namePlaceholder': 'Name (e.g. TDD Workflow)',
    'skills.descPlaceholder': 'Description (one line)',
    'skills.createEmpty': 'Create (empty body)',
    'skills.searchPlaceholder': 'Search skills',
    'skills.mySkills': 'My Skills',
    'skills.systemSkills': 'System Skills',
    'skills.rescan': 'Rescan ~/.claude/plugins',
    'skills.emptyNoSearch': 'No skills yet — create one above',
    'skills.selectHint': 'Select a skill from the left or create a new one.',
    'skills.editTitle': 'Edit Skill',
    'skills.name': 'Name',
    'skills.desc': 'Description',
    'skills.descLongPlaceholder': 'One-line summary (what and when this skill is for)',
    'skills.contentLabel': 'Content (Markdown)',
    'skills.contentPlaceholder':
      '## TDD Workflow\n\n1. Write a failing test\n2. Run the test and confirm failure\n3. Minimal passing implementation\n...',

    // Framework actions
    'framework.seedDesc': 'New project ideation',
    'framework.paulDesc': 'Plan→Apply→Unify',
    'framework.aegisDesc': 'Security audit',
    'framework.skillDesc': 'Create skill',

    // Sidebar / Commands palette
    'sidebar.searchPlaceholder': 'Search…',
    'sidebar.searchAria': 'Search',
    'common.revert': 'Revert',
    'common.default': 'Default',
    'common.preview': 'Preview',

    // Settings tabs (new)
    'settings.tab.appearance': 'Appearance',
    'settings.tab.hooks': 'Hooks',
    'settings.tab.mcp': 'MCP Servers',
    'settings.tab.schedules': 'Schedules',

    // Appearance tab
    'appearance.appNameTitle': 'App Name',
    'appearance.appNameDesc': 'Shown in top-left + tab title.',
    'appearance.bubbleTitle': 'Chat Bubble Colors',
    'appearance.bubbleUser': 'User (my messages)',
    'appearance.bubbleAssistant': 'Agent response',
    'appearance.previewUser': 'Preview — user message',
    'appearance.previewAssistant': 'Preview — agent response.',

    // Chat session dots/status titles
    'chat.session.unread': 'Unread',
    'chat.session.running': 'Running',
    // Tool calls
    'chat.toolUsed': '{count} tool calls',
    // Choices
    'chat.choices.recommended': 'Recommended',
    'chat.choices.custom': 'Other (type your own)',
    'chat.choices.customPlaceholder': 'Type your answer...',
    'chat.choices.send': 'Send',
    // Queued message badge
    'chat.queued': 'Queued',

    // Command palette
    'palette.placeholder': 'Search: agents, projects, skills, sessions, pages…',
    'palette.empty': 'No results',
    'palette.hint.move': 'Move',
    'palette.hint.select': 'Select',
    'palette.hint.toggle': 'Open/Close',
    'palette.kind.agent': 'Agent',
    'palette.kind.project': 'Project',
    'palette.kind.skill': 'Skill',
    'palette.kind.session': 'Session'
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
    { name: 'hivemind-lang' }
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
