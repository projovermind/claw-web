# 2026-09-03 종합 점검 — Round 1 작업 명세

리드(cw_planner) 진단 요약. 각 워커는 자기 섹션만 수행하고, 완료 보고는 "변경 파일 + 검증 명령/결과" 5줄 이내.

## 진단 결과 (리드)
- 테스트: `npx vitest run` → 3 파일 8건 실패 (auth-middleware 3, chat-route 3, process-tracker 2). 코드가 진화했는데 테스트가 낡았거나 코드가 헤더 미존재를 가드하지 않음.
- 버전: package.json 1.17.9 vs 최신 커밋 v1.17.25 → 설정 화면이 가짜 업데이트 알림. `/api/health` 에 version 없음.
- 죽은 코드: `server/lib/auto-update.js` (importer 0). `server/runners/tool-executor.js` 에 ripgrep 절대경로 하드코딩(arm64-darwin 전용).
- 비용 추적 없음: CLI `result` 이벤트의 `total_cost_usd` 를 버림. 계정/에이전트별 소진량 대시보드 부재 (2026 매니저 툴 표준 기능).
- 스킬: GitHub SKILL.md 를 URL 로 바로 가져오는 경로 없음 (이번에 16개를 스크립트로 수동 수입함 — scripts/import-github-skills.py).
- README: "Hivemind Web / Discord 봇 대체" 시절 내용. 아키텍처 표 5줄뿐, Phase 2~5 🚧 표시 (전부 출시됨).
- 클라 테스트 0개, ESLint 없음, CI 없음. tsc 는 통과.
- 루트에 스크린샷 png 6개, .pkg 6개 — 레포 오염.

## A. cw_server
1. 실패 테스트 8건 수정. 원칙: 코드 버그면 코드, 낡은 테스트면 테스트 갱신. 각 건 원인 1줄 보고.
   - tests/auth-middleware.test.js: `authorizeWsUpgrade` 가 `req.headers` undefined 를 가드하지 않음 (server/middleware/auth.js:20).
   - tests/chat-route.test.js: `Router.use() requires a middleware function but got a Object` — createChatRouter 시그니처/의존성 변경 추적.
   - tests/process-tracker.test.js: `reapOrphans` 반환 타입이 number → object 로 바뀜.
2. `server/lib/auto-update.js` 삭제(참조 0 확인). `tool-executor.js` ripgrep 경로를 `which rg` → claude-code vendor 경로 탐색 순으로 동적 해석.
3. 버전 단일화: package.json `version` → `1.17.26`. `GET /api/health` 응답에 `version` 추가 (package.json 1회 읽어 캐시).
4. 비용 추적: `claude-cli-runner.js` result 이벤트의 `total_cost_usd` 를 usage 에 `costUsd` 로 보존 → 메시지에 저장. `GET /api/stats/usage` 에 `cost: { window7d, window30d, byAgent:{id:usd}, byDay:{YYYY-MM-DD:usd}, byAccount:{id:usd} }` 추가 (기존 필드 유지). 과거 메시지에 costUsd 없으면 0 처리.
5. `POST /api/skills/import-url` `{url, triggers?, alwaysOn?}`: github.com/…/blob/… → raw 변환, 5초 타임아웃·1MB 제한, SKILL.md frontmatter(name/description) 파싱, `superpowers:x` 참조는 `'x' 스킬` 로 치환, content 앞에 `<!-- source: URL -->` 주석. 같은 name 존재 시 409. zod 검증, 테스트 1개 추가 (fetch 는 mock).
6. 서버 전수 검수: server/routes/**, server/lib/**, server/runners/** 를 파일별로 읽고 실제 버그(미처리 promise, 잘못된 상태코드, 검증 누락, 경쟁 조건, 리소스 누수)만 수정. 스타일 변경 금지. 발견/수정 목록을 `plans/2026-09-03-server-audit.md` 에 기록.
7. 검증: `npx vitest run` 전부 통과. 서버 재시작 금지 (자기 세션이 죽음) — 단위 테스트로만 검증.

## B. cw_client
1. 사이드바 하단에 버전 배지 (`GET /api/health` 의 `version`; 없으면 숨김). 클릭 시 설정 > Access 업데이트 섹션으로 이동.
2. SkillsPage: "GitHub 에서 가져오기" 버튼 → URL 입력 모달 → `POST /api/skills/import-url` (A-5 스펙). 성공 시 목록 갱신 + 상세 열기. 409 시 "같은 이름의 스킬이 있습니다" 토스트. 스킬 상세에 `<!-- source: … -->` 주석이 있으면 출처 링크로 표시.
3. 비용 위젯: 대시보드 `AgentStatsWidget` 옆(또는 내부 탭)에 `GET /api/stats/usage` 의 `cost` 로 "7일/30일 총 비용, 에이전트별 상위 5, 일별 막대(최근 14일)" 표시. 데이터가 모두 0 이면 "비용 데이터 수집 전" 안내. 차트 라이브러리 추가 금지 — CSS/SVG 막대로.
4. 클라 전수 검수: pages/** components/** hooks/** store/** lib/** 를 읽고 실제 버그(잘못된 API 응답 형태 가정, 누수되는 effect, 깨진 상태 갱신, 접근성 심각 문제)만 수정. `plans/2026-09-03-client-audit.md` 에 기록.
5. 검증: `npm --prefix client run build` 성공 (tsc -b 포함). 기존 스타일/토큰(Tailwind 클래스 관례) 유지.

## C. cw_release
1. README.md 를 현재 제품(Claw Web) 기준으로 전면 재작성: 개요, 요구사항(Node 20+, Claude CLI), 설치/실행/빌드, 포트, 아키텍처(라우트 그룹·lib·runners·ws 요약 표), 스킬 시스템(alwaysOn/triggers/manual, GitHub 수입 스크립트), 위임/스케줄/백엔드/기기 전환 한 단락씩, 운영(LaunchAgent, cloudflared, 로그 경로), 테스트. 한국어. 300줄 이내.
2. `docs/ARCHITECTURE.md` 신설: 요청 흐름(HTTP→route→store), 채팅 파이프라인(dispatch→message-sender→runner→ws hub), 위임 체인, 데이터 파일 위치. 150줄 이내.
3. 루트 오염 정리: `*.png`, `*-snapshot.md`, `claw-web-*.pkg` 를 `packaging/archive/` 로 이동(git mv). `.gitignore` 에 `*.pkg`, `config.json.bak*` 확인/추가. 코드 변경 금지.
4. 검증: `git status` 로 이동 결과 확인, 링크 깨짐 없음.

## Round 2 (리드가 A/B/C 회신 후)
- cw_tester: 전체 `npm test` + `npm run build` + `/api/health` 스모크 → 보고.
- 리드: 커밋(v1.17.26) → 빌드 → LaunchAgent 재시작(사용자 확인 후) → 배포 이력 기록 → 프로젝트 메모리 갱신.
