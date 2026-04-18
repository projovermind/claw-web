#!/bin/zsh
# Wrapper to start Claw Web / hivemind-web server from launchd.
#
# 개선 (2026-04-18): 폴더 이름 독립적 동작
# - 이전: /Volumes/Core/hivemind-web 하드코딩 → 폴더 이름 바꾸면 실패
# - 지금: 여러 후보 경로에서 server/index.js 탐색, 첫 번째로 발견된 것 실행
# - $CLAW_WEB_ROOT 환경변수로 오버라이드 가능

setopt NULL_GLOB 2>/dev/null || true

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Source shell env (best-effort)
[ -f "$HOME/.zshrc" ]    && source "$HOME/.zshrc"    2>/dev/null || true
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null || true

# 후보 경로 (우선순위 순)
# 1) 환경변수 오버라이드
# 2) /Volumes/Core/hivemind-web — 기존 운영 환경 (node_modules/sessions.json 가짐)
# 3) /Volumes/Core/claw-web     — git repo 에서 직접 운영하고 싶을 때
# 4) /usr/local/lib/claw-web    — pkg 설치 경로
# 5) $HOME/{claw-web,hivemind-web}
CANDIDATES=(
  "${CLAW_WEB_ROOT:-}"
  "/Volumes/Core/hivemind-web"
  "/Volumes/Core/claw-web"
  "/Volumes/Core/Claw-Web"
  "/usr/local/lib/claw-web"
  "$HOME/claw-web"
  "$HOME/hivemind-web"
)

# exFAT 외장 마운트 대기 (부팅 직후 몇 초 늦을 수 있음)
REPO_ROOT=""
for i in {1..30}; do
  for p in "${CANDIDATES[@]}"; do
    [ -z "$p" ] && continue
    if [ -f "$p/server/index.js" ]; then
      REPO_ROOT="$p"
      break 2
    fi
  done
  sleep 1
done

if [ -z "$REPO_ROOT" ]; then
  echo "[start.sh] ERROR: server/index.js not found in any candidate path" >&2
  printf "  checked: %s\n" "${CANDIDATES[@]}" >&2
  exit 1
fi

echo "[start.sh] using REPO_ROOT=$REPO_ROOT" >&2
cd "$REPO_ROOT" || exit 1

# node 경로 탐색
NODE_BIN=""
for np in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  if [ -x "$np" ]; then NODE_BIN="$np"; break; fi
done
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"

exec "$NODE_BIN" "$REPO_ROOT/server/index.js"
