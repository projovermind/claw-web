# Claw Web

Claude 에이전트를 웹에서 관리·대화·위임하는 셀프호스팅 콘솔.
프로젝트별 에이전트를 정의하고, Claude CLI 를 서버가 대신 실행해 스트리밍 응답을 브라우저로 중계한다.
스킬 상속, 도구 권한 제어, 세션 이어가기, 에이전트 간 위임, 스케줄 실행을 한 곳에서 다룬다.

## 요구사항

- **Node 20+**
- **Claude CLI** (`claude`) — 로그인 완료 상태. 설치 위치는 `~/.local/bin/claude` 네이티브 빌드 기준.
- macOS / Linux. 파일 스토어라 별도 DB 불필요.

## 설치 · 실행

```bash
./install.sh            # deps 설치 + 초기 데이터 파일 생성까지

# 또는 수동
npm install
npm --prefix client install
npm run build           # client/dist/ 생성 (tsc -b && vite build)
npm start               # NODE_ENV=production node server/index.js
```

개발 모드:

```bash
npm run dev             # server(:3838) + vite(:5273) 동시 실행
```

### 포트

| 포트 | 용도 |
|------|------|
| `3838` | API + WebSocket + 프로덕션 정적 파일 (같은 포트) |
| `5273` | Vite 개발 서버 (5173 회피) |

`web-config.json` 의 `port` 로 변경 가능.

### 인증

모든 `/api/*` 요청은 `Authorization: Bearer <token>` 필요 (`web-config.json` 의 토큰).
WebSocket 업그레이드도 같은 미들웨어를 탄다. IP당 연속 실패 10회 시 15분 잠금
(`server/middleware/auth.js`) — cloudflared 로 인터넷에 노출되는 전제이기 때문.

## 아키텍처

상세는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| 구성요소 | 역할 |
|---------|------|
| `server/index.js` | Express + WS 부팅, 스토어 생성·주입, 라우터 마운트, 데이터 레이아웃 자가보정 |
| `server/routes/**` | 도메인별 라우터 팩토리 (`createXxxRouter({deps})` 패턴, 30여 개) |
| `server/routes/chat/**` | 채팅 파이프라인 — `dispatch` / `message-sender` / `delegation` / `queue` / `wakeup` |
| `server/lib/**` | JSON 파일 스토어 + 도메인 로직 (스토어는 `proper-lockfile` 로 동시쓰기 방어) |
| `server/runners/**` | `claude-cli-runner.js` (Claude CLI spawn), `openai-runner.js`, `tool-executor.js` |
| `server/ws/**` | `hub.js` (eventBus → 브로드캐스트), `pty.js`, `exec.js`, `fs-watch.js` |
| `server/middleware/**` | 토큰 인증 + brute-force 가드, 에러 핸들러 |
| `server/schemas/**` | zod 스키마 (agent / backend / device / project) |
| `client/src/pages/**` | Dashboard · Agents · Chat · Projects · Skills · Files · Terminal · Settings |
| `data/private/**` | 세션·시크릿·계정·web-config (git 제외) |
| `data/user/**` | 에이전트·프로젝트·스킬·백엔드·기기·업로드 (git 제외) |
| `data/shared/**` | 초기 템플릿 (git 커밋 대상) |

라우터는 전부 의존성 주입 팩토리라 테스트에서 스토어를 스텁으로 바꿔 끼울 수 있다.
상태 변경은 `eventBus.publish(topic, payload)` 로 발행되고 WS 허브가 그대로 클라이언트에 흘린다
(`chat.chunk`, `chat.done`, `agent.updated`, `delegation.started`, `schedule.triggered` 등).

## 스킬 시스템

스킬은 에이전트의 시스템 프롬프트에 붙는 마크다운 조각이다. 전역 정의 후 에이전트가 상속한다.
전부 매번 풀주입하면 토큰이 터지므로 **주입 모드**로 나눈다 (`server/lib/skill-injector.js`):

| 모드 | 조건 | 동작 |
|------|------|------|
| `always` | `alwaysOn: true` | 항상 전문 주입 |
| `triggered` | `triggers: ["키워드", …]` | 사용자 메시지에 키워드가 있을 때만 전문 주입, 아니면 메타만 |
| `manual` | 둘 다 없음 | 메타(name + description)만 — 필요할 때 본문을 붙여 씀 |

