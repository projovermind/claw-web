# 2026-09-03 클라이언트 전수 검수 (B-4)

대상: `client/src/{pages,components,hooks,store,lib}/**` (24,388줄 / 60+ 파일)
검수 방식: 패턴 스윕(리스너·타이머·WS 정리, 렌더 중 배열 변형, raw fetch 인증, API 응답 형태) + 의심 지점 직접 읽기.
원칙: **실제 버그만 수정**. 스타일/구조 변경 없음.

---

## 수정한 버그 (3건)

### 1. SetupWizard — 존재하지 않는 토큰 키를 읽어 auth 켜진 서버에서 항상 401
`client/src/pages/SetupWizard.tsx:58,97` (수정 전)

```
'Authorization': `Bearer ${localStorage.getItem('claw:auth-token') ?? ''}`
```

실제 토큰 키는 `hivemind:auth-token` (`lib/api.ts:19` TOKEN_KEY). `claw:auth-token` 은 코드베이스 전체에서 이 두 곳에만 등장 —
즉 **auth 를 켠 서버에서는 초기 설정 마법사의 프로젝트 스캔/적용이 100% 실패**한다 (`Bearer ` 빈 토큰 → 401).
신규 설치 직후 auth 를 먼저 켠 사용자는 마법사를 아예 못 쓴다.

수정: `getAuthToken()` 을 쓰는 `authHeader()` 헬퍼 도입, 두 호출부 모두 교체.

### 2. 시스템 스킬 새로고침 — 인증 헤더 없음 + `res.ok` 미검사로 실패를 성공으로 보고
`client/src/pages/SkillsPage.tsx:126` (수정 전)

```
mutationFn: () => fetch('/api/skills/system/refresh', { method: 'POST' }).then((r) => r.json())
```

`api` 래퍼를 안 거쳐 Authorization 헤더가 빠졌고, `res.ok` 도 안 본다.
auth 가 켜져 있으면 401 → 에러 바디를 `.json()` 으로 정상 파싱 → **mutation 은 성공 처리 → "새로고침 완료" 토스트**.
스킬 목록은 그대로인데 성공했다고 알려주는 조용한 거짓 보고.

수정: `api.refreshSystemSkills()` (`lib/api.ts` 신규, `post()` 경유 → 토큰 + 상태코드 검사 자동) 로 교체.

### 3. AgentStatsWidget — 렌더 중 memo 배열 제자리 정렬
`client/src/components/dashboard/AgentStatsWidget.tsx:140`

`g.agents.sort(...)` 가 `useMemo` 가 반환한 배열을 렌더 도중 변형한다. React StrictMode 이중 렌더/동시성 렌더에서 memo 캐시가
호출 간 달라질 수 있는 부작용. 수정: `[...g.agents].sort(...)` 로 복사 후 정렬.
(같은 파일 82행, `lib/visibility.ts:135`, `AgentPickerPopover.tsx:66` 의 `.sort()` 는 모두 로컬 신규 배열 → 문제 없음.)

---

## 검수했고 문제 없던 것

- **이펙트 정리**: `addEventListener`/`removeEventListener`, `setInterval`/`clearInterval`, `new WebSocket`/`.close()` 짝을
  전 파일 대조. 불일치 3파일(`ClaudeStatusCard`, `SettingsPage`, `AccountAuthModal`)은 모두 한 cleanup 에서 여러 개를
  해제하는 형태로 정상. `FileTree`(fs-watch), `RunPanel`(exec), `Terminal`(pty), `useWebSocket`(전역) 모두 언마운트 시 close.
- **useWebSocket 재연결**: `onclose` 의 `setTimeout(connect)` 는 타이머 id 를 안 잡지만 `connect()`/`onclose` 양쪽에
  `cancelled` 가드가 있어 언마운트 후 재연결하지 않음.
- **API 응답 봉투**: 클라가 `.then(r => r.X)` 로 벗기는 8개 엔드포인트(activity→entries, tasks, hooks, schedules,
  accounts, delegations, skills, devices)를 서버 `res.json({...})` 과 1:1 대조 — 전부 일치.
- **SessionMeta 필드**: `recent24hCount` / `isRunning` 은 `server/routes/sessions.js:73-75` 에서 생성. 일치.
- **나머지 raw fetch 21곳**(AccessTab·FilesPage·ChatInput·Sidebar): 전부 `authHeaders()` 또는 `getAuthToken()` 사용 — 정상.
- **전역 훅**(`useUnreadGuard`, `useActivityPing`, `useGlobalFileDrop`, `useUndoShortcut`): 리스너 해제·스로틀 정상.
- **스토어**(`chat`, `delegation`, `uploads`, `toast`, `ws`, `progress-toast`): 모든 갱신이 불변 업데이트. 문제 없음.

---

## 고치지 않고 남긴 것 (근거 포함)

### A. 모달 10개에 Escape 닫기 없음 — 접근성
`AgentModal`, `BulkModelChangeModal`, `EditProjectModal`, `AddBackendModal`, `RevealTokenModal`, `AccountAuthModal`,
`BulkAssignModal`, `EditSkillModal`, `LoginDialog`, `ContextMenu`.
(`FileDiffModal`, `PermissionPromptModal`, `PathPicker`, `CommandPalette`, `FilePalette`, `ClaudeDesignModal` 은 있음.)

전부 백드롭 클릭 + 눈에 보이는 X 버튼으로 닫을 수 있어 "심각" 수준은 아니고, 10개 파일에 동일 이펙트를 복붙하는 것은
이번 지시의 "실제 버그만 수정" 범위를 넘는다. 별도 티켓 권장 — `useEscapeClose(onClose)` 훅 하나로 일괄 처리 가능.
(이번에 새로 만든 `ImportSkillModal` 에는 처음부터 넣어 뒀다.)

### B. WS 이벤트가 `['sessions-all']` 쿼리를 무효화하지 않음
`hooks/useWebSocket.ts:19-22` 의 `TOPICS_TO_INVALIDATE` 는 `session.*` → `['sessions']` 만 무효화한다.
react-query 접두 매칭은 `['sessions']` ≠ `['sessions-all']` 이라 사이드바/대시보드 목록에는 안 먹는다.
다만 `['sessions-all']` 소비자 8곳 중 7곳이 3~10초 `refetchInterval` 을 걸고 있어 실제 증상은 "최대 3~5초 지연"뿐이고
데이터가 틀어지지는 않는다. 즉시 반영을 원하면 한 줄 추가로 되지만, 동작 버그가 아니라 반응속도 이슈라 보류.

### C. 위임 세션 식별 방식이 두 가지로 갈림
`isDelegation` 플래그(`server/routes/chat/delegation.js:215` 에서 신규 생성 시에만 세팅)와
`title.startsWith('[위임]')` 문자열 검사가 파일마다 섞여 쓰인다
(`ChatSidebar:186`·`ChatPage:279` 는 플래그만, `Sidebar:70`·`DashboardPage:51` 은 제목만).
플래그 도입 이전 세션에는 `isDelegation` 이 없으므로 제목 검사 쪽이 더 넓게 잡는 상태 —
현재 두 방식 다 "숨기는" 방향으로만 틀려서 유령 표시는 안 나지만, 서버가 과거 세션에 플래그를 백필한 뒤
제목 검사를 걷어내는 정리가 필요하다. 서버 변경이 선행돼야 해서 이번엔 보류.

---

## 검증
`npm --prefix client run build` (tsc -b 포함) → `✓ built in 3.34s`, 에러 0.
