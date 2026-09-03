# Round 3 — 커뮤니티 동향 1차 묶음 (v1.17.28)

근거: plans/2026-09-03-community-trends.md. 서버(A)·클라(B) 병렬 작업. 아래 API 계약을 양쪽이 그대로 따른다. 서버 재시작·index.js import 금지(자기 세션이 죽음). 검증은 vitest / client build.

## API 계약
1. **훅 실행** — hooks.json 항목: `{id, event, matcher, command, enabled, async?:bool, agentIds?:string[], timeout?:number}`. event ∈ PreToolUse|PostToolUse|Stop|Notification|SessionStart|UserPromptSubmit. agentIds 비어있으면 전체 적용. 러너 spawn 시 해당 에이전트에 유효한 훅을 Claude settings 형식 `{hooks:{[event]:[{matcher, hooks:[{type:'command', command, async, timeout}]}]}}` 으로 조립 → 임시 파일(USER_DIR/logs/hook-settings-<sessionId>.json) 에 쓰고 `--settings <path>` 전달, 종료 시 삭제. 유효 훅 0개면 플래그 생략.
2. **권한 승인 푸시** — approval 요청 등록 시 `pushStore.sendPushToAll('권한 요청 — <agentName>', '<toolName>: <입력 요약 80자>', {url:'/chat?session=<sid>&approval=<reqId>', skipIdleCheck:true, skipRunnerCheck:true, actions:[{action:'approve',title:'승인'},{action:'deny',title:'거부'}]})`. push-store 는 payload 에 actions 를 그대로 실어 보낸다. SW 는 action 클릭 시 `url + '&decision=approve|deny'` 를 연다(토큰은 페이지가 가짐). 페이지는 `approval`+`decision` 쿼리를 읽어 기존 `POST /api/chat/:sessionId/approval/:reqId` 로 처리 후 쿼리 제거.
3. **Auto 권한 모드** — agents 스키마 permissionMode enum 에 `auto` 추가(CLI 2.1.259 choices 확인됨). 러너는 값 그대로 `--permission-mode` 로 전달, `--dangerously-skip-permissions` 와 동시 지정 금지.
4. **자동 compact** — web-config `chat.autoCompactPct` (0=off, 기본 0). `PATCH /api/settings` 로 저장. message-sender 가 chat.done 후 세션 컨텍스트 사용률(기존 usage 기반 계산; client/src/lib/context-window.ts 의 로직을 서버 lib/context-window.js 로 이식) ≥ pct 이면 sessions 라우트의 compact 로직(lib 로 추출) 호출 + `chat.auto-compacted` 이벤트 publish + 활동 로그.
5. **MCP 프리셋** — `GET /api/mcp/presets` → `[{id:'playwright',name:'Playwright MCP',desc,config:{command:'npx',args:['@playwright/mcp@latest']}},{id:'context7',name:'Context7',config:{command:'npx',args:['-y','@upstash/context7-mcp']}},{id:'github',name:'GitHub MCP',config:{type:'http',url:'https://api.githubcopilot.com/mcp/'}}]`. `POST /api/mcp/presets/:id/apply` → 기존 servers 에 병합(같은 키 있으면 409) 후 저장, 결과 servers 반환.
6. **Claude 자동 메모리** — `GET /api/projects/:id/claude-memory` → `{dir, files:[{name,size,mtime}], index:<MEMORY.md 내용|null>}`. dir = `~/.claude/projects/<workingDir 의 '/'→'-' 치환>/memory`. `GET /api/projects/:id/claude-memory/:file`, `PUT` (body `{content}`). file 은 `[A-Za-z0-9_.-]+\.md` 만, 경로 이탈 차단. 프로젝트에 workingDir 없으면 404.
7. **에이전트 env** — agents 스키마 `env: Record<string,string>` (키 `^[A-Z_][A-Z0-9_]*$`, 최대 32개, 값 ≤ 2000자; PATH/HOME/NODE_OPTIONS/CLAUDE_CONFIG_DIR 금지 → 400). 러너 spawn env = cleanEnv + agent.env (agent 우선).
8. **사용량 예산** — web-config `usage.budget5h`, `usage.budget7d` (토큰 수, 0=미설정). `GET /api/stats/usage` 응답에 `budget:{tokens5h,tokens7d}` 포함.

## A. cw_server
- 위 1~8 서버 측 구현 + package.json 1.17.28.
- 테스트: 훅 settings 조립(agentIds 필터·enabled·async), 프리셋 apply 409, claude-memory 경로 이탈 400, env 금지키 400, autoCompact 임계 판정. `npx vitest run` 전부 통과.
- 변경 파일·테스트 수·계약과 다르게 한 점 5줄 보고.

## B. cw_client
- HooksTab: agentIds 다중선택·async 토글·timeout, "저장된 훅은 에이전트 실행 시 CLI settings 로 주입됩니다" 안내.
- 알림: SW(notificationclick) 에서 `event.action` 이 있으면 `url&decision=` 으로 열기. ChatPage 가 `approval`·`decision` 쿼리를 읽어 승인/거부 POST 후 쿼리 제거·토스트. PermissionPromptModal 은 그대로.
- AgentModal: permissionMode 에 `auto`(설명: "분류기가 위험 행동만 차단") 추가, env 키/값 편집 행(추가/삭제, 키 검증).
- Settings Features: 자동 compact 임계(0/50/60/70/80 %), 사용량 예산 5h/7d 입력.
- CostWidget: 5h/7d 토큰 게이지(예산 있으면 %막대, 없으면 숫자만) 추가.
- McpServersTab: 프리셋 버튼 3개(GET/POST presets), 서버 4개 이상이면 "세션 시작 비용" 경고 배너.
- ProjectDashboard: "Claude 메모리" 탭 — 파일 목록 + MEMORY.md 편집(textarea, 저장), 없으면 안내.
- types.ts/api.ts 계약대로. `npm --prefix client run build` 성공 후 5줄 보고.
