/**
 * Built-in slash commands. Typing `/` at the start of the message input
 * triggers a filtered dropdown of these commands. Selecting one fills the
 * input with the template text. Templates ending with a colon or space are
 * "partial" — the user should continue typing after the template.
 *
 * Phase 2 will add server-side custom commands (per-project .claude/commands/*.md
 * and a CRUD UI). For now, this hardcoded list covers the most common workflows.
 */
export interface SlashCommand {
  name: string;
  icon: string;
  desc: string;
  /** The text that replaces the input. `$INPUT` is replaced with whatever
   *  the user typed after the command name (e.g. `/fix button crash` → template
   *  with $INPUT = "button crash"). */
  template: string;
  /** If true, this is a system command (UI action) handled by ChatInput
   *  directly instead of being sent as a message. */
  system?: boolean;
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'commit',
    icon: '📝',
    desc: '변경사항 확인 → 커밋',
    template:
      '현재 변경사항을 git diff로 확인하고, 적절한 커밋 메시지를 작성해서 커밋해줘.'
  },
  {
    name: 'review',
    icon: '🔍',
    desc: '최근 변경사항 코드 리뷰',
    template:
      '최근 변경사항을 코드 리뷰해줘. 버그, 보안 이슈, 성능 문제, 개선점을 찾고 구체적으로 알려줘.'
  },
  {
    name: 'test',
    icon: '🧪',
    desc: '테스트 실행 + 실패 수정',
    template: '테스트를 실행하고, 실패한 것이 있으면 원인을 파악해서 수정해줘.'
  },
  {
    name: 'plan',
    icon: '📋',
    desc: '구현 계획 작성',
    template: '다음 기능을 구현하기 위한 상세한 계획을 작성해줘: $INPUT'
  },
  {
    name: 'explain',
    icon: '💡',
    desc: '코드/파일 설명',
    template: '이 코드가 어떻게 동작하는지 초보자도 이해할 수 있게 설명해줘: $INPUT'
  },
  {
    name: 'fix',
    icon: '🔧',
    desc: '버그 수정',
    template: '다음 버그를 수정해줘: $INPUT'
  },
  {
    name: 'refactor',
    icon: '♻️',
    desc: '리팩토링',
    template: '다음 코드를 리팩토링해줘. 가독성, 성능, 구조를 개선하되 동작은 유지: $INPUT'
  },
  {
    name: 'docs',
    icon: '📖',
    desc: '문서화 / 주석 추가',
    template: '이 코드에 JSDoc/주석과 README 문서를 추가해줘: $INPUT'
  },
  {
    name: 'build',
    icon: '🏗️',
    desc: '빌드 실행',
    template: '프로젝트를 빌드하고, 에러가 있으면 수정해줘.'
  },
  {
    name: 'status',
    icon: '📊',
    desc: 'Git 상태 + 브랜치 확인',
    template: 'git status, git branch, 최근 커밋 5개를 보여주고 현재 상태를 요약해줘.'
  },
  {
    name: 'loop',
    icon: '🔄',
    desc: 'Ralph Loop — 완료될 때까지 자동 반복',
    template:
      '$INPUT\n\n완료되면 반드시 <promise>DONE</promise>을 출력하세요. 도움이 필요하면 <escalate>이유</escalate>를 출력하세요.'
  },
  {
    name: 'run',
    icon: '⚙️',
    desc: 'Background task 실행',
    template: '$INPUT'
  },
  // ── System commands (UI actions, not chat messages) ──
  {
    name: 'clear',
    icon: '🗑️',
    desc: '현재 세션 삭제 + 새 세션 시작',
    template: '',
    system: true
  },
  {
    name: 'new',
    icon: '➕',
    desc: '새 세션 만들기',
    template: '',
    system: true
  },
  {
    name: 'rename',
    icon: '✏️',
    desc: '현재 세션 이름 변경',
    template: '$INPUT',
    system: true
  },
  {
    name: 'export',
    icon: '💾',
    desc: '현재 세션 Markdown 내보내기',
    template: '',
    system: true
  },
  {
    name: 'pin',
    icon: '📌',
    desc: '현재 세션 고정/해제',
    template: '',
    system: true
  },
  {
    name: 'search',
    icon: '🔍',
    desc: '메시지 내 검색 열기',
    template: '',
    system: true
  },
  {
    name: 'help',
    icon: '❓',
    desc: '사용 가능한 명령어 목록',
    template: '',
    system: true
  },
  {
    name: 'compact',
    icon: '📦',
    desc: '컨텍스트 압축 — 대화 요약 → 새 세션으로 이어가기',
    template: '',
    system: true
  }
];

/**
 * Expand a command template with the user's input text.
 * `/fix button crash` → command='fix', input='button crash'
 * → "다음 버그를 수정해줘: button crash"
 */
export function expandCommand(command: SlashCommand, userInput: string): string {
  return command.template.replace('$INPUT', userInput.trim());
}
