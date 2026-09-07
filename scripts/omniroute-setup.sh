#!/usr/bin/env bash
# OmniRoute 게이트웨이를 깔고, 상주시키고, claw-web 백엔드로 붙이는 것까지 한 번에 한다.
#
#   bash scripts/omniroute-setup.sh              # 루프백에만 열기 (기본)
#   bash scripts/omniroute-setup.sh --lan        # 같은 공유기 안 다른 기기에서도 대시보드 접속
#   bash scripts/omniroute-setup.sh --password X # 대시보드 비밀번호를 직접 지정
#   bash scripts/omniroute-setup.sh --uninstall  # 상주 해제 (설치물·데이터는 남김)
#
# OmniRoute 는 호스팅 API 가 아니라 이 기계에서 직접 돌리는 게이트웨이다. 그래서
# "키를 발급받는" 게 아니라 게이트웨이가 자기 키를 만들어 준다 — 그 왕복까지 여기서 처리한다.
# 몇 번을 돌려도 안전하다. 이미 돼 있는 단계는 건너뛴다.
set -uo pipefail

REPO="${CLAW_WEB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PORT=20128
LABEL="cc.subinggrae.omniroute"
SERVICE="omniroute"
ENVF="$HOME/.omniroute/.env"
LOGDIR="$HOME/Library/Logs/omniroute"
[ "$(uname -s)" = "Darwin" ] || LOGDIR="$REPO/data/user/logs"

OPEN_LAN=0
PASSWORD=""
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --lan) OPEN_LAN=1 ;;
    --password) PASSWORD="${2:-}"; shift ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

