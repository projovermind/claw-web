# Claw Web 아키텍처

> 개요·설치는 [../README.md](../README.md). 이 문서는 요청이 코드 안에서 어떻게 흐르는지만 다룬다.

## 1. 부팅과 의존성 주입

`server/index.js` 가 단일 컴포지션 루트다. 순서:

1. `data/` 레이아웃 확인 및 자가보정 (구버전 flat 레이아웃 → `private`/`user`/`shared` 이관,
   `web-config.json` 의 `configPath` 누락·오경로 복구, 템플릿에서 초기 파일 생성)
2. 스토어 생성 — `configStore`, `sessionsStore`, `projectsStore`, `skillsStore`, `backendsStore`,
   `accountsStore`, `devicesStore`, `metadataStore`, `secretsStore` …
3. `eventBus`, `runner`, `scheduler`, `delegationTracker`, `approvalBroker` 조립
4. `app.use('/api', createAuthMiddleware(...))` → 이후 라우터 전부 인증 뒤에 마운트
5. `http.createServer(app)` → `attachWsHub(server, { eventBus, webConfig })` → `listen(port)`

라우터는 모두 `createXxxRouter({ 의존성 })` 팩토리다. 전역 import 로 스토어를 끌어오지 않으므로
테스트에서 스텁을 주입해 서버 기동 없이 검증할 수 있다.

## 2. HTTP 요청 흐름

```
브라우저
  └─ fetch /api/<domain>            Authorization: Bearer <token>
      └─ auth 미들웨어              토큰 비교(timingSafeEqual) + IP 실패 카운터
          └─ routes/<domain>.js     zod 스키마 검증 (server/schemas/**)
              └─ lib/<domain>-store.js
                   read → mutate → proper-lockfile 로 잠그고 JSON 쓰기 → 캐시 갱신
              └─ eventBus.publish('<topic>.updated', payload)
                   └─ ws/hub.js → 접속 중인 모든 클라이언트에 브로드캐스트
```

에러는 라우터에서 `next(err)` 로 넘겨 `middleware/error-handler.js` 가 단일 지점에서 응답한다.
스토어는 인메모리 캐시 + 파일이 진실이며, `configStore` 는 chokidar 로 외부 편집도 감지한다.

## 3. 채팅 파이프라인

```
POST /api/chat      (routes/chat/index.js — sendSchema 검증)
   │
   ├─ dispatch.js        세션별 큐 + 동시성 제어
   │                     · kind별 우선순위/배타성: user, retry, resume(배타) / loop, wakeup, undelivered
   │                     · isSessionBusy() 로 한 세션에 동시에 한 턴만
   │                     · pump 재진입 가드, 하트비트로 유령 running 플래그 복구
   │
   ├─ message-sender.js  턴 1회를 실제로 구성
   │                     · resolveAgent(): agent + project + backend + account 병합
   │                     · 첫 턴이면 persona / skills / base / carl / paul 주입
   │                     · skill-injector: alwaysOn·triggers 매칭분만 전문, 나머지는 메타
   │                     · redactAttachments: 5턴 이전 첨부는 placeholder 로 치환
   │                     · --resume 대상 세션 파일 실재 확인 (없으면 fresh 로 강등)
   │
   ├─ runners/claude-cli-runner.js
   │                     spawn('claude', ['-p','--verbose','--output-format','stream-json', ...])
   │                     · CLAUDE_CONFIG_DIR 로 계정 선택 (백엔드/계정 로테이션)
   │                     · --model, --allowedTools, --disallowedTools, --append-system-prompt
   │                     · stdout NDJSON 파싱 → chunk / tool_use / result 이벤트
   │
   ├─ eventBus.publish('chat.chunk' | 'chat.tool' | 'chat.done' | 'chat.error' | 'chat.exit')
   │
   └─ ws/hub.js → 브라우저 스트리밍 렌더링
```

턴이 끝나면 메시지가 `sessionsStore` 에 append 되고, 컨텍스트가 길면 압축된다
(직전 5턴 = 10메시지는 원문 보존).

### 부가 경로

- **queue.js** — 세션이 바쁠 때 들어온 메시지 보관·재투입
- **wakeup.js** — 응답의 `<wakeup seconds=N>` 마커를 예약 턴으로 변환. 다른 턴이 세션을 먼저
  깨우면 예약을 취소한다
- **account-scheduler.js** — 러너 출력에서 rate limit 문구 감지 → 계정 쿨다운 → 다음 계정
- **approval-broker.js / mcp-approval** — 도구 권한 프롬프트를 UI 모달로 왕복

## 4. 위임 체인

```
플래너 턴 응답에 delegate JSON 블록
   └─ delegation.js: extractDelegateJson()
       ├─ depth < MAX_DELEGATION_DEPTH(3) 확인
       ├─ agent-roster.buildRoster() 로 대상 에이전트 해석 (명단은 프롬프트에 자동 주입)
       ├─ delegationTracker 에 running 등록 → publish('delegation.started')
       └─ ctx.dispatch(...) 로 워커 세션에 턴 생성
              │
              └─ 워커 응답의 <report> 블록 → extractReportBlock / renderReport
                     └─ 플래너 세션에 보고 턴 생성 → publish('delegation.completed')
```

`ctx.dispatch` 는 순환 참조를 피하려고 ctx 를 통해 지연 해석한다.
워커가 보고 없이 사라지면 `chat.done` 이 오지 않으므로, 60초 스윕이 10분 이상 정체된 위임을
정리해 트래커와 대상 에이전트의 busy 상태를 푼다.

## 5. 데이터 파일 위치

루트는 `REPO_ROOT/data/`.

| 경로 | 내용 | git |
|------|------|-----|
| `data/private/web-config.json` | 포트·토큰·allowedRoots·configPath | 제외 |
| `data/private/sessions-store/` | 세션 본문 (파일 분할 저장) | 제외 |
| `data/private/secrets.json` | 시크릿 | 제외 |
| `data/private/accounts.json` | Claude 계정 · CLAUDE_CONFIG_DIR 매핑 | 제외 |
| `data/private/push-subscriptions.json` | 웹푸시 구독 | 제외 |
| `data/user/agents-config.json` | 에이전트·채널 정의 (`configStore` 대상) | 제외 |
| `data/user/projects.json` | 프로젝트 | 제외 |
| `data/user/skills.json` | 스킬 | 제외 |
| `data/user/backends.json` | 백엔드/모델 (단일 진실) | 제외 |
| `data/user/devices.json` | 기기 북마크 | 제외 |
| `data/user/delegations.json`, `delegation-reports/` | 위임 상태·보고 원문 | 제외 |
| `data/user/uploads/` | 첨부 (sharp 로 1280px 리사이즈) | 제외 |
| `data/user/logs/activity.jsonl` | 활동 로그 | 제외 |
| `data/user/logs/running-processes.json` | 프로세스 트래커 | 제외 |
| `data/shared/*.template.json` | 초기 부팅용 템플릿 | **커밋** |

`web-config.json` 의 `configPath` 가 실제 에이전트 정의 파일을 가리킨다. 운영 인스턴스는
레포 루트의 `config.json`(gitignore 됨)을 쓰기도 하며, 누락 시 `data/user/agents-config.json` 로 폴백한다.
