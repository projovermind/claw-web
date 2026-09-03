# 2026-09-03 서버 전수 검수 (A-6)

범위: `server/routes/**`, `server/lib/**`, `server/runners/**`, `server/index.js`, `server/ws/**`,
`server/middleware/**`, `server/schemas/**` — 약 90개 파일 / 17k 라인.

검수 방식: 4개 그룹으로 나눠 전 파일 정독 → 후보 34건 도출 → 각 건을 원본 코드에서 재확인
(트리거 경로 추적, 필요 시 Node 동작 실증) → 실제 버그 31건 수정, 3건은 검토 후 수정 보류.
스타일/네이밍/리팩토링은 손대지 않음.

---

## 수정한 버그 (31건)

### 심각 — 서버 전체가 죽거나 데이터가 사라짐

| # | 위치 | 버그 | 트리거 → 결과 |
|---|------|------|--------------|
| 1 | `server/index.js:739` | `logsDir` 가 `PRIVATE_DIR/logs` 를 가리켰지만 `.soft-restart`/`pending-resume.json` 을 쓰는 쪽(`admin/restart.js:43`, `index.js:526`)은 `USER_DIR/logs` | soft-restart 시 플래그를 못 찾아 `autoResume` 이 영구히 false → 진행 중이던 세션이 전부 "중단되었습니다"로 끝남. 반대로 `preserveSessionIds` 도 항상 빈 배열이라 살아있는 CLI 자식을 SIGTERM. 디스크 증거: `data/user/logs/.soft-restart`(2026-08-31) 가 소비되지 않은 채 남아 있고 `data/private/logs/` 는 비어 있음 |
| 2 | `server/ws/hub.js:51` | `/ws` 허브 소켓에만 `'error'` 리스너가 없음 (pty/exec/fs-watch 는 전부 있음) | 노트북 절전·LTE 끊김으로 ECONNRESET → 리스너 없는 EventEmitter throw → `uncaughtException` → `emergencyShutdown` → 브라우저 탭 하나 때문에 서버 전체 재시작 |
| 3 | `server/lib/sessions-store.js:97` | `next.finally(...)` 가 만든 파생 promise 를 아무도 처리 안 함 | 세션 파일 쓰기 실패(ENOSPC/EACCES) 1건 → unhandledRejection → `emergencyShutdown` → 전 세션 종료 |
| 4 | `server/routes/chat/message-sender.js:497` | `handleDelegation`/`handleLoopContinuation`/`handleWakeup` 셋 다 async 인데 await/.catch 없이 호출 | 세 핸들러 내부의 무방비 `await sessionsStore.update()` (delegation.js:270,416,425) 가 reject → unhandledRejection → 서버 종료. 같은 파일의 다른 store 쓰기는 전부 `.catch(()=>{})` 되어 있어 명백한 누락 |
| 5 | `server/routes/chat/queue.js:21` | `setTimeout(() => ctx.executeDelegation(...))` — 타이머 콜백 안의 floating async | 큐에서 꺼낸 위임의 store 쓰기가 실패하면 unhandledRejection → 서버 종료 |
| 6 | `server/lib/metadata-store.js:39` | `writeWithLock` 이 쓰기 직전 재읽기에 실패를 삼키는 `read()` 를 씀 (EMPTY 반환) | metadata.json 이 일시적으로 안 읽히면 다음 `updateAgent` 가 EMPTY 위에 덮어써 **모든 에이전트의 projectId/tier/skillIds/order 가 영구 소실**. 형제 스토어(skills/projects/devices/backends)는 전부 throw 시킴 |
| 7 | `server/lib/sessions-store.js:250` | `unarchiveSessions` 가 호출자의 낡은 스냅샷을 그대로 씀 | 에이전트 삭제 → 진행 중이던 턴이 뒤늦게 `appendMessage` → undo 실행 시 그 응답과 `claudeSessionId` 가 통째로 사라짐 |
| 8 | `server/routes/admin/tunnel-cf.js:83`, `server/routes/tunnel.js:105`, `server/routes/admin/update.js:76` | `spawn()` 에 `'error'` 리스너 없음 | cloudflared/ngrok 미설치 호스트에서 버튼 한 번 → ENOENT → `uncaughtException` → 서버 재시작. `tunnel/cf/status` 는 `bin === 'cloudflared'` 폴백 때문에 `binInstalled: true` 를 항상 보고해 UI 가 버튼을 노출 |

