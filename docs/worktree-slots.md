# 동시 슬롯별 git worktree 격리 — 설계안 + 1차 구현

작성: 2026-09-15 (cw_server) · 상태: **기본값 off 로 머지 가능. 켜는 판단은 리드/사용자**

## 문제

`agent.maxConcurrent` (v1.17.63) 를 1 초과로 올리면 같은 에이전트의 워커 둘이
**같은 `workingDir` 을 동시에 편집**한다. 한쪽 Edit 가 다른 쪽 변경을 덮어쓰고,
`git status` 에는 두 작업의 diff 가 섞여 누가 무엇을 바꿨는지 복원할 수 없다.
그래서 지금까지 상향 대상은 읽기 전용 에이전트뿐이었고, `snm_lead` 팬인 28%(85건)
같은 병목을 풀 수 없었다.

## 설계

### 1. 슬롯 = cwd

에이전트별로 `maxConcurrent` 개의 슬롯을 두고, 슬롯마다 cwd 를 하나씩 붙인다.

```
slot 0 → 원본 workingDir              (worktreeIncludePrimary=true, 기본)
slot N → <worktreeRoot>/<agentId>-slotN   (git worktree add --detach)
```

- **slot 0 을 원본으로 두는 이유**: 워커 한 명은 지금처럼 공유 트리에서 일한다 →
  변경이 사람/리드 세션에 바로 보이고, 기존 워크플로(리드가 공유 트리에서 커밋)가
  그대로 유지된다. `worktreeIncludePrimary: false` 로 뒤집으면 모든 워커가 worktree 로
  빠지고 공유 트리는 사람 전용이 된다 — 안전하지만 산출물 회수 절차가 반드시 필요하다.
- worktree 는 **detached HEAD** (`--detach`) 로 만든다. 같은 브랜치를 두 트리에
  체크아웃하는 것은 git 이 금지하고, 슬롯마다 브랜치를 만들면 브랜치 쓰레기가 쌓인다.
- 위치는 기본 `~/.claw-web/worktrees/`. **레포 안에 두면 안 된다** — main 트리의
  glob(vitest 테스트 탐색, 빌드 입력, 에이전트의 Grep)이 슬롯 사본까지 집어삼킨다.

### 2. 리스는 슬롯이 아니라 "세션" 에 붙는다

워커 세션은 재사용되고(v1.17.65 worker-pool) 다음 턴은 `--resume` 으로 붙는다.
Claude CLI 세션 파일 경로는 **cwd 문자열을 인코딩**해서 만들어지므로
(`<configDir>/projects/-Volumes-Core-claw-web/<id>.jsonl`), 같은 세션에 다른 경로를
주면 resume 대상을 못 찾아 콜드스타트가 된다 = 재사용으로 얻은 이득이 그대로 사라진다.

그래서:
- 같은 세션이 다시 요청하면 **항상 같은 경로**를 돌려준다.
- 프로세스 재시작으로 리스 맵이 비면, 세션에 기록된 경로(`session.worktreePath`)를
  `preferred` 로 넘겨 **그 경로를 되찾는다**.
- 워커 cwd 는 `session.worktreePath` 에 박아 두고, `startRunner` 가 러너 기동 전에
  `agent.workingDir` 을 덮어쓴다 (resume 파일 탐색보다 **먼저**).

### 3. 회수(steal)

`maxConcurrent` 는 동시 실행 수만 제한하므로, 끝났지만 재사용 풀에 남은 유휴 세션이
슬롯을 쥔 채 누적될 수 있다. 빈 슬롯이 없으면 **유휴 홀더**(러너 없음 + 진행 중 위임
없음)의 슬롯을 회수한다. 활성 홀더의 슬롯은 절대 건드리지 않는다 — 지키려는 불변식은
하나다: **동시에 도는 두 세션이 같은 디렉토리를 쓰지 않는다.**

회수된 세션은 `forgetWorkerSession` 으로 재사용 후보에서 빼낸다. cwd 가 사라진 세션을
resume 하면 CLI 가 조용히 fresh 세션으로 떨어져 "페르소나 없는 에이전트" 가 된다.

