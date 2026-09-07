# 기기 간 에이전트 공유

에이전트 정의는 `name`, `systemPrompt`, `allowedTools` 처럼 **기계와 무관한 값이 대부분**이다.
딱 하나 `workingDir` 만 절대경로라 다른 기계로 옮기면 깨진다.
`scripts/sync-agents.mjs` 는 그 한 필드만 번역해서 원본 인스턴스의 에이전트를 그대로 당겨온다.

원본(맥) → 사본(윈도우) **단방향**이다. 사본에서 고친 내용은 다음 동기화 때 덮어써진다.

## 설정

사본 쪽 기계에서 `data/private/agent-sync.json` 을 만든다 (토큰이 들어가므로 private —
`data/private/` 는 `.gitignore` 처리돼 있다):

```json
{
  "source": "https://subinggrae.cc",
  "token": "<원본 인스턴스의 인증 토큰>",
  "pathMap": {
    "/Volumes/Core/Vault/hivemind": "/home/user/vault",
    "/Volumes/Core/claw-web": "/home/user/claw-web"
  },
  "onUnmapped": "skip"
}
```

| 키 | 설명 |
|---|---|
| `source` | 원본 claw-web 의 주소 |
| `token` | 원본의 `Authorization: Bearer` 토큰 |
| `pathMap` | `workingDir` 접두사 치환 규칙. 긴 접두사가 우선하고, 경로 경계에서만 끊는다 (`/Volumes/Core` 가 `/Volumes/Core2` 를 먹지 않는다) |
| `onUnmapped` | `pathMap` 에 안 걸리는 `workingDir` 처리 — `skip`(기본, 그 에이전트를 건너뜀) / `clear`(workingDir 를 비움) / `keep`(그대로 둠, 십중팔구 깨진다) |
| `target` | 선택. 기본값은 `web-config.json` 의 `configPath` |

## 실행

```bash
node scripts/sync-agents.mjs --dry-run   # 무엇이 바뀌는지만 출력
node scripts/sync-agents.mjs             # 실제 반영
```

`config-store` 가 chokidar 로 `configPath` 를 감시하므로 **재시작이 필요 없다.**

출력 예:

```
  ✓ 원본 에이전트 58개
  ✓ 반영 56개
  ✓ 로컬 전용 유지 1개: win-only
  ⚠ pathMap 에 없는 경로라 건너뜀 2개:
      pg_home (/Volumes/Core/playground/)
```

## 동작 규칙

- **로컬 전용 에이전트는 보존된다.** 원본에 없는 id 는 그대로 둔다 — 사본 기계에서만 쓰는
  에이전트를 만들어도 동기화 때 사라지지 않는다.
- **`channels` 같은 다른 최상위 키도 보존된다.** `agents` 만 병합한다.
- 쓰기 전에 `*.bak-sync-<타임스탬프>` 로 백업하고, 임시 파일에 쓴 뒤 rename 한다
  (반쯤 쓰인 JSON 을 chokidar 가 물어서 설정이 날아가는 걸 막는다).

## 주의 — 공유되는 건 정의뿐이다

| 항목 | 공유 |
|---|---|
| 에이전트 정의 (프롬프트·도구·모델) | ✅ 이 스크립트로 |
| 실제 소스 코드 (`workingDir` 안의 파일) | ❌ 각 기계에서 `git clone` |
| 세션 / 대화 이력 | ❌ Claude CLI 가 기계 로컬에 저장 |
| Claude 계정 로그인 | ❌ 기계별 |

즉 에이전트를 동기화해도 `pathMap` 의 대상 경로에 **소스가 실제로 있어야** 일을 한다.
프로젝트를 쪼개서 두 기계가 같은 코드를 동시에 고치면 커밋 안 된 WIP 끼리 충돌하므로,
**프로젝트 단위로 담당 기계를 나누는** 편이 낫다.
