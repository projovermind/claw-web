# 2026-09-03 커뮤니티 동향 → claw-web 적용 판정

출처: 영문(HN·dev.to·GitHub·앱스토어·공식문서, reddit 은 fetch 차단으로 2차 인용) + 한국어(GeekNews·velog·gymcoding·elancer). 8주(2026-07~09) 범위. CLI 2.1.259 기준 플래그 확인.

## 판정 요약 (적용 가능 → 우선순위순)

| # | 커뮤니티 항목 | claw-web 현재 | 판정 | 규모 |
|---|---|---|---|---|
| 1 | PreToolUse/PostToolUse 훅 (위험 명령 차단·편집 후 자동 포맷/테스트), async hooks | Hooks 탭은 CRUD 만 있고 **실행 코드 0** (hooksStore 소비자 없음) | 즉시 적용: 에이전트별 hooks 를 settings JSON 으로 조립해 `--settings` 로 전달 | 중 |
| 2 | 모바일 원격 승인 (Remote Control·happy·Paseo·bruceyxli monitor) | PWA+터널+푸시는 있으나 **권한 요청은 푸시 안 감**(완료·위임·토큰만료만) | 즉시 적용: approval-broker 요청 시 push + 알림 action 으로 승인/거부 딥링크 | 소 |
| 3 | 5h/7d 레이트리밋 게이지 (claude-dashboard·ccstatusline) | `/api/stats/usage` 에 window5h/7d 토큰 이미 있음, UI 없음 | 즉시 적용: CostWidget 에 5h/7d 게이지 추가 | 소 |
| 4 | Auto Mode 기본값(8/14) | `--permission-mode` 는 넘기지만 선택지에 auto 없음 | 적용: 에이전트 모달 권한 모드에 `auto` 추가 (CLI 지원 확인 필요) | 소 |
| 5 | /compact 60% 룰 | compact API + context-window 계산 있음, 자동 실행 없음 | 적용: 세션 컨텍스트 60% 도달 시 자동 compact 토글(설정) | 소~중 |
| 6 | 인기 MCP 3종 (Playwright·Context7·GitHub) + "3개만" 조언 | MCP 탭은 settings.json 편집만 | 적용: 원클릭 프리셋 3개 + 에이전트당 4개 이상이면 경고 | 소 |
| 7 | 세션별 git worktree (`-w`, squad·vibe-kanban) | worktree route 만 있고 세션 생성과 미연결 | 적용: 세션 생성 옵션 "worktree 격리" → `--worktree` 전달 + 정리 스윕 | 중 |
| 8 | Workflows(agent/pipeline/parallel)·adversarial verify·다관점 리뷰 | 위임 체인은 자체 구현; CLI Workflow 는 사용자 opt-in 키워드 필요 | 적용: 채팅 입력에 "워크플로 모드" 토글(ultracode 키워드 자동 부착) + 위임 상태판에 phase 표시 | 소(토글)/대(가시화) |
| 9 | MEMORY.md 자동 메모리 뷰어 | 프로젝트 메모리(자체)만 있음 | 적용: 프로젝트 화면에 `~/.claude/projects/<proj>/memory/` 읽기·편집 탭 | 소 |
| 10 | CLAUDE_CODE_SUBAGENT_MODEL_FORCE 등 env | 러너가 cleanEnv 만 전달, 에이전트별 env 없음 | 적용: 에이전트 설정에 env 맵 추가 → spawn env 병합 | 소 |
| 11 | 칸반 태스크 보드 (Agent-Monitor ★968·vibe-kanban) | 위임 상태바·활동 피드만 | 적용 가능하나 큰 작업: 위임/스케줄/loop 를 카드로 묶는 보드 | 대 |
| 12 | Channels (Telegram/Discord 인바운드) | 푸시(아웃바운드)만 | 적용 가능: Telegram 봇 → POST /api/chat 브리지 | 중 |
| 13 | gymcoding 추천 스킬 (mcp-builder·find-skills·agent-browser) | import-url 로 즉시 수입 가능; find-skills ≈ import-url, agent-browser ≈ webapp-testing(수입됨) | mcp-builder 만 추가 수입 | 소 |
| 14 | nunchi(규칙 지연 주입, 토큰 42%↓)·컨텍스트 엔지니어링 | 트리거 스킬(lazy) + 토큰 효율화 스킬로 이미 동일 효과 | 이미 있음 — CLAUDE.md 길이 경고만 추가 검토 | — |
| 15 | ccusage 류 비용 CLI | v1.17.26 CostWidget 으로 커버 | 이미 있음 | — |
| 16 | Dispatch(API 트리거 백그라운드 워커) | POST /api/chat + schedules + tasks | 이미 있음 | — |
| 17 | /goal·/loop | 세션 loop + wakeup 마커 | 부분 있음; goal 판정기는 보류 | — |
| 18 | Roundtable MCP(다모델 합의)·gstack·OpenWiki·Superpowers 플러그인 | 백엔드 다중화·스킬 수입으로 부분 대체 | 보류 (효용 대비 토큰 비용 큼) | — |

## 권장 1차 묶음 (1~6, 9, 10, 13): 모두 소~중 규모, 기존 구조 위에 얹힘
- 서버: hooks→`--settings` 조립(1), approval push(2), auto 모드(4), 자동 compact(5), MCP 프리셋 API(6), 메모리 파일 API(9), env 맵(10)
- 클라: 5h/7d 게이지(3), 권한 모드 옵션(4), compact 토글(5), MCP 프리셋 버튼(6), 메모리 탭(9), env 편집(10)
- 데이터: mcp-builder 스킬 수입(13)

## 2차 (7, 8, 12), 3차 (11)