### 4. 해제 시 산출물 보존

worktree 를 지우기 전에 `git add -A` → `git diff --binary --cached <baseSha>` 로
**패치를 뽑아** `<worktreeRoot>/_patches/<sessionId>-<ts>.patch` 에 남긴다.
detached HEAD 에 커밋된 것도 baseSha 기준 diff 에 잡힌다. 링크된 디렉토리
(`node_modules`)는 pathspec 으로 제외한다.

```bash
git -C /Volumes/Core/claw-web apply ~/.claw-web/worktrees/_patches/sess_xxx-....patch
```

패치는 자동으로 적용하지 **않는다**. 자동 머지는 조용한 충돌 손실을 만든다.

### 5. node_modules

worktree 는 tracked 파일만 체크아웃한다 → `node_modules` 가 없어 워커가
`npm run build` / `npx vitest` 를 돌릴 수 없다. `chat.worktreeLinks`
(기본 `['node_modules']`) 에 적힌 경로를 primary 에서 symlink 로 끌어온다.

## 구현 범위 (이번 작업)

| 파일 | 내용 |
|---|---|
| `server/routes/chat/worktree-pool.js` | 신설 — lease/release/steal/patch/link 전부 |
| `server/routes/chat/index.js` | `createWorktreePool` 배선 (delegation 보다 앞) |
| `server/routes/chat/delegation.js` | 워커 세션 생성 후 `leaseWorktree` → 세션에 cwd 기록 / abandon 시 `releaseWorktree` |
| `server/routes/chat/message-sender.js` | `startRunner` 에서 `session.worktreePath` → `agent.workingDir` 오버라이드 |
| `server/lib/web-config.js` | `chat.worktreeIsolation`(기본 **false**) 외 3개 기본값 |
| `tests/delegation-worktree.test.js` | 신설 17케이스 (실제 git 레포를 tmp 에 만들어 검증) |

기본값 off 이므로 **켜지 않는 한 동작은 한 줄도 바뀌지 않는다.**
`maxConcurrent <= 1` 이거나 workingDir 이 git 레포가 아니면 격리 자체를 건너뛴다.

## 켜는 절차

```bash
# data/user/web-config.json (또는 운영 config)
"chat": { "worktreeIsolation": true }
# 그 다음 대상 에이전트만 maxConcurrent 2~3 으로
```

첫 대상 추천: 위임 팬인이 큰 쓰기 에이전트 1명(`snm_lead` 계열)만 2로.
확인할 것 — `worktree: slot leased` 로그, 워커 두 명의 cwd 가 다른지,
완료 후 `_patches/` 에 예상치 못한 패치가 쌓이지 않는지.

## 남은 한계 (합의 필요)

1. **산출물 회수가 수동이다.** worktree 에서 일한 워커의 변경은 공유 트리에 보이지
   않는다. 리드가 `session.worktreePath` 를 읽거나 패치를 적용해야 한다.
   → 다음 단계 후보: 워커 보고(`<report>`)에 `worktreePath` 와 `git diff --stat` 를
   자동 첨부. (프롬프트/보고 포맷 변경이라 이번 범위에서 제외)
2. **slot 0 은 여전히 공유 트리다.** 같은 트리를 쓰는 *다른* 에이전트나 사람 세션과는
   충돌할 수 있다. 완전 격리는 `worktreeIncludePrimary: false` + 1번 해결이 선행돼야 한다.
3. **완료 시 리스를 놓지 않는다**(재사용 대비 sticky). worktree 디렉토리는
   에이전트당 최대 `maxConcurrent - 1` 개로 유지되지만, 세션이 삭제/보관될 때 놓는
   훅은 아직 없다. 유휴 회수로 실질적인 누수는 없다.
4. **다중 인스턴스 안전성 없음.** 리스는 프로세스 메모리에 있다. claw-web 을 두 개
   띄워 같은 레포를 쓰면 같은 슬롯 디렉토리를 두 인스턴스가 잡을 수 있다.
5. UI 문구("같은 워킹트리를 쓰는 에이전트는 1 권장")는 그대로 뒀다. 격리를 켜고 나면
   조건부 문구로 바꿔야 한다.
