#!/usr/bin/env bash
# claw-web 자동 업데이트 — origin/main 을 따라간다 (systemd / launchd 양쪽).
#
#   bash scripts/self-update.sh                # 1회 실행
#   bash scripts/self-update.sh --check        # 확인만, 아무것도 안 바꿈
#   bash scripts/self-update.sh --install-timer  # 5분마다 자동 실행 등록
#
# 두 가지를 본다:
#   1) origin/main 이 앞서 있으면  → pull · 필요하면 install/build
#   2) 떠 있는 프로세스가 디스크보다 낡았으면 → 재시작
# (2) 는 git 업데이트가 없어도 돈다. 손으로 빌드해 둔 변경도 한가해지는 즉시 반영된다.
#
# 재시작은 대화를 끊으므로 **워커가 하나라도 살아 있으면 아무것도 하지 않고** 다음 주기로
# 미룬다. 주기가 5분이라 세션이 끝나면 대체로 5분 안에 알아서 맞춰진다.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || exit 1

LOG_DIR="$REPO_DIR/data/user/logs"
LOG="$LOG_DIR/self-update.log"
TRACKER="$LOG_DIR/running-processes.json"
SERVICE="claw-web"
MAC_LABEL="cc.subinggrae.claw-web"          # 맥 LaunchAgent (서버 본체)
MAC_UPDATE_LABEL="cc.subinggrae.claw-web-update"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

mkdir -p "$LOG_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# ── 타이머 정의 ─────────────────────────────────────────
# 유닛 파일을 쓰고 "changed"/"same" 을 찍는다. 주기를 바꿔도 pull 만으로는
# 유닛 파일이 안 바뀌므로, 아래에서 pull 후 이걸 다시 돌려 자동으로 맞춘다.
write_launchd_plist() {
  local plist="$HOME/Library/LaunchAgents/$MAC_UPDATE_LABEL.plist" tmp node
  mkdir -p "$HOME/Library/LaunchAgents"

  # ⚠️ 레포가 외장 볼륨(/Volumes/...)에 있으면 launchd 가 띄운 /bin/bash 는
  # TCC('이동식 볼륨') 권한이 없어서 스크립트를 읽지 못한다 —
  # 로그 한 줄 없이 exit 78(EX_CONFIG) / 126 으로 죽는다.
  # node 는 claw-web 본체를 돌리느라 이미 권한을 받아뒀고, node 가 띄운 bash 는
  # 그 권한을 물려받는다. 그래서 node 를 한 겹 씌워 부른다.
  node=$(command -v node || echo /usr/bin/env)
  [ "$node" = /usr/bin/env ] && node=/usr/bin/env

  # launchd 자신이 여는 파일이라 stdout/stderr 도 외장 볼륨에 두면 안 된다.
  local llog="$HOME/Library/Logs/claw-web/self-update.launchd.log"
  mkdir -p "$(dirname "$llog")"

  tmp=$(mktemp)
  cat > "$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$MAC_UPDATE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>-e</string>
    <string>require('child_process').execFileSync('/bin/bash',[process.argv[1]],{stdio:'inherit'})</string>
    <string>$REPO_DIR/scripts/self-update.sh</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$llog</string>
  <key>StandardErrorPath</key><string>$llog</string>
</dict>
</plist>
EOF
  if cmp -s "$tmp" "$plist"; then rm -f "$tmp"; echo same; else mv "$tmp" "$plist"; echo changed; fi
}

write_systemd_units() {
  local dir="$HOME/.config/systemd/user" svc tmr t1 t2 changed=0
  mkdir -p "$dir"
  svc="$dir/claw-web-update.service"; tmr="$dir/claw-web-update.timer"
  t1=$(mktemp); t2=$(mktemp)
  cat > "$t1" <<EOF
[Unit]
Description=claw-web self update

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $REPO_DIR/scripts/self-update.sh
EOF
  cat > "$t2" <<'EOF'
[Unit]
Description=claw-web self update (5분마다)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
# 여러 기기가 같은 초에 GitHub 를 때리지 않도록 흩뿌린다
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
EOF
  cmp -s "$t1" "$svc" || changed=1
  cmp -s "$t2" "$tmr" || changed=1
  mv "$t1" "$svc"; mv "$t2" "$tmr"
  [ "$changed" = 1 ] && echo changed || echo same
}

