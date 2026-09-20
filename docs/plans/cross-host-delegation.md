# 크로스호스트 위임 (인스턴스 연합) — MVP 스펙

맥(`subinggrae.cc`)과 윈도우(`win.subinggrae.cc`)는 각각 완전한 claw-web 인스턴스다.
에이전트 **정의**는 `scripts/sync-agents.mjs` 로 이미 공유된다. 없는 것은 **실행의 이동** —
맥 세션이 "이건 윈도우 환경에서 해야 한다" 고 판단했을 때 윈도우 기계에 일을 시키는 경로.

SSH 로 CLI 만 원격 실행하는 방식은 채택하지 않는다. 스트리밍·인증·파일편집이 전부 원격이 되고
WSL VM 생사에 맥 세션이 묶인다. 대신 **양쪽 인스턴스를 그대로 두고 위임만 HTTP 로 건너뛴다.**

## 용어

| 용어 | 뜻 |
|---|---|
| origin | 위임을 건 쪽 (리드 세션이 있는 인스턴스) |
| remote | 위임을 받아 실제로 워커를 스폰하는 인스턴스 |
| selfId | 이 인스턴스 자신의 식별자 (`mac` / `win`) |

양방향이다. 같은 코드가 origin 도 remote 도 된다.

---

## 1. 인스턴스 레지스트리

`data/user/instances.json` (신규, `data/user/` 는 gitignore 대상)

```json
{
  "version": 1,
  "selfId": "mac",
  "selfPublicUrl": "https://subinggrae.cc",
  "instances": {
    "win": {
      "label": "윈도우 (DESKTOP-LCF5LJ9)",
      "baseUrl": "https://win.subinggrae.cc",
      "token": "<원격 인스턴스가 발급한 연합 토큰>",
      "enabled": true,
      "platform": "win32",
      "lastHealthAt": 1789920000000,
      "health": { "ok": true, "version": "1.20.0", "latencyMs": 142, "error": null }
    }
  }
}
```

- `selfPublicUrl` 은 **콜백 URL 의 베이스**다. 비어 있으면 원격 위임을 **거부**한다
  (콜백을 받을 주소가 없으면 회신이 영영 안 온다 — 조용히 진행하지 말 것).
- `token` 은 UI 인증 토큰(`930214`)과 **분리**한다. 연합 전용 토큰을 따로 둔다.
- 스토어는 기존 `backends-store.js` 패턴을 따른다 (원자적 쓰기 + 인메모리 캐시).

### 연합 토큰 수신 측

원격 인스턴스는 자신에게 들어오는 연합 요청을 검증할 토큰이 필요하다.
`data/user/instances.json` 에 `inboundTokens: { "mac": "<토큰>" }` 을 둔다.
`Authorization: Bearer <토큰>` + `X-Claw-Origin: mac` 조합으로 검증한다.
둘 중 하나라도 안 맞으면 401. **기존 `auth.js` 미들웨어와 별개의 검증 경로**다
(UI 토큰으로는 연합 엔드포인트에 못 들어온다).

---

## 2. 에이전트 `host` 필드

`config.json` 의 각 에이전트에 선택 필드 `host` 를 추가한다.

- 없거나 `selfId` 와 같으면 → 기존과 100% 동일한 로컬 경로. **기본 동작은 변하지 않는다.**
- `instances` 에 있는 id 면 → 원격 위임.
- 모르는 값이면 → 위임 실패로 처리하고 리드에게 사유를 회신 (조용히 로컬 폴백 금지).

`sync-agents.mjs` 는 `host` 를 **덮어쓰지 않는다** (`workingDir` 처럼 기계별 값이다).

---

## 3. API

### origin → remote

```
POST {baseUrl}/api/federation/delegate
Authorization: Bearer <instances[remote].token>
X-Claw-Origin: <selfId>

{
  "delegationId": "<origin 이 발급한 위임 id>",
  "agent": "cw_server",
  "task": "…200자 이내…",
  "tier": "middle",
  "originLabel": "cw_planner @ mac",
  "callbackUrl": "https://subinggrae.cc/api/federation/result"
}
```

응답 (즉시, 워커 완료를 기다리지 않음):

```json
{ "accepted": true, "remoteSessionId": "sess_…", "remoteInstance": "win" }
```

거절 시 `4xx` + `{ "accepted": false, "error": "unknown_agent" }`.
거절 사유는 `unknown_agent` / `no_capacity` / `unauthorized` / `disabled` 를 구분한다.

