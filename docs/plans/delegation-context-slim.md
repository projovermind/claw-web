# 위임 컨텍스트 슬림화 (Delegation Context Slim)

## 배경
`scripts/analyze-tokens.mjs` 실측: ovm_pipeline 등 위임 세션이 메시지당 **40~89만 토큰**.
현재 위임은 부모 세션의 컨텍스트를 직접 전달하지 않지만 — 위임받은 worker 에이전트의 **첫 턴 system prompt**(스킬 + 프로젝트 + 에이전트 시스템 프롬프트)가 매우 무거운 경우가 누적되고, 후속 위임에서 매번 풀로 들어감.

## 가설 검증 (선행)
1. 부모→자식 task 페이로드 크기 측정 → `server/routes/chat/delegation.js:161` `fullTask` 의 길이 로그
2. 자식 첫 턴 system prompt 크기 측정 → `message-sender.js` 의 `--append-system-prompt` payload 길이
3. 결과 보고(`[위임 결과 보고]\n\n결과 요약:\n${summary}`) 의 summary 길이 — `message-sender.js:395` `slice(0, 2000)` (확인됨)

## 개선 대상

### A. 위임 task 페이로드 슬림화
**위치**: `server/routes/chat/delegation.js:158-161`
- 현재: `fullTask = task` (loop 모드면 promise/escalate 안내 추가)
- 개선: 부모 세션 컨텍스트가 task 안에 통째로 박혀 있는 경우 (긴 코드/로그 paste) 자동 감지 → "부모 세션 ${id} 의 최근 N턴 참조" 메타데이터로 치환
- 감지 기준: `task.length > 8000` 또는 base64/긴 stack trace 패턴

### B. 결과 보고 요약 강화
**위치**: `server/routes/chat/message-sender.js:395-403`
- 현재: 응답 첫 2000자 `slice(0, 2000)` 단순 절단
- 개선: 응답 끝부분(보통 결론) 우선 + 코드블록/툴 결과 압축
  - <choices>/<promise> 태그 우선 추출
  - 마지막 N문장 + 첫 200자
  - 길이 한도 1500자로 축소

### C. 자식 system prompt 캐시 활용
**위치**: `server/runners/claude-cli-runner.js`, `--append-system-prompt`
- 첫 턴에 한 번만 풀 주입(이미 그렇게 됨 — message-sender.js:198-213 확인)
- 위임 chain 깊이 측정 → 3단계 이상이면 alwaysOn 스킬 일부 자동 스킵 (옵션)

### D. 진단 로그 추가
- `delegation.js` create 시 `task.length`, `targetSession.id`, depth(부모-자식 chain) 로그
- 새 라우트 `/api/debug/delegation-stats` — 활성 위임의 페이로드 크기 통계

## 구현 단계
1. (선행) 진단 로그 PR — D 만 추가하여 실측치 확인
2. B (요약 알고리즘 강화) — 가장 안전, 즉효
3. A (task 자동 슬림) — 감지 임계값 보수적으로
4. C (chain 깊은 위임 스킬 스킵) — 마지막, 옵션 플래그 뒤

## 검증
- `scripts/analyze-tokens.mjs --session=<위임세션ID>` 으로 before/after 비교
- 위임 chain (planner → cw_router → cw_server) 시나리오 토큰 절감치 측정
- 회귀 테스트: 위임 결과 보고가 여전히 부모에게 도달하는지

## 위험
- B 의 요약 강화로 부모 planner 가 결과 의미를 놓칠 수 있음 → 원본 응답 링크 첨부로 보완
- A 의 task 자동 치환이 실제 필요한 컨텍스트 제거할 위험 → 명시적 opt-in 플래그(`delegate.slim: true`) 권장
