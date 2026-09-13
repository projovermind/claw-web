# 팀 캘린더 v1 스펙 (2026-09-14)

우리 팀 공용 캘린더. 사용자는 웹 UI 에서 직접 일정을 추가하고, 모든 세션(에이전트)은 HTTP API 로 조회/등록한다.
전용 에이전트 `cw_calendar` (📅, sonnet) 가 이미 생성되어 hivemind-web 프로젝트에 배정돼 있다.

## 1. 데이터 모델

파일: `data/user/calendar.json`
```json
{ "version": 1, "events": [ ... ] }
```

이벤트:
```ts
{
  id: string;            // cal_xxxxxxxx
  title: string;         // 필수, 1~200자
  start: string;         // 필수. allDay=false → ISO8601 (예 2026-09-20T14:00:00+09:00)
                         //       allDay=true  → 'YYYY-MM-DD'
  end: string | null;    // 없으면 null. start 와 같은 포맷
  allDay: boolean;       // 기본 false
  notes: string;         // 기본 ''
  location: string;      // 기본 ''
  color: string | null;  // hex, 기본 null
  tags: string[];        // 기본 []
  projectId: string|null;// 기본 null
  agentId: string|null;  // 등록한 에이전트 id (있으면)
  source: 'user'|'agent';// 기본 'agent'. 웹 UI 에서 만들면 'user'
  createdAt: string;     // ISO
  updatedAt: string;     // ISO
}
```

- 시간대 기준은 KST(+09:00).
- 저장은 lockfile + atomic rename. `server/lib/deploy-log-store.js` 패턴을 그대로 따를 것.

## 2. API (`/api/calendar`, 기존 `/api` auth 미들웨어 적용됨)

| method | path | 설명 |
|---|---|---|
| GET | `/api/calendar?from=&to=` | 범위 조회. from/to 는 `YYYY-MM-DD` 또는 ISO. 생략 시 전체. `{ events: [...] }` (start 오름차순) |
| GET | `/api/calendar/upcoming?days=7` | 지금부터 N일(기본 7, 최대 90) 내 일정. `{ events: [...] }` |
| POST | `/api/calendar` | 생성. body 는 위 모델의 부분집합(title, start 필수). → 201 `{ event }` |
| PATCH | `/api/calendar/:id` | 부분 수정 → `{ event }` / 없으면 404 |
| DELETE | `/api/calendar/:id` | → `{ ok: true }` / 없으면 404 |

- 검증은 zod (`server/routes/agents.js` 스타일). 잘못된 body → 400 `INVALID_BODY`.
- 변경 시 eventBus 로 브로드캐스트: `eventBus.publish('calendar.changed', { action: 'create'|'update'|'delete', event })`
  (기존 라우터들이 eventBus.publish 를 쓰는 방식과 동일하게)

## 3. 세션 주입 (모든 에이전트가 캘린더를 쓰게 하는 부분)

`server/routes/chat/message-sender.js` 의 `agent.dashboardHint` 를 만드는 자리(L~293) 옆에
`<calendar>` 블록을 추가한다. 내용:

- 다가오는 7일 일정 요약 (최대 8건, `9/20(토) 14:00 제목` 형식). 없으면 "예정된 일정 없음".
- 캘린더 API curl 예시 3개: 조회(upcoming), 추가(POST), 수정(PATCH). auth 헤더는 기존 dashboardHint 가 쓰는 `authHeader` 변수 재사용.
- 한 줄 안내: "일정 관련 요청은 전용 에이전트 `cw_calendar` 에게 위임하거나 직접 API 를 호출하세요. 사용자가 직접 만든 일정(source:user)은 임의로 수정/삭제하지 말 것."

블록 전체는 1200자 이내로 유지 (토큰 예산). 일정이 하나도 없으면 요약 줄만 짧게.

## 4. 웹 UI

- 새 페이지 `client/src/pages/CalendarPage.tsx`, 라우트 `/calendar` (App.tsx 에 lazy import + Route),
  `client/src/components/layout/Sidebar.tsx` 에 네비 항목 추가 (📅 캘린더).
- 월간 그리드(주 시작 월요일) + 오른쪽/하단에 "다가오는 일정" 리스트.
- 이전/다음 달, "오늘" 버튼.
- 날짜 칸 클릭 → 일정 추가 모달 (제목, 종일 토글, 시작/종료 일시, 장소, 메모, 색상, 프로젝트 선택 optional).
  생성 시 `source: 'user'` 로 POST.
- 일정 클릭 → 같은 모달로 수정 + 삭제 버튼(확인 후 DELETE).
- WS `calendar.changed` 수신 시 목록 갱신 (기존 useWebSocket / 이벤트 처리 패턴을 따를 것).
- 스타일은 기존 페이지(DashboardPage 등)의 Tailwind 다크 테마와 일치시킬 것. 새 라이브러리 추가 금지 (date 계산은 직접).
- 에이전트가 만든 일정(source:'agent')은 뱃지로 구분 표시.

## 5. 테스트

- `tests/calendar-store.test.js` — CRUD, 범위 조회, upcoming 경계, 잘못된 입력.
- 기존 vitest 컨벤션(`npx vitest run`)에 맞출 것.
