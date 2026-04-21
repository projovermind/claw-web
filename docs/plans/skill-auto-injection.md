# 스킬 자동 주입 (Lazy Skill Injection)

## 목적
에이전트에 여러 스킬이 할당돼 있을 때 **매 턴마다 전체 본문을 system prompt에 주입**하면 토큰 낭비가 심함.
→ `alwaysOn`(상시) 플래그와 `triggers[]`(키워드 매칭)로 **필요할 때만 본문 주입**, 나머지는 메타(이름+설명)만 노출.

## 판정 규칙 (`server/lib/skill-injector.js`)

| 조건 | 처리 |
|---|---|
| `alwaysOn === true` | 본문 유지 (풀 주입) |
| `alwaysOn == null` AND `triggers` 없음 | 본문 유지 (하위호환 — 기존 스킬은 alwaysOn 취급) |
| `triggers[]` 중 하나가 userMessage 부분 일치 (case-insensitive) | 본문 유지 |
| 위 모두 해당 안 됨 | `content: ''` 로 리셋 → 러너가 name+description 헤더만 렌더 |

## 통합 지점
- `server/lib/skills-store.js:55-64` — 스킬 스키마: `triggers[]`, `alwaysOn` (기본값 `true`) 저장.
- `server/routes/chat/utils.js:34-43` — `resolveSkills()` 가 user + system 스킬을 통합 해석.
- `server/routes/chat/utils.js:126` — `resolveAgent()` 가 프로젝트 기본 스킬 + 에이전트 스킬 병합 후 `agent.skills` 채움.
- `server/routes/chat/message-sender.js:3` — `buildSkillContext` import.
- `server/routes/chat/message-sender.js:56-58` — 매 턴 `agent.skills = buildSkillContext(agent.skills, message)` 적용. 빈 배열이면 스킵.

## 특성
- **매 턴 재계산** — 같은 세션에서도 메시지마다 triggers 매칭이 다시 돌아 적절한 스킬만 풀 로드.
- **비파괴** — 원본 `skills` 배열은 mutation 없이 map으로 새 배열 생성 (`{ ...sk, content: '' }`).
- **하위호환** — 기존 스킬은 `alwaysOn`/`triggers` 필드 없어도 풀 주입 유지.
- **에러 격리** — try/catch로 감싸 실패 시 원본 반환 (로그만 debug).

## 운영 가이드
- 자주 쓰는 스킬 (코딩 공통 룰, 토큰 효율화, 질문 임계값 등) → `alwaysOn: true`
- 특정 상황용 스킬 (릴리즈 체크리스트, DB 마이그레이션 룰 등) → `alwaysOn: false` + `triggers: ['release','배포','마이그레이션']`

## 후속 고려 (미구현)
- 클라이언트 스킬 편집 UI 에 `alwaysOn` 토글 + `triggers` 입력 필드 추가 여부 확인 필요.
- triggers 매칭을 단순 substring이 아닌 토큰 단위 매칭으로 확장 고려.
- 메타-only 주입 결과의 실제 토큰 절감치 측정 (로그 debug 수준이라 운영 통계 없음).
