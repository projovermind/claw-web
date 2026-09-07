#!/usr/bin/env bash
# 윈도우(WSL) claw-web 을 최신 상태로 한 번에 맞춘다.
#
#   curl -fsSL https://raw.githubusercontent.com/projovermind/claw-web/main/scripts/win-bootstrap.sh | bash
#
# git pull 이 막히는 상황(푸시 전에 손으로 받아둔 파일이 untracked 로 남아 merge 거부)까지
# 스스로 풀고, 의존성·빌드·재시작·자동업데이트 타이머까지 세운다. 여러 번 돌려도 안전하다.
set -uo pipefail

REPO="${CLAW_WEB_DIR:-$HOME/claw-web}"
[ -f "$PWD/package.json" ] && grep -q '"claw-web"' "$PWD/package.json" 2>/dev/null && REPO="$PWD"

step() { printf '\n\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$REPO/.git" ] || die "레포를 찾을 수 없습니다: $REPO  (CLAW_WEB_DIR 로 지정하세요)"
cd "$REPO" || die "cd 실패: $REPO"
echo "claw-web: $REPO"

step "원격 확인"
git fetch origin main --quiet || die "git fetch 실패 — 네트워크/인증을 확인하세요"
BEFORE=$(git rev-parse HEAD)
ok "$(git rev-parse --short HEAD) → $(git rev-parse --short origin/main)"

step "merge 를 막는 파일 정리"
# 추적 안 되는 파일이 원격에도 같은 경로로 들어오면 git 이 pull 을 통째로 거부한다.
# 원격과 내용이 같으면 지우고, 다르면 타임스탬프를 붙여 남긴다 (작업물은 절대 안 날린다).
CLEANED=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  git cat-file -e "origin/main:$f" 2>/dev/null || continue
  if git show "origin/main:$f" 2>/dev/null | cmp -s - "$f"; then
    rm -f "$f"; ok "$f — 원격과 동일, 삭제"
  else
    mv "$f" "$f.local-$(date '+%Y%m%d-%H%M%S').bak"; warn "$f → *.local-*.bak 로 보관"
  fi
  CLEANED=$((CLEANED + 1))
done < <(git ls-files --others --exclude-standard)
[ "$CLEANED" = 0 ] && ok "정리할 것 없음"

step "pull"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  warn "커밋 안 된 로컬 수정이 있습니다 — 건드리지 않고 그대로 둡니다"
  git status --short --untracked-files=no | head -10
fi
if [ "$BEFORE" = "$(git rev-parse origin/main)" ]; then
  ok "이미 최신"
else
  git merge --ff-only origin/main || die "fast-forward 불가 — 로컬 커밋이 갈라졌습니다. 수동 확인 필요"
  ok "$(git rev-parse --short HEAD)"
fi

step "의존성"
# NODE_ENV=production 이어도 빌드 도구가 필요하므로 --include=dev 를 명시한다
npm install --include=dev --no-audit --no-fund >/tmp/claw-npm.log 2>&1 \
  || { tail -20 /tmp/claw-npm.log; die "npm install 실패 (전체 로그: /tmp/claw-npm.log)"; }
npm --prefix client install --include=dev --no-audit --no-fund >>/tmp/claw-npm.log 2>&1 \
  || { tail -20 /tmp/claw-npm.log; die "client npm install 실패"; }
ok "설치 완료"

step "빌드"
npm run build >/tmp/claw-build.log 2>&1 || { tail -25 /tmp/claw-build.log; die "빌드 실패"; }
ok "$(ls client/dist/assets/*.css 2>/dev/null | head -1 | xargs -r basename)"
[ -f client/dist/fonts/PretendardVariable.woff2 ] && ok "웹폰트 배치됨" || warn "웹폰트가 없습니다 (구버전?)"

step "서비스 재시작"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if systemctl --user is-enabled --quiet claw-web 2>/dev/null; then
  systemctl --user restart claw-web && ok "claw-web 재시작"
  sleep 3
else
  warn "systemd 서비스가 아닙니다 — 직접 재시작하세요 (scripts/claw-web-wsl-setup.ps1 미실행?)"
fi

step "자동 업데이트 타이머"
if [ -f scripts/self-update.sh ]; then
  bash scripts/self-update.sh --install-timer || warn "타이머 등록 실패 (systemd 미활성?)"
else
  warn "scripts/self-update.sh 없음"
fi

step "헬스체크"
PORT=$(python3 -c "import json;print(json.load(open('data/private/web-config.json')).get('port',3838))" 2>/dev/null || echo 3838)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://localhost:$PORT/api/health" || echo 000)
case "$CODE" in
  200|401) ok "HTTP $CODE — 정상 (localhost:$PORT)" ;;
  *)       die "HTTP $CODE — 서버가 응답하지 않습니다. systemctl --user status claw-web" ;;
esac

VER=$(node -p "require('./package.json').version" 2>/dev/null || echo '?')
printf '\n\033[32m완료 — v%s (%s)\033[0m\n' "$VER" "$(git rev-parse --short HEAD)"
echo "이후로는 30분마다 origin/main 을 알아서 따라갑니다. 워커가 돌고 있으면 그 판은 건너뜁니다."