# 이미 타이머가 걸린 기기에서, 유닛 정의가 바뀌었으면 조용히 갱신한다.
# (systemd 는 타이머 유닛 재시작이 지금 돌고 있는 이 서비스를 건드리지 않아 안전하다.
#  launchd 는 bootout 이 자기 자신을 죽이므로 파일만 갱신하고 안내만 남긴다.)
refresh_timer_if_installed() {
  if [ "$(uname -s)" = "Darwin" ]; then
    [ -f "$HOME/Library/LaunchAgents/$MAC_UPDATE_LABEL.plist" ] || return 0
    if [ "$(write_launchd_plist)" = changed ]; then
      log "타이머 정의가 바뀌었습니다 — 적용하려면: bash scripts/self-update.sh --install-timer"
    fi
  else
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    systemctl --user is-enabled --quiet claw-web-update.timer 2>/dev/null || return 0
    if [ "$(write_systemd_units)" = changed ]; then
      systemctl --user daemon-reload
      systemctl --user restart claw-web-update.timer
      log "업데이트 타이머 갱신됨 (주기 변경 반영)"
    fi
  fi
}

# ── 타이머 등록 ─────────────────────────────────────────
if [[ "${1:-}" == "--install-timer" ]]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    write_launchd_plist >/dev/null
    PLIST="$HOME/Library/LaunchAgents/$MAC_UPDATE_LABEL.plist"
    launchctl bootout "gui/$(id -u)/$MAC_UPDATE_LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || { echo "LaunchAgent 등록 실패: $PLIST" >&2; exit 1; }
    echo "등록됨 — $MAC_UPDATE_LABEL (5분 주기). 해제: launchctl bootout gui/$(id -u)/$MAC_UPDATE_LABEL"
    exit 0
  fi

  if ! ps -p 1 -o comm= | grep -q systemd; then
    echo "systemd 도 launchd 도 아닙니다 — 타이머를 등록할 수 없습니다." >&2; exit 1
  fi
  write_systemd_units >/dev/null
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  systemctl --user daemon-reload
  systemctl --user enable --now claw-web-update.timer
  echo "등록됨 — 다음 실행: $(systemctl --user list-timers claw-web-update.timer --no-pager | sed -n 2p)"
  exit 0
fi

# ── 헬퍼 ────────────────────────────────────────────────
web_port() {
  python3 -c "import json;print(json.load(open('data/private/web-config.json')).get('port',3838))" 2>/dev/null || echo 3838
}

# 살아있는 워커 수. 죽은 pid 가 기록에 남아 있어도 세지 않는다.
live_workers() {
  [ -f "$TRACKER" ] || { echo 0; return; }
  python3 -c "
import json,os,sys
try: s=json.load(open('$TRACKER')).get('sessions',{})
except Exception: print(0); sys.exit()
n=0
for v in s.values():
    pid=v.get('pid')
    if not pid: continue
    try: os.kill(pid,0); n+=1
    except OSError: pass
print(n)" 2>/dev/null || echo 0
}

# 떠 있는 프로세스가 보고하는 버전 — 부팅 시점에 읽은 값이라 디스크와 어긋날 수 있다.
running_version() {
  curl -s -m 5 "http://localhost:$(web_port)/api/health" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('version',''))" 2>/dev/null
}
disk_version() {
  python3 -c "import json;print(json.load(open('package.json')).get('version',''))" 2>/dev/null
}

restart_service() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if [ "$(uname -s)" = "Darwin" ]; then
    if launchctl print "gui/$(id -u)/$MAC_LABEL" >/dev/null 2>&1; then
      launchctl kickstart -k "gui/$(id -u)/$MAC_LABEL"
    else
      log "LaunchAgent $MAC_LABEL 이 없어 재시작을 건너뜁니다 (수동 재시작 필요)"; return 1
    fi
  elif systemctl --user is-enabled --quiet "$SERVICE" 2>/dev/null; then
    systemctl --user restart "$SERVICE"
  else
    log "서비스 매니저가 관리하지 않아 재시작을 건너뜁니다 (수동 재시작 필요)"; return 1
  fi

  sleep 3
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://localhost:$(web_port)/api/health" || echo 000)
  if [ "$CODE" = "200" ] || [ "$CODE" = "401" ]; then
    log "완료 — 재시작 후 정상 (HTTP $CODE, v$(running_version))"; return 0
  fi
  log "경고: 재시작했으나 헬스체크 실패 (HTTP $CODE)"
  if [ "$(uname -s)" != "Darwin" ]; then
    systemctl --user status "$SERVICE" --no-pager -l 2>&1 | tail -15 >>"$LOG"
  fi
  return 1
}

