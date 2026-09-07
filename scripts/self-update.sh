#!/usr/bin/env bash
# claw-web 자동 업데이트 — origin/main 을 따라간다 (systemd 기기용).
#
#   bash scripts/self-update.sh                # 1회 실행
#   bash scripts/self-update.sh --check        # 확인만, 아무것도 안 바꿈
#   bash scripts/self-update.sh --install-timer  # 30분마다 자동 실행 등록
#
# 재시작이 대화를 끊기 때문에, 워커가 돌고 있으면 이번 판을 통째로 건너뛰고
# 다음 타이머 때 다시 시도한다. 급할 게 없는 작업이라 미루는 쪽이 항상 옳다.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || exit 1

LOG_DIR="$REPO_DIR/data/user/logs"
LOG="$LOG_DIR/self-update.log"
TRACKER="$LOG_DIR/running-processes.json"
SERVICE="claw-web"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# ── 타이머 등록 ─────────────────────────────────────────
if [[ "${1:-}" == "--install-timer" ]]; then
  if ! ps -p 1 -o comm= | grep -q systemd; then
    echo "systemd 가 아닙니다 — 타이머를 등록할 수 없습니다." >&2; exit 1
  fi
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/claw-web-update.service" <<EOF
[Unit]
Description=claw-web self update

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $REPO_DIR/scripts/self-update.sh
EOF
  cat > "$HOME/.config/systemd/user/claw-web-update.timer" <<'EOF'
[Unit]
Description=claw-web self update (30분마다)

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
# 여러 기기가 같은 초에 GitHub 를 때리지 않도록 흩뿌린다
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  systemctl --user daemon-reload
  systemctl --user enable --now claw-web-update.timer
  echo "등록됨 — 다음 실행: $(systemctl --user list-timers claw-web-update.timer --no-pager | sed -n 2p)"
  exit 0
fi

# ── 원격 확인 ───────────────────────────────────────────
git fetch origin main --quiet 2>>"$LOG" || { log "git fetch 실패"; exit 1; }
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  [ "$CHECK_ONLY" = 1 ] && echo "최신입니다 ($(git rev-parse --short HEAD))"
  exit 0
fi

BEHIND=$(git rev-list --count HEAD..origin/main)
log "업데이트 있음: $(git rev-parse --short HEAD) → $(git rev-parse --short origin/main) ($BEHIND 커밋)"

if [ "$CHECK_ONLY" = 1 ]; then
  git log --oneline HEAD..origin/main | head -20
  exit 0
fi

# ── 안전 점검 ───────────────────────────────────────────
# 1) 로컬 수정본이 있으면 손대지 않는다. 남의 작업을 날리느니 업데이트를 포기한다.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "건너뜀: 커밋 안 된 로컬 변경이 있습니다"
  git status --short --untracked-files=no | head -10 | tee -a "$LOG"
  exit 0
fi

# 2) 워커가 돌고 있으면 재시작이 대화를 끊는다 — 다음 타이머 때 다시 시도
if [ -f "$TRACKER" ]; then
  ACTIVE=$(python3 -c "
import json,os,sys
try: s=json.load(open('$TRACKER')).get('sessions',{})
except Exception: print(0); sys.exit()
n=0
for v in s.values():
    pid=v.get('pid')
    if not pid: continue
    try: os.kill(pid,0); n+=1          # 죽은 pid 는 세지 않는다
    except OSError: pass
print(n)" 2>/dev/null || echo 0)
  if [ "${ACTIVE:-0}" -gt 0 ]; then
    log "건너뜀: 워커 ${ACTIVE}개 실행 중 (다음 주기에 재시도)"
    exit 0
  fi
fi

# ── 적용 ────────────────────────────────────────────────
LOCK_BEFORE=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)
CLIENT_BEFORE=$(git rev-parse HEAD:client 2>/dev/null || echo none)

if ! git merge --ff-only origin/main >>"$LOG" 2>&1; then
  log "실패: fast-forward 불가 (로컬 커밋이 갈라졌습니다) — 수동 확인 필요"
  exit 1
fi
log "pull 완료: $(git rev-parse --short HEAD)"

# 의존성은 lock 이 바뀐 경우에만. NODE_ENV=production 환경에서도 빌드 도구가
# 필요하므로 --include=dev 를 명시한다.
if [ "$LOCK_BEFORE" != "$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)" ]; then
  log "의존성 갱신"
  npm install --include=dev --no-audit --no-fund >>"$LOG" 2>&1 || { log "npm install 실패"; exit 1; }
fi

# client 트리가 바뀐 경우에만 재빌드 (3~4초지만 매번 할 이유는 없다)
if [ "$CLIENT_BEFORE" != "$(git rev-parse HEAD:client 2>/dev/null || echo none)" ]; then
  log "클라이언트 빌드"
  npm --prefix client install --include=dev --no-audit --no-fund >>"$LOG" 2>&1
  npm run build >>"$LOG" 2>&1 || { log "빌드 실패 — 서버는 건드리지 않습니다"; exit 1; }
fi

# ── 재시작 ──────────────────────────────────────────────
# systemd 로 관리되는 기기에서만 재시작한다. 맥(LaunchAgent)에서는 여기 안 걸리고
# 조용히 끝나므로, 세션 안에서 실수로 자기 자신을 죽이는 일이 없다.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if systemctl --user is-enabled --quiet "$SERVICE" 2>/dev/null; then
  systemctl --user restart "$SERVICE"
  sleep 3
  PORT=$(python3 -c "import json;print(json.load(open('data/private/web-config.json')).get('port',3838))" 2>/dev/null || echo 3838)
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://localhost:$PORT/api/health" || echo 000)
  if [ "$CODE" = "200" ] || [ "$CODE" = "401" ]; then
    log "완료 — 재시작 후 정상 (HTTP $CODE)"
  else
    log "경고: 재시작했으나 헬스체크 실패 (HTTP $CODE)"
    systemctl --user status "$SERVICE" --no-pager -l 2>&1 | tail -15 >>"$LOG"
    exit 1
  fi
else
  log "완료 — systemd 서비스가 아니라 재시작은 건너뜀 (수동 재시작 필요)"
fi
