# 스킬 토큰 뱃지 + alwaysOn 가시화

## 배경
스킬 markdown 본문이 매 턴 system prompt 에 풀주입되면 한 스킬당 수천~수만 토큰.
`server/lib/skill-injector.js` 가 이미 lazy 로직(alwaysOn / triggers) 을 갖고 있으나, 사용자는 어느 스킬이 무거운지 가시적으로 모름 → alwaysOn 정리 동기 부족.

## 개선 대상

### A. 토큰 추정 유틸
**위치**: `server/lib/skill-tokens.js` (신규)
- 단순 추정: `chars / 4` (영어) + 한글은 `chars / 1.5` 가중치 → ChatGPT/Claude tokenizer 근사
- 정확한 측정 원하면 `tiktoken` 의존성 — 무거우니 단순 추정으로 충분
- API: `estimateTokens(text: string): number`

### B. 스킬 store 응답에 토큰 메타 포함
**위치**: `server/routes/skills.js` (또는 skills 라우트 — 확인 필요), `server/lib/skills-store.js`
- GET `/api/skills` 응답에 각 스킬당 `tokenEstimate: number` 추가
- 본문 변경 시(PUT/PATCH) 자동 재계산
- store 레벨 캐시 — 매 GET 재계산하지 않음

### C. 클라이언트 뱃지 표시
**위치**: `client/src/pages/SkillsPage.tsx`, `client/src/components/skills/SkillDetail.tsx`, `client/src/components/common/SkillPicker.tsx`
- 각 스킬 행에 "≈2,341 tok" 뱃지
- > 2000 토큰 + alwaysOn=true 인 경우 경고 색상 (주황/빨강)
- Tooltip: "매 턴 풀 주입됨. triggers 설정으로 lazy 전환 권장"

### D. 에이전트별 합계
**위치**: 에이전트 편집 화면 (확인 필요 — `client/src/pages/AgentDetailPage.tsx` 등)
- "이 에이전트의 활성 스킬 합계 ≈ N tok" 헤더 표시
- 5000+ 시 경고

### E. (옵션) 컨텍스트 모드 토글 자동 추천
- 합계 > 10000 + alwaysOn 우세 → "lazy 모드 일괄 전환" 버튼
- 사용자가 클릭하면 alwaysOn=false + triggers=[] 비어있는 스킬은 alwaysOn 유지(하위호환)

## 구현 단계
1. A — 단순 토큰 추정 유틸 (몇 줄)
2. B — store + route 응답 확장
3. C — SkillsPage / SkillDetail / SkillPicker 뱃지 (병렬 가능)
4. D — 에이전트 화면 합계
5. E — 일괄 전환 (마지막)

## 검증
- 토큰 추정치를 실제 Claude API tokenizer 로 샘플 검증 (몇 개 스킬 수동 확인)
- alwaysOn=false 로 전환 후 평소 응답 정상 동작 확인 (skill-injector 가 triggers 매칭 시 풀 주입)

## 위험
- 토큰 추정 부정확성 — "≈" 표기로 명확화
- 경고 색상 남발 시 잡음 → 임계값 신중히 (2000+ 만 경고)
- 기존 스킬은 모두 alwaysOn 묵시적 → 갑자기 경고가 많이 뜰 수 있음, 점진적 안내 메시지 필요