### 동작 오류

| # | 위치 | 버그 | 트리거 → 결과 |
|---|------|------|--------------|
| 9 | `server/runners/claude-cli-runner.js:662` | `proc.on('close', (code))` 에서 시그널을 안 받아 `code === 143 \|\| code === 137` 이 죽은 코드 (Node 는 시그널 종료 시 `code=null, signal='SIGTERM'`) | (a) 중단된 워커가 부분 출력을 갖고 있으면 `message-sender:508` 의 `wasKilled` 가 false → 플래너에게 **"✅ 위임 완료"** 로 잘못 보고 (해당 코드의 주석이 막으려던 바로 그 실패). (b) 출력 없이 중단하면 `onExit` 의 `code === null` 이 silent-exit 분기를 태워 2초 뒤 **사용자가 방금 취소한 메시지를 자동 재전송**. 실증: `spawn('sleep').kill('SIGTERM')` → `close code=null signal=SIGTERM` |
| 10 | `server/routes/lsp.js:23` | `projectsStore.list()` 는 존재하지 않는 메서드 (`getAll()` 임) | `/api/lsp/definition`·`/references` 100% 가 TypeError → 500. 의도한 404 는 도달 불가 |
| 11 | `server/routes/chat/dispatch.js:240` | `running` 이 Set 이라 소유권 개념이 없음 | Stop → SIGTERM 유예(최대 3초) 안에 새 메시지 전송 → 새 턴 B 시작 → 뒤늦은 턴 A 의 `onSettled` 가 B 의 `running` 플래그를 삭제 → 한 세션에 CLI 자식 2개, B 는 abort 불가. 턴 토큰(Map) 으로 자기 턴일 때만 해제하도록 변경 |
| 12 | `server/routes/undo.js:18` | 검증 전에 `popUndo()` 로 항목을 꺼냄 | 복원 대상 에이전트가 없어 404 로 빠지면 undo 기록이 영구 소실되고, 다음 undo 가 **무관한 옛 변경**을 되돌림. peek → 적용 → pop 으로 변경 |
| 13 | `server/routes/agents.js:95` | undo 스냅샷을 뜬 *뒤에* `projectId → workingDir` 를 주입 | `PATCH {projectId}` 후 undo 하면 projectId 만 돌아오고 workingDir 은 새 프로젝트에 남아 에이전트가 엉뚱한 디렉터리에서 실행됨 |
| 14 | `server/lib/runner.js:174` | openai→Claude CLI 폴백이 `accountScheduler` 를 안 넘김 (기본 경로는 넘김) | ZAI/DeepSeek 실패 후 폴백이 지정 계정이 아닌 기본 `~/.claude` 로 실행되고 사용량 기록·쿨다운 회전도 안 걸림 |
| 15 | `server/lib/secrets-store.js:69` | `writeChain` 이 한 번 reject 되면 복구 불가 | 디스크 풀 등으로 flush 1회 실패 → 이후 모든 `set()` 이 콜백조차 실행 안 되고 옛 에러만 반환. 메모리·`process.env` 는 갱신돼 UI 는 성공으로 보이지만 **재시작 전까지 아무것도 저장 안 됨** |
| 16 | `server/lib/scheduler.js:73` | 요일 필드가 `getDay()`(0–6)와만 비교 — cron 표준의 일요일 `7` 미지원 | `0 9 * * 7` ("매주 일요일 9시") 저장 시 에러 없이 **영원히 안 돌음** |
| 17 | `server/routes/accounts.js:245` | `autoActivated` 응답값이 `cred?.has` 가드 없이 계산 | 자격증명 없는 disabled 계정을 test 하면 실제로는 비활성인데 UI 는 재활성화됐다고 표시 |
| 18 | `server/routes/tunnel.js:130` | 자식의 `'exit'` 핸들러가 무조건 공용 상태를 초기화 | stop→start 를 빠르게 하면 옛 자식의 exit 이 새 터널의 상태·pid 파일을 지움 → `/status` 는 없다고 하는데 프로세스는 살아 있고, 다음 start 가 고아를 하나 더 만듦 |