주입 모드와 예상 토큰은 `GET /api/skills` 응답의 `mode` / `estimatedTokens` 로 내려가고
Skills 화면에 배지로 표시된다 (`estimateSkillTokens`, `skillMode` — `server/lib/skills-store.js`).

GitHub 의 `SKILL.md` 를 일괄 수입하려면:

```bash
python3 scripts/import-github-skills.py
```

## 위임 (delegation)

에이전트가 응답 안에 `delegate` JSON 블록을 남기면 서버가 파싱해 대상 에이전트 세션으로
작업을 디스패치하고, 워커가 끝나면 결과를 요청자(플래너) 세션에 보고 턴으로 돌려준다
(`server/routes/chat/delegation.js`).

- 체인 깊이는 `MAX_DELEGATION_DEPTH = 3` 으로 제한 — 재위임이 무한히 토큰을 태우는 걸 막는다.
- 워커가 크래시·외부 kill 로 사라지면 `chat.done` 이 오지 않아 트래커가 영원히 `running` 으로 남는다.
  60초 스윕이 10분 무응답 위임을 정리한다.
- 명단표는 `agent-roster.js` 가 자동 주입하므로 프롬프트에 손으로 적지 않는다.
- 진행 상황은 `GET /api/delegations`.

## 스케줄 (schedules)

외부 cron 라이브러리 없이 60초 틱으로 5필드 cron 식(`분 시 일 월 요일`, 범위·리스트·스텝 지원)을
평가한다 (`server/lib/scheduler.js`). 매칭되면 `schedule.triggered` 를 발행해 해당 에이전트 턴을 연다.

## 백엔드 (backends) · 계정 로테이션

`backends.json` 이 모델/계정 설정의 단일 진실이다. 각 백엔드는 Claude CLI 를 어떤
`CLAUDE_CONFIG_DIR` 로 띄울지(=어느 계정으로 붙을지)를 결정한다.

CLI 출력에서 rate limit 문구(`usage limit`, `try again in N hours`, `5-hour limit` …)를 감지하면
`account-scheduler.js` 가 해당 계정에 쿨다운을 걸고 다음 계정으로 넘긴다. 세션 이어가기(`--resume`)
시에는 세션 파일이 실제로 존재하는 계정 디렉터리를 찾아 `CLAUDE_CONFIG_DIR` 을 그쪽으로 전환한다.

## 기기 전환 (devices)

여러 대의 claw-web 인스턴스를 북마크해 두고 UI 에서 오갈 수 있다 (`data/user/devices.json`,
`GET/POST /api/devices`). 각 기기는 이름 + URL + 토큰을 갖는다.

## 운영

프로덕션은 macOS LaunchAgent + cloudflared named tunnel 로 돌린다.

| 항목 | 값 |
|------|-----|
| 앱 LaunchAgent | `cc.subinggrae.claw-web` |
| 터널 LaunchAgent | `cc.subinggrae.cloudflared` (named tunnel `claw-web`, HTTP/2 강제) |
| 앱 로그 | `~/Library/Logs/claw-web/` |
| 터널 로그 | `~/Library/Logs/cloudflared/` |

```bash
launchctl kickstart -k gui/$(id -u)/cc.subinggrae.claw-web    # 재시작
npm run soft-restart                                          # 진행 중 턴을 죽이지 않는 재기동
```

> ⚠️ claw-web 안에서 돌고 있는 세션은 자기 자신을 재시작하면 안 된다 (자기 러너가 같이 죽는다).
> 호스팅된 세션에서의 재시작은 사용자에게 요청한다.

터널 설정만 바꿀 때는 재시작 대신 SIGHUP 리로드를 쓴다 (진행 중 세션 유지).

### 진단

```bash
node scripts/analyze-tokens.mjs [--session=ID] [--days=N]   # 세션별 토큰 추이
curl -s -H "Authorization: Bearer $TOKEN" localhost:3838/api/health
```

`packaging/` 은 `.pkg` 배포 빌드(`build-pkg.sh`), `packaging/archive/` 는 옛 산출물·UI 스냅샷 보관소다
(대부분 `.gitignore` 대상).

## 테스트

```bash
npm test                          # vitest run (서버 단위 테스트, tests/*.test.js)
npm --prefix client run build     # tsc -b 타입체크 포함
```

서버를 띄우지 않고 라우터 팩토리에 스텁 스토어를 주입해 검증하는 구조라,
테스트가 프로덕션 프로세스를 건드리지 않는다.

## 라이선스

Private.
