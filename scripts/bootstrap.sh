#!/usr/bin/env bash
# claw-web 원라이너 설치 — clone/pull 후 install.sh 를 실행한다.
#
#   curl -fsSL https://raw.githubusercontent.com/projovermind/claw-web/main/scripts/bootstrap.sh | bash
#
# 완전 무인(프롬프트 0개)으로 돌리려면 CLAW_YES=1 을 앞에 붙인다:
#
#   curl -fsSL .../bootstrap.sh | CLAW_YES=1 CLAW_TOKEN=123456 bash
#
# 환경변수
#   CLAW_WEB_DIR   설치 위치 (기본: ~/claw-web)
#   CLAW_BRANCH    체크아웃할 브랜치 (기본: main)
#   CLAW_YES=1     무인 모드 — install.sh 의 프롬프트를 전부 스킵
#   그 외 CLAW_TOKEN / CLAW_API_KEY / CLAW_WORKDIR / CLAW_NGROK_DOMAIN 은
#   install.sh 로 그대로 전달된다 (install.sh --help 참고).
set -euo pipefail

REPO_URL="${CLAW_REPO_URL:-https://github.com/projovermind/claw-web.git}"
TARGET="${CLAW_WEB_DIR:-$HOME/claw-web}"
BRANCH="${CLAW_BRANCH:-main}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
step() { printf '\n%b▸ %s%b\n' "$CYAN" "$*" "$NC"; }
ok()   { printf '%b  ✓ %s%b\n' "$GREEN" "$*" "$NC"; }
warn() { printf '%b  ! %s%b\n' "$YELLOW" "$*" "$NC"; }
die()  { printf '%b  ✗ %s%b\n' "$RED" "$*" "$NC" >&2; exit 1; }

printf '\n🦞 %bClaw Web bootstrap%b\n' "$CYAN" "$NC"
printf '%b   설치 위치: %s%b\n' "$DIM" "$TARGET" "$NC"

# ─── git 확인 ─────────────────────────────────
step "git 확인"
if ! command -v git &>/dev/null; then
  if [ "$(uname)" = "Darwin" ]; then
    die "git 이 없습니다. Xcode Command Line Tools 를 설치하세요: xcode-select --install"
  elif command -v apt-get &>/dev/null; then
    warn "git 설치 중 (sudo 필요)"
    sudo apt-get update -qq && sudo apt-get install -y -qq git || die "git 설치 실패"
  else
    die "git 이 없습니다. 패키지 매니저로 먼저 설치하세요."
  fi
fi
ok "$(git --version)"

# ─── clone 또는 pull ──────────────────────────
if [ -d "$TARGET/.git" ]; then
  step "기존 설치 갱신"
  cd "$TARGET"
  git fetch origin "$BRANCH" --quiet || die "git fetch 실패 — 네트워크/인증 확인"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    warn "커밋 안 된 로컬 수정이 있습니다 — 건드리지 않고 그대로 둡니다"
    git status --short --untracked-files=no | head -10
  fi
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ]; then
    ok "이미 최신 ($(git rev-parse --short HEAD))"
  else
    git merge --ff-only "origin/$BRANCH" \
      || die "fast-forward 불가 — 로컬 커밋이 갈라졌습니다. $TARGET 에서 수동 확인 필요"
    ok "$(git rev-parse --short HEAD)"
  fi
else
  step "clone"
  [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ] \
    && die "$TARGET 이 비어있지 않은데 git 레포가 아닙니다. CLAW_WEB_DIR 로 다른 경로를 지정하세요."
  mkdir -p "$(dirname "$TARGET")"
  git clone --branch "$BRANCH" "$REPO_URL" "$TARGET" --quiet || die "clone 실패: $REPO_URL"
  cd "$TARGET"
  ok "$TARGET ($(git rev-parse --short HEAD))"
fi

# ─── install.sh 실행 ──────────────────────────
step "install.sh 실행"
[ -f "$TARGET/install.sh" ] || die "install.sh 를 찾을 수 없습니다: $TARGET"
chmod +x "$TARGET/install.sh" 2>/dev/null || true

# curl | bash 로 들어오면 stdin 이 스크립트 본문이다. install.sh 는 프롬프트를
# /dev/tty 에서 읽으므로, stdin 은 /dev/null 로 닫아 스크립트 잔여물이 흘러들지 않게 한다.
exec bash "$TARGET/install.sh" "$@" < /dev/null