api() { # api <method> <path> [json]  → 본문만. 실패해도 스크립트를 죽이지 않는다.
  curl -s -m 30 -X "$1" "http://127.0.0.1:$PORT$2" \
    ${AUTH_COOKIE:+-H "Cookie: $AUTH_COOKIE"} \
    -H 'Content-Type: application/json' ${3:+-d "$3"}
}
jq_get() { python3 -c "import json,sys
try: print(json.load(sys.stdin)$1)
except Exception: print('')" 2>/dev/null; }

# ── claw-web 접속 정보 (하드코딩하지 않고 설정에서 읽는다) ──
web_port()  { python3 -c "import json;print(json.load(open('$REPO/data/private/web-config.json')).get('port',3838))" 2>/dev/null || echo 3838; }
web_token() { python3 -c "import json;print((json.load(open('$REPO/data/private/web-config.json')).get('auth') or {}).get('token') or '')" 2>/dev/null; }

is_up() { curl -s -o /dev/null -m 3 "http://127.0.0.1:$PORT/login" 2>/dev/null; }

wait_up() {
  local i
  for i in $(seq 1 45); do
    is_up && return 0
    /bin/sleep 2
  done
  return 1
}

# ────────────────────────────────────────────────────────────── 해제
if [ "$UNINSTALL" = 1 ]; then
  step "상주 해제"
  if [ "$(uname -s)" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && ok "LaunchAgent 해제" || warn "등록돼 있지 않음"
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
  else
    systemctl --user disable --now "$SERVICE" 2>/dev/null && ok "systemd 유닛 해제" || warn "등록돼 있지 않음"
    rm -f "$HOME/.config/systemd/user/$SERVICE.service"
    systemctl --user daemon-reload 2>/dev/null
  fi
  echo "설치물과 ~/.omniroute 데이터는 남겼습니다. 완전 제거: npm rm -g omniroute && rm -rf ~/.omniroute"
  exit 0
fi

echo "claw-web: $REPO"

# ────────────────────────────────────────────────────────────── 1. 설치
step "omniroute 설치"
if command -v omniroute >/dev/null 2>&1; then
  ok "이미 설치됨 (v$(omniroute --version 2>/dev/null | tr -d '\r' | tail -1))"
else
  # NODE_ENV=production 이어도 전역 설치는 문제없지만 로그가 길어 파일로 뺀다
  npm install -g omniroute --no-audit --no-fund >/tmp/omniroute-install.log 2>&1 \
    || { tail -20 /tmp/omniroute-install.log; die "설치 실패 (전체 로그: /tmp/omniroute-install.log)"; }
  ok "설치 완료"
fi
command -v omniroute >/dev/null 2>&1 || die "omniroute 가 PATH 에 없습니다 (npm 전역 bin 경로를 확인하세요)"

# ────────────────────────────────────────────────────────────── 2. 설정
step "게이트웨이 설정"
mkdir -p "$(dirname "$ENVF")" "$LOGDIR"
touch "$ENVF"
set_env() { # 이미 있으면 덮어쓰고, 없으면 추가
  if grep -q "^$1=" "$ENVF"; then
    python3 - "$ENVF" "$1" "$2" <<'EOF'
import sys
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines()
open(path, 'w').write('\n'.join(
    f'{key}={val}' if l.startswith(key + '=') else l for l in lines) + '\n')
EOF
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENVF"
  fi
}

# /v1/* 는 기본값이 "키 없이 누구나" 다. 여는 것보다 먼저 잠근다.
set_env REQUIRE_API_KEY true
ok "REQUIRE_API_KEY=true — 키 없는 추론 호출 차단"

# 이미 지정돼 있으면 존중한다 (재실행이 사용자의 선택을 되돌리지 않도록)
if grep -q '^OMNIROUTE_SERVER_HOST=' "$ENVF"; then
  ok "바인딩 유지: $(grep '^OMNIROUTE_SERVER_HOST=' "$ENVF" | cut -d= -f2)"
elif [ "$OPEN_LAN" = 1 ]; then
  set_env OMNIROUTE_SERVER_HOST 0.0.0.0
  ok "바인딩: 0.0.0.0 (LAN 개방)"
else
  set_env OMNIROUTE_SERVER_HOST 127.0.0.1
  ok "바인딩: 127.0.0.1 (이 기계에서만)"
fi

# ────────────────────────────────────────────────────────────── 3. 상주
step "상주 등록"
if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v omniroute)</string>
    <string>serve</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/serve.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/serve.err.log</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null || die "plist 문법 오류"
  # 포그라운드로 띄워둔 인스턴스가 있으면 포트가 겹친다
  pkill -f "omniroute serve" 2>/dev/null
  for i in $(seq 1 15); do pgrep -f "omniroute serve" >/dev/null || break; /bin/sleep 1; done
  # bootout 은 비동기다. 해제가 끝나기 전에 bootstrap 하면 "Input/output error" 로 튕긴다.
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  for i in $(seq 1 20); do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
    /bin/sleep 1
  done
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || die "LaunchAgent 등록 실패"
  ok "LaunchAgent $LABEL"
else
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  UNIT="$HOME/.config/systemd/user/$SERVICE.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=OmniRoute AI gateway
After=network.target

[Service]
Type=simple
ExecStart=$(command -v omniroute) serve --port $PORT
Restart=always
RestartSec=5
StandardOutput=append:$LOGDIR/omniroute.log
StandardError=append:$LOGDIR/omniroute.log

[Install]
WantedBy=default.target
EOF
  pkill -f "omniroute serve" 2>/dev/null
  systemctl --user daemon-reload || die "systemd 미활성 (claw-web-wsl-setup.ps1 을 먼저 실행하세요)"
  systemctl --user enable --now "$SERVICE" || die "유닛 기동 실패"
  ok "systemd --user $SERVICE"
fi

wait_up || die "게이트웨이가 응답하지 않습니다 — 로그: $LOGDIR"
ok "게이트웨이 기동 (:$PORT)"

# ────────────────────────────────────────────────────────────── 4. 대시보드 비밀번호
step "대시보드 비밀번호"
AUTH_COOKIE=""
login() { # login <password> → 성공 시 AUTH_COOKIE 설정
  local hdr
  hdr=$(curl -s -D - -o /dev/null -m 15 -X POST "http://127.0.0.1:$PORT/api/auth/login" \
        -H 'Content-Type: application/json' -d "{\"password\":\"$1\"}")
  echo "$hdr" | grep -qi '^HTTP/[0-9.]* 200' || return 1
  AUTH_COOKIE=$(echo "$hdr" | grep -i '^set-cookie: auth_token=' | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//' | tr -d '\r')
  [ -n "$AUTH_COOKIE" ]
}
reset_password() { # 대화형이라 인자를 무시한다 — stdin 으로 두 번 넣어야 먹는다
  printf '%s\n%s\n' "$1" "$1" | omniroute-reset-password >/dev/null 2>&1
}

if [ -n "$PASSWORD" ]; then
  reset_password "$PASSWORD" && ok "지정하신 비밀번호로 설정"
elif login "CHANGEME"; then
  # 초기값 그대로다. LAN 에 열어둔 채로 두면 안 되므로 반드시 바꾼다.
  PASSWORD="omni-$(openssl rand -hex 6)"
  reset_password "$PASSWORD" && ok "기본값 CHANGEME 를 폐기하고 새로 생성"
  AUTH_COOKIE=""
else
  warn "이미 바꾼 비밀번호가 있습니다 — 유지합니다"
fi

if [ -z "$AUTH_COOKIE" ] && [ -n "$PASSWORD" ]; then
  login "$PASSWORD" || warn "새 비밀번호로 로그인 실패"
fi

# ────────────────────────────────────────────────────────────── 5. API 키
step "API 키"
KEY=""
if [ -n "$AUTH_COOKIE" ]; then
  EXISTING=$(api GET /api/keys | jq_get "['total']")
  if [ "${EXISTING:-0}" != "0" ]; then
    warn "키가 이미 ${EXISTING}개 있습니다 — 발급된 값은 다시 볼 수 없어 새로 만듭니다"
  fi
  KEY=$(api POST /api/keys '{"name":"claw-web"}' | jq_get "['key']")
  [ -n "$KEY" ] && ok "발급: ${KEY:0:18}…" || warn "키 발급 실패"
else
  warn "대시보드 로그인 정보가 없어 키를 만들지 못했습니다 — --password 로 알려주세요"
fi

# ────────────────────────────────────────────────────────────── 6. claw-web 에 연결
step "claw-web 백엔드 연결"
WPORT=$(web_port); WTOKEN=$(web_token)
cw() { curl -s -m 20 -X "$1" "http://127.0.0.1:$WPORT/api$2" \
       ${WTOKEN:+-H "Authorization: Bearer $WTOKEN"} \
       -H 'Content-Type: application/json' ${3:+-d "$3"} -w '\n%{http_code}'; }

if ! curl -s -o /dev/null -m 5 "http://127.0.0.1:$WPORT/api/health"; then
  warn "claw-web 이 :$WPORT 에서 응답하지 않습니다 — 백엔드 연결을 건너뜁니다"
else
  R=$(cw POST /backends/presets/omniroute/apply '{}'); C=$(echo "$R" | tail -1)
  case "$C" in
    201) ok "백엔드 등록" ;;
    409) ok "백엔드가 이미 있습니다" ;;
    *)   warn "백엔드 등록 응답 HTTP $C" ;;
  esac

  # 프리셋 기본 매핑(claude/glm/...)은 omniroute 가 'claude' 를 제공자 이름으로 읽어 401 이 난다.
  # 제공자를 하나도 안 붙인 상태에서 확실히 도는 건 'auto' 뿐이라 이걸 기본으로 넣는다.
  # 선택지 목록은 이 models 의 '키'가 그대로 쓰인다 (AgentModal.tsx).
  R=$(cw PATCH /backends/omniroute '{"models":{"auto":"auto","sonnet":"auto","haiku":"auto"}}')
  [ "$(echo "$R" | tail -1)" = "200" ] && ok "모델 매핑: auto" || warn "모델 매핑 실패"

  if [ -n "$KEY" ]; then
    # 토큰이 비어 있으면 runner 가 진짜 Claude OAuth 토큰을 대신 넣는다
    # (claude-cli-runner.js) — 실제 자격증명이 게이트웨이로 넘어가므로 반드시 채운다.
    R=$(cw PUT /backends/omniroute/secret "{\"value\":\"$KEY\"}")
    [ "$(echo "$R" | tail -1)" = "200" ] && ok "OMNIROUTE_TOKEN 주입" || warn "토큰 주입 실패"
  fi
