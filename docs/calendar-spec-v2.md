# 팀 캘린더 v2 스펙 (2026-09-14)

v1(39f0221) 위에 얹는다. v1 스펙은 docs/calendar-spec.md 참고.
요구사항 4가지: (A) 일요일 시작 (B) 공휴일/대체공휴일 (C) 하단 에이전트 채팅 (D) 반복일정 + 알림

---
## A. 주 시작을 일요일로  [클라]
월간 그리드 요일 헤더를 `일 월 화 수 목 금 토` 로. 첫 칸 계산도 일요일 기준.
일요일=빨강, 토요일=파랑 텍스트.

---
## B. 공휴일 / 대체공휴일  [서버 + 클라]

### 서버
`server/lib/holidays-kr.js`
- 데이터 원천: 구글 공개 ICS
  `https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics`
  (API 키 불필요). 파싱은 직접 (VEVENT 의 DTSTART;VALUE=DATE + SUMMARY 만 필요).
- 캐시: `data/user/holidays-kr.json` `{ version:1, fetchedAt, holidays:[{date:'YYYY-MM-DD', name:'설날', substitute:boolean}] }`
  - `substitute` = SUMMARY 에 '대체' 포함 여부.
- 갱신: 서버 부팅 시 캐시가 없거나 7일 이상 지났으면 백그라운드로 1회 fetch. 실패해도 서버는 정상 기동해야 한다(경고 로그만).
- **폴백 필수**: 네트워크가 막힌 환경을 대비해 파일 안에 2026~2027 고정 공휴일(신정·삼일절·어린이날·현충일·광복절·개천절·한글날·성탄절)을 하드코딩 테이블로 두고, fetch 실패 시 그걸 쓴다. 음력(설날/추석)은 추측해서 넣지 말 것 — fetch 로만 채운다.
- 노출: `getHolidays({ from, to })` 동기 조회 + `refreshHolidays()`.

### API
`GET /api/calendar/holidays?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ holidays: [...] }`
(from/to 생략 시 올해 1/1~내년 12/31)

### 클라
월간 그리드에서 공휴일 칸: 날짜 숫자 빨강 + 칸 상단에 공휴일 이름 작게. 대체공휴일은 이름 뒤 `(대체)`.
`useQuery(['calendar-holidays', 연도])` 로 캐시.

---
## C. 캘린더 하단 에이전트 채팅  [서버 + 클라]

"매년 3월 2일 개학이라고 일정 추가해줘" 를 채팅으로 시키는 패널.

### 서버
`GET /api/calendar/chat-session` → `{ sessionId }`
- 에이전트 `cw_calendar` 의 전용 세션을 sessionsStore 에서 찾고(제목 `📅 캘린더`), 없으면 생성해서 반환.
- 기존 세션 생성 경로(routes/sessions.js POST /) 와 동일한 방식으로 만들 것. 새 저장소 만들지 말 것.

### 클라
- CalendarPage 하단(또는 xl 이상에서 우측 하단)에 접이식 채팅 패널.
- **기존 채팅 인프라를 재사용할 것.** 스트리밍/메시지 렌더링을 새로 구현하지 말고
  ChatPage 가 쓰는 store/훅/메시지 컴포넌트를 그대로 붙인다. 전송은 `POST /api/chat {sessionId, message}`.
- 세션 id 는 위 API 로 1회 받아 보관. 실행 중이면 입력창에 '작업 중' 표시.
- 캘린더가 바뀌면(WS `calendar.changed`) 그리드가 자동 갱신되므로 채팅으로 추가한 일정이 바로 보인다.

---
## D. 반복 일정 + 알림  [서버 + 클라]

### D-1. 반복 (recurrence)
이벤트에 필드 추가:
```ts
recurrence: null | {
  freq: 'daily'|'weekly'|'monthly'|'yearly';
  interval: number;          // 기본 1
  until: string | null;      // 'YYYY-MM-DD', 없으면 무한
}
exdates: string[];           // 제외할 발생일 'YYYY-MM-DD', 기본 []
```
- 저장은 마스터 1건만. `list({from,to})` / `upcoming()` 이 **범위 안에서 발생분을 전개**해서 돌려준다.
- 전개된 발생분: `{ ...master, id: `${master.id}@YYYY-MM-DD`, masterId, isOccurrence: true, start/end 는 해당 회차 날짜 }`
- 안전장치: 한 번의 전개는 최대 500회. 무한 루프 방지.
- 윤달/말일 처리: monthly/yearly 에서 해당 월에 그 날짜가 없으면(예 2/30) 그 회차는 건너뛴다.
- PATCH/DELETE 에 발생분 id(`xxx@날짜`)가 오면:
  - `DELETE /api/calendar/:id?scope=occurrence` → 마스터의 exdates 에 그 날짜 추가
  - 그 외에는 마스터 전체(시리즈)에 적용. 발생분 id 는 마스터 id 로 정규화.

### D-2. 알림 (web push)
이벤트에 필드 추가: `remindMinutes: number[]` (기본 `[]`). 예 `[0, 30, 1440]` = 정시·30분 전·하루 전.
- `server/lib/calendar-reminders.js` — 60초 tick.
  - 앞으로 2일치 발생분을 전개해서, 각 `remindMinutes` 마다 알림 시각을 구하고
    지난 tick 이후~지금 사이에 들어온 것만 발송.
  - 종일 일정은 그날 **09:00 KST** 를 기준 시각으로 삼는다.
  - 발송: `pushStore.sendPushToAll(title, body, { skipIdleCheck: true, url: '/calendar' })`
    - title 예: `📅 30분 후 · 팀 회의`, body: 시각 + 장소/메모 첫 줄
  - 중복 방지: `data/user/calendar-fired.json` 에 `{key:'eventId@발생일#분', ts}` 기록, 7일 지나면 정리.
    서버 재시작으로 같은 알림이 두 번 가면 안 된다.
  - eventBus 로도 `calendar.reminder` 발행(웹 토스트용).
  - index.js 에서 부팅 시 start, 종료 시 stop. pushStore 주입.

### D-3. 클라 입력 UI
EventModal 에 두 섹션 추가:
- **반복**: 없음 / 매일 / 매주 / 매월 / 매년 + (선택) 종료일.
- **알림**: 없음 / 정시 / 10분 전 / 30분 전 / 1시간 전 / 하루 전 (다중 선택 칩).
- 반복 일정은 그리드에서 ↻ 아이콘, 알림 설정된 일정은 🔔 아이콘 표시.
- 발생분 삭제 시 "이 일정만 / 전체 시리즈" 선택 (전체 = 기본).

---
## 테스트 [서버]
`tests/calendar-recurrence.test.js` — 전개(daily/weekly/monthly/yearly), interval, until, exdates, 말일 스킵, 500회 상한.
`tests/calendar-reminders.test.js` — 알림 시각 계산, 종일 09:00 규칙, 중복 발송 방지.
기존 `tests/calendar-store.test.js` 가 깨지면 함께 고칠 것.
