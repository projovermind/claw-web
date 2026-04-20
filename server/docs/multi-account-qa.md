# Multi-Account QA 시나리오

## 환경 설정
- `MOCK_RATE_LIMIT=1` 환경변수: runner에서 스폰 후 0.5초에 강제 rate-limit 트리거
- 테스트 실행 전 최소 2개 이상의 active 계정이 등록되어 있어야 합니다

---

## 시나리오 a — 프로젝트 계정 고정

**목표**: 프로젝트에 계정을 지정하면 해당 프로젝트의 에이전트가 그 계정을 사용하는지 확인

**단계**:
1. 프로젝트 편집 모달에서 'Claude 계정' 드롭다운에서 특정 계정 선택 후 저장
2. 해당 프로젝트 에이전트로 채팅 세션 시작
3. 서버 로그에서 `CLAUDE_CONFIG_DIR` 가 해당 계정의 `configDir` 로 설정됐는지 확인

**기대 결과**: `runner: spawn claude` 로그에 해당 계정의 configDir 반영됨

**체크**:
- [ ] 프로젝트 편집 모달에 '프로젝트 계정' 드롭다운이 표시됨
- [ ] 저장 후 API PATCH `/api/projects/:id` 에 `accountId` 포함됨
- [ ] `resolveAgent` 에서 `agent.projectAccountId` 가 project.accountId 로 설정됨
- [ ] `pickAccount` 가 agent.accountId 없을 때 projectAccountId 를 2순위로 선택함

---

## 시나리오 b — 자동 round-robin

**목표**: 계정 미지정 시 가장 최근 사용 시간이 오래된 계정이 선택되는지 확인

**단계**:
1. 프로젝트 계정을 "자동 (스케줄러 분배)"으로 설정
2. 두 개의 active 계정으로 2회 연속 채팅 전송
3. 로그에서 번갈아 다른 계정이 사용되는지 확인

**기대 결과**: 매 실행마다 `lastUsedAt` 가 갱신되며 LRU 순으로 선택

**체크**:
- [ ] 첫 번째 실행: 계정 A 선택
- [ ] 두 번째 실행: 계정 B 선택 (A의 lastUsedAt이 더 최근이므로)

---

## 시나리오 c — rate-limit 감지 및 계정 전환 알림

**목표**: rate-limit 발생 시 WebSocket으로 계정 전환 이벤트가 브로드캐스트되는지 확인

**단계**:
1. `MOCK_RATE_LIMIT=1` 으로 서버 재시작
2. 채팅 세션 시작
3. WebSocket 메시지에서 `chat.account-ratelimit` 이벤트 수신 확인
4. 이벤트에 `{ sessionId, accountId, nextAccountId }` 포함 확인

**기대 결과**: WS 클라이언트에 `{ type: 'chat.account-ratelimit', accountId: '...', nextAccountId: '...' }` 수신

**체크**:
- [ ] `MOCK_RATE_LIMIT=1` 시 0.5초 내 rate-limit 트리거
- [ ] `chat.account-ratelimit` WS 이벤트 발송
- [ ] `accountId` = 현재 rate-limited 계정 ID
- [ ] `nextAccountId` = 다음 active 계정 ID (없으면 null)
- [ ] 프로세스가 SIGTERM으로 종료됨 (재시작 준비)

---

## 시나리오 d — rate-limit 후 재시작 (최대 1회)

**목표**: rate-limit 후 자동으로 다른 계정으로 1회 재시도하는지 확인

**단계**:
1. 2개 이상의 active 계정 등록
2. `MOCK_RATE_LIMIT=1` 로 서버 재시작
3. 채팅 전송
4. 로그에서 첫 번째 실행(계정 A)이 rate-limit 후 두 번째 실행(계정 B)으로 자동 전환 확인
5. 두 번째 실행도 `MOCK_RATE_LIMIT=1` 로 실패하면 더 이상 재시도하지 않는지 확인

**기대 결과**: 최대 1회만 계정 전환 재시도. 2회 이상 재시도 없음.

**체크**:
- [ ] 첫 rate-limit → 자동 재시작 with 계정 B
- [ ] 두 번째 rate-limit → 재시작 없음 (에러 메시지 표시)
- [ ] `rateLimitRestartDone` 플래그로 중복 재시작 방지

---

## 시나리오 e — cooldown 계정 복원

**목표**: cooldown 만료 후 계정이 자동으로 active 상태로 복원되는지 확인

**단계**:
1. 계정 하나를 수동으로 cooldown 상태로 설정 (cooldownUntil = 과거 시각)
2. 다음 채팅 전송 (pickAccount 호출 시 autoRestoreCooldowns 실행)
3. 로그에서 `cooldown expired — restored to active` 메시지 확인
4. 계정 목록 API `/api/accounts` 에서 해당 계정이 `active` 상태인지 확인

**기대 결과**: cooldownUntil 이 현재 시각보다 과거이면 자동으로 active 로 복원

**체크**:
- [ ] `autoRestoreCooldowns` 실행 로그 확인
- [ ] 계정 상태가 `cooldown` → `active` 로 변경됨
- [ ] 복원된 계정이 다음 round-robin에서 선택 가능

---

## 빠른 테스트 명령

```bash
# MOCK_RATE_LIMIT 모드로 서버 실행
MOCK_RATE_LIMIT=1 npm start

# 계정 목록 조회
curl -s http://localhost:3838/api/accounts | jq '.accounts[] | {id, label, status}'

# WS 이벤트 모니터링 (wscat 필요: npm i -g wscat)
wscat -c ws://localhost:3838/ws
```