fi

# ────────────────────────────────────────────────────────────── 7. 검증
step "동작 확인"
if [ -n "$KEY" ]; then
  BODY=$(curl -s -m 90 -X POST "http://127.0.0.1:$PORT/v1/messages" \
    -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
    -H "Authorization: Bearer $KEY" \
    -d '{"model":"auto","max_tokens":32,"messages":[{"role":"user","content":"Reply with exactly: OMNIROUTE_OK"}]}')
  if echo "$BODY" | grep -q OMNIROUTE_OK; then
    ok "응답 정상 (모델: $(echo "$BODY" | jq_get "['model']"))"
  else
    warn "응답 확인 실패: $(echo "$BODY" | head -c 200)"
  fi
else
  warn "키가 없어 건너뜁니다"
fi

# ────────────────────────────────────────────────────────────── 요약
HOSTLINE="http://127.0.0.1:$PORT"
if grep -q '^OMNIROUTE_SERVER_HOST=0.0.0.0' "$ENVF"; then
  LANIP=$(ipconfig getifaddr en1 2>/dev/null || ipconfig getifaddr en0 2>/dev/null \
          || hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$LANIP" ] && HOSTLINE="http://$LANIP:$PORT"
fi

printf '\n\033[32m완료\033[0m\n'
echo "  대시보드 : $HOSTLINE"
[ -n "$PASSWORD" ] && echo "  비밀번호 : $PASSWORD   ← 이번에 설정한 값입니다. 따로 적어두세요"
[ -n "$KEY" ]      && echo "  API 키   : $KEY"
echo "  로그     : $LOGDIR"
echo
echo "claw-web 에서 쓰려면: 에이전트 편집 → 백엔드 'OmniRoute' + 모델 'auto'."
echo "무료 티어는 GLM/Qwen 등 비클로드 모델이고 프롬프트가 외부로 나갑니다 — 운영 데이터 에이전트에는 붙이지 마세요."