### 보안 / 검증 누락

| # | 위치 | 버그 | 트리거 → 결과 |
|---|------|------|--------------|
| 19 | `server/routes/settings.js:44` | 인증 면제된 `GET /api/settings`(`middleware/auth.js:77`) 가 `webConfig` 를 통째로 반환 — **VAPID 개인키 포함** | 터널 주소만 알면 무인증 `curl` 로 `vapidPrivateKey` 획득 → 구독된 모든 기기에 푸시 위조 가능. `data/private/web-config.json` 에 실제 존재함을 확인. 코드 주석은 "토큰이 마스킹되므로 안전"이라 주장하나 마스킹되는 건 `auth.token` 뿐 |
| 20 | `server/index.js:687` | 네 개의 `upgrade` 핸들러가 경로 불일치 시 조용히 return — 리스너가 붙어 있으면 Node 의 기본 `socket.destroy()` 가 동작 안 함 | `/ws/아무거나` 로 upgrade 요청 시 소켓이 fd 를 쥔 채 무기한 유지. **인증 이전 단계**라 누구나 반복해 fd 고갈 가능. 각 attach 의 매칭 조건을 그대로 복제한 catch-all 핸들러 추가 |
| 21 | `server/routes/lsp.js:86,137,164` | `req.body.file` 이 검증 없이 `fs.readFile` 로 (형제 라우트는 전부 allowedRoots 검사) | `POST /api/lsp/hover {"file":"~/.ssh/id_rsa","line":N}` 로 line 을 순회하며 임의 파일 덤프. 등록된 프로젝트 경로 내부로 제한 |
| 22 | `server/routes/project-md.js:46` | allowedRoots 검사가 구분자 없는 `startsWith` | 루트가 `/a/work` 일 때 `/a/work-secrets` 프로젝트가 통과 → 샌드박스 밖에 CLAUDE.md 기록. `fs-browser.js:37` 과 동일한 패턴으로 교정 |
| 23 | `server/routes/export-import.js:60,95,140,163,205` | `req.body.dir` 이 검증 없이 `git init`/`git add .`/`git commit` 의 cwd | `{"dir":"/내/실제/레포"}` → 그 레포의 커밋 안 된 변경 전부를 커밋. `DEFAULT_DIR` 하위로 제한 (클라이언트는 이 API 를 쓰지 않음 — 확인함) |

### 리소스 누수