# ── 원격 확인 ───────────────────────────────────────────
git fetch origin main --quiet 2>>"$LOG" || { log "git fetch 실패"; exit 1; }
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$CHECK_ONLY" = 1 ]; then
  if [ "$LOCAL" = "$REMOTE" ]; then
    echo "git      : 최신 ($(git rev-parse --short HEAD))"
  else
    echo "git      : $(git rev-list --count HEAD..origin/main) 커밋 뒤처짐"
    git log --oneline HEAD..origin/main | head -20 | sed 's/^/           /'
  fi
  RUN=$(running_version); DISK=$(disk_version)
  if [ -z "$RUN" ]; then
    echo "프로세스 : 응답 없음 (서버가 떠 있지 않습니다)"
  elif [ "$RUN" = "$DISK" ]; then
    echo "프로세스 : v$RUN — 디스크와 일치"
  else
    echo "프로세스 : v$RUN / 디스크 v$DISK — 재시작 대기"
  fi
  echo "워커     : $(live_workers)개 실행 중"
  exit 0
fi

# ── 1) git 업데이트 ─────────────────────────────────────
if [ "$LOCAL" != "$REMOTE" ]; then
  log "업데이트 있음: $(git rev-parse --short HEAD) → $(git rev-parse --short origin/main) ($(git rev-list --count HEAD..origin/main) 커밋)"

  # 로컬 수정본이 있으면 손대지 않는다. 남의 작업을 날리느니 업데이트를 포기한다.
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "pull 건너뜀: 커밋 안 된 로컬 변경이 있습니다"
    git status --short --untracked-files=no | head -10 | tee -a "$LOG"
  else
    N=$(live_workers)
    if [ "$N" -gt 0 ]; then
      log "pull 건너뜀: 워커 ${N}개 실행 중 (다음 주기에 재시도)"
      exit 0
    fi

    # 추적 안 되는 파일이 원격에도 같은 경로로 들어오면 merge 가 통째로 거부된다.
    # (푸시 전에 스크립트를 손으로 받아둔 기기에서 실제로 발생) — 비켜놓고 진행한다.
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      git cat-file -e "origin/main:$f" 2>/dev/null || continue
      if git show "origin/main:$f" 2>/dev/null | cmp -s - "$f"; then
        rm -f "$f"; log "충돌 정리: $f (원격과 동일 — 삭제)"
      else
        mv "$f" "$f.local-$(date '+%Y%m%d-%H%M%S').bak"; log "충돌 정리: $f → *.local-*.bak"
      fi
    done < <(git ls-files --others --exclude-standard)

    LOCK_BEFORE=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)
    CLIENT_BEFORE=$(git rev-parse HEAD:client 2>/dev/null || echo none)

    if ! git merge --ff-only origin/main >>"$LOG" 2>&1; then
      log "실패: fast-forward 불가 (로컬 커밋이 갈라졌습니다) — 수동 확인 필요"
      exit 1
    fi
    log "pull 완료: $(git rev-parse --short HEAD)"

    # 이번 pull 에 타이머 주기 변경이 섞여 있을 수 있다 — 유닛 파일까지 따라가게 한다.
    refresh_timer_if_installed

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
  fi
fi

# ── 2) 낡은 프로세스 재시작 ─────────────────────────────
# git 이 최신이어도, 손으로 빌드해 둔 변경 때문에 디스크가 앞서 있을 수 있다.
# 그 경우도 한가해지는 즉시 맞춘다 — 이쪽이 "세션 없으면 알아서 재시작" 이다.
RUN=$(running_version)
DISK=$(disk_version)

if [ -z "$RUN" ]; then
  log "서버가 응답하지 않습니다 — 재시작 판단 보류"
  exit 0
fi
[ "$RUN" = "$DISK" ] && exit 0

N=$(live_workers)
if [ "$N" -gt 0 ]; then
  log "재시작 보류: v$RUN → v$DISK, 워커 ${N}개 실행 중 (다음 주기에 재시도)"
  exit 0
fi

log "재시작: v$RUN → v$DISK (워커 없음)"
restart_service