### remote → origin (콜백)

```
POST {callbackUrl}
Authorization: Bearer <inboundTokens[origin] 에 대응하는 토큰>
X-Claw-Origin: <remote selfId>

{
  "delegationId": "…",
  "status": "completed" | "failed" | "abandoned",
  "result": "워커 최종 응답 텍스트",
  "remoteSessionId": "sess_…",
  "escalate": null
}
```

콜백은 **최대 3회 재시도**(5s / 30s / 120s). 3회 모두 실패하면 remote 쪽 로그에 남기고
포기한다 — origin 은 기존 `sweepStalledDelegations` 타임아웃으로 회수한다.

### 관리

```
GET    /api/instances            → 목록 + 마지막 헬스
POST   /api/instances            → 등록
PATCH  /api/instances/:id        → 수정 (enabled 토글 포함)
DELETE /api/instances/:id
POST   /api/instances/:id/health → 즉시 헬스체크 (GET {baseUrl}/api/health 호출)
```

관리 API 는 기존 UI 인증(`auth.js`)을 그대로 쓴다.

---

## 4. 위임 경로 분기

`server/routes/chat/delegation.js` 의 `executeDelegation()` (L271) 한 군데만 분기한다.

```
resolveAgentId → 에이전트 조회
  ├ host 가 로컬 → 기존 코드 그대로 (worker-pool 스폰)
  └ host 가 원격 →
      1. instances 레지스트리 조회, enabled·health 확인
      2. delegation-tracker 에 로컬과 동일하게 위임 레코드 생성
         (kind: 'remote', remoteInstance, remoteSessionId)
      3. POST /api/federation/delegate
      4. 실패 시 → 즉시 리드에게 실패 회신 (로컬 폴백 금지)
      5. 성공 시 → 콜백 대기 (pending)
```

**회신 처리는 로컬 위임과 같은 함수를 탄다.** 콜백 수신부는 결과 텍스트를 받아
기존 "워커 완료 → origin 세션에 보고 턴 열기" 경로에 그대로 넘긴다. 별도 UI 경로를 새로
만들지 않는다 — 리드 입장에서 로컬 워커와 구분되지 않아야 한다(뱃지 표기만 다름).

`sweepStalledDelegations` 는 원격 위임도 동일하게 회수한다. 다만 타임아웃은 로컬보다
길게 잡는다(네트워크·원격 큐 대기 포함).

---

## 5. 제약 (스펙에 명시)

- **파일은 공유되지 않는다.** 머신 간에는 파일 임대가 걸리지 않는다. 원격 위임 task 에는
  "커밋·푸시로만 결과를 전달" 규칙이 자동 주입되어야 한다 (`message-sender.js` 의
  `buildTierGuide` 옆에 `buildHostGuide`).
- **버전 스큐.** 윈도우는 현재 v1.17.75 로 연합 엔드포인트가 없다. origin 은 헬스체크의
  `version` 을 보고 연합 미지원 인스턴스로 판정되면 위임을 거절한다(명확한 에러로).
- **세션 이력은 각 기계 로컬.** 원격 세션 로그는 origin UI 에서 보이지 않는다.
  MVP 는 `remoteSessionId` + 원격 인스턴스 링크만 남긴다.

---

## 6. 성공 판정 (이 숫자로 검수한다)

1. `GET /api/instances` → 200, 등록한 인스턴스가 배열에 1개 이상.
2. `POST /api/instances/:id/health` → 원격 `/api/health` 의 `version` 이 응답에 담긴다.
3. **루프백 연합 테스트**: `selfPublicUrl` 을 자기 자신으로 두고 인스턴스 `self` 를 등록,
   `host: "self"` 인 에이전트에 위임 → 원격 경로를 타고 세션이 뜨고, 콜백이 돌아와
   origin 세션에 보고 턴이 **1회** 열린다. (윈도우 업그레이드 전에도 검증 가능해야 한다)
4. `host` 없는 기존 에이전트 위임의 동작이 **변하지 않는다** — 기존 테스트 전부 통과.
5. 연합 엔드포인트에 UI 토큰(`930214`)으로 접근 → **401**.
6. 원격이 죽은 상태에서 위임 → 리드에게 5초 이내 실패 회신(무한 pending 금지).

3번(루프백)이 핵심이다. 윈도우 기계 없이도 전 경로가 검증되어야 한다.