| # | 위치 | 버그 | 트리거 → 결과 |
|---|------|------|--------------|
| 24 | `server/runners/claude-cli-runner.js:665` | `postToolThinkingTimer` 만 `close` 에서 안 지움 | 도구를 쓴 턴마다 60초 뒤 고아 콜백이 깨어나 **죽은 proc 을 상대로 20분짜리 stall 타이머를 새로 걸음**. 영원히 안 지워지고 이벤트 루프를 붙잡음 |
| 25 | `server/lib/session-analyzer.js:112` | 60초 워치독을 정상 종료 시 안 지움 | 모든 `chat.done` 이 60초짜리 타이머 + proc/직렬화된 대화 클로저를 붙잡음 |
| 26 | `server/lib/delegation-tracker.js:58` | `history`/`finished` 는 300개로 캡되는데 `byOrigin` 은 안 됨 | 완료된 위임의 task 본문·결과가 프로세스 수명 내내 남고, 장수 플래너 세션의 `getByOrigin()` 이 무한히 커짐 |
| 27 | `server/routes/accounts.js:429` | 헤드리스 로그인 PTY 가 명시적 DELETE 없이는 회수되지 않음 | 로그인 모달 열고 탭만 닫으면 `claude login` 자식이 영구 잔존. 반복하면 계속 쌓임. 10분 TTL reaper 추가 |
| 28 | `server/ws/fs-watch.js:101` | `await stopWatcher()` 중에 소켓이 닫히면 그 뒤 생성한 watcher 를 아무도 못 닫음 | subscribe(A) → subscribe(B) → 즉시 close → chokidar watcher 와 fsevents 핸들이 프로세스 수명 내내 잔존. 재접속 반복 시 EMFILE |
| 29 | `server/lib/push-store.js:53` | `saveSubs` 가 tmp+rename 없이 in-place 쓰기 | 쓰기 중 프로세스 종료(`emergencyShutdown` 의 1초 exit 포함) → 파일이 잘리고 `loadSubs` 가 파싱 실패로 **전체 구독을 버림** → 모든 기기 알림 중단 |
| 30 | `server/lib/carl-auto-learner.js:57` | 공용 `carl.json` 을 락 없이 read-modify-write | 같은 프로젝트의 두 세션이 동시에 `chat.done` → 나중 쓰기가 앞선 세션의 학습 룰을 조용히 덮어씀. 경로별 in-process 직렬화 추가 (사용자 레포에 `.lock` 파일을 만들지 않기 위해 proper-lockfile 대신 promise chain 사용) |
| 31 | `server/routes/accounts.js:119` | mkdir 실패 시 계정 행만 남음 | `POST /api/accounts` 에서 configDir mkdir 이 EACCES → 클라이언트는 500 을 받지만 목록에는 `configDir:""` 인 유령 계정이 남음. 실패 시 롤백하도록 변경 |

---

## 검토 후 수정하지 않은 것 (3건)

| 위치 | 관찰 | 보류 이유 |
|------|------|-----------|
| `server/ws/exec.js:138` | 자식 stdout/stderr 을 backpressure·상한 없이 소켓으로 전달. 느린 클라이언트에 `yes` 를 돌리면 `ws` 내부 송신 버퍼가 무한히 쌓여 OOM 가능 (`send()` 는 `readyState` 만 확인) | **실재하는 문제지만 미수정.** pause/resume 도입은 스트리밍 동작을 바꾸므로 실사용 검증이 필요한데, 이번 작업은 서버 재시작이 금지되어 단위 테스트로만 검증 가능. 제안 패치: 데이터 핸들러에서 `ws.bufferedAmount > 4MB` 면 `child.stdout.pause()`, 드레인 후 `resume()`. **후속 작업으로 남김** |
| `server/routes/chat/wakeup.js:49` | `epochs` Map 이 세션당 1개씩 쌓이고 삭제되지 않음 | 수정이 오히려 버그를 만든다. `cancelWakeup` 은 epoch 를 +1 해 진행 중인 `fire()` 를 무효화하는데, 여기서 키를 지우면 `get() ?? 0` 이 0 으로 되돌아가 epoch 0 이던 in-flight fire 가 가드를 통과해 **취소가 무력화**된다. 누수량은 세션당 정수 하나 수준 |
| `server/routes/chat/index.js:207` | `DELETE /api/chat/:sessionId` 가 존재하지 않는 세션에도 200 반환 | 의도된 멱등 동작으로 판단. abort 는 "실행 중이 아니면 아무것도 안 함"이 맞고, 아직 저장 전인 세션에 Stop 을 누르는 정상 흐름이 404 로 깨질 수 있음 |

---

## 검증

```
npx vitest run   →  Test Files 22 passed (22) / Tests 127 passed (127)
```

서버 재시작 없이 단위 테스트로만 검증 (요청대로). `node --check` 로 변경 파일 전수 문법 확인,
변경한 모든 서버 모듈을 `import()` 로 로드해 순환/누락 import 없음을 확인.
