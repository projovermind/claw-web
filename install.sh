#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
#  🦞 Claw Web Installer
#  Claude 에이전트 관리 웹 플랫폼
# ─────────────────────────────────────────────

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

STEP=0
TOTAL_STEPS=8

step() {
  STEP=$((STEP + 1))
  echo ""
  echo -e "${CYAN}[$STEP/$TOTAL_STEPS]${NC} ${BOLD}$1${NC}"
  echo -e "${DIM}────────────────────────────────${NC}"
}

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
ask()  { echo -ne "  ${BLUE}?${NC} $1"; }

# ─── Welcome ──────────────────────────────────

clear
echo ""
echo -e "${BOLD}  🦞 Claw Web Installer${NC}"
echo -e "${DIM}  Claude 에이전트 관리 웹 플랫폼${NC}"
echo ""
echo -e "  이 스크립트는 다음을 수행합니다:"
echo -e "  ${DIM}1. 필수 프로그램 확인 (Node.js, Claude CLI)"
echo -e "  2. 의존성 설치 + 클라이언트 빌드"
echo -e "  3. API 키 & 인증 설정"
echo -e "  4. (선택) ngrok 고정 URL 설정"
echo -e "  5. (선택) 자동 시작 등록 (macOS)${NC}"
echo ""
ask "계속할까요? (Y/n) "
read -r yn
[[ "$yn" =~ ^[Nn] ]] && echo "취소됨." && exit 0

# ─── Detect install directory ─────────────────

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
echo ""
ok "설치 디렉토리: ${BOLD}$INSTALL_DIR${NC}"

# ─── Step 1: Prerequisites ────────────────────

step "필수 프로그램 확인"

# Node.js
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "Node.js $NODE_VER"
  else
    fail "Node.js 20+ 필요 (현재: $NODE_VER). https://nodejs.org 에서 업데이트."
  fi
else
  fail "Node.js가 설치되지 않음. https://nodejs.org 에서 설치 후 다시 실행."
fi

# npm
if command -v npm &>/dev/null; then
  ok "npm $(npm -v)"
else
  fail "npm이 없음. Node.js를 재설치해주세요."
fi

# Claude CLI (선택 — API 키로도 동작)
CLAUDE_BIN=""
for p in /usr/local/bin/claude /opt/homebrew/bin/claude "$HOME/.npm-global/bin/claude"; do
  if [ -x "$p" ]; then CLAUDE_BIN="$p"; break; fi
done
if command -v claude &>/dev/null; then
  CLAUDE_BIN=$(command -v claude)
fi

if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_VER=$($CLAUDE_BIN --version 2>/dev/null || echo "unknown")
  ok "Claude CLI: $CLAUDE_BIN ($CLAUDE_VER)"
else
  warn "Claude CLI가 없음. npm install -g @anthropic-ai/claude-code 로 설치하면 채팅 가능."
  echo -e "    ${DIM}API 키만으로도 기본 동작은 합니다.${NC}"
fi

# ─── Step 2: Dependencies ─────────────────────

step "의존성 설치"

cd "$INSTALL_DIR"
echo -e "  ${DIM}npm install ...${NC}"
npm install --loglevel=error 2>&1 | tail -3
ok "서버 의존성 설치 완료"

echo -e "  ${DIM}npm --prefix client install ...${NC}"
npm --prefix client install --loglevel=error 2>&1 | tail -3
ok "클라이언트 의존성 설치 완료"

# ─── Step 3: Build client ─────────────────────

step "클라이언트 빌드"

npm run build 2>&1 | tail -3
ok "빌드 완료"

# ─── Step 4: API Key ──────────────────────────

step "Claude API 키 설정"

SECRETS_FILE="$INSTALL_DIR/secrets.json"
EXISTING_KEY=""

if [ -f "$SECRETS_FILE" ]; then
  EXISTING_KEY=$(node -e "try{const s=JSON.parse(require('fs').readFileSync('$SECRETS_FILE','utf8'));const v=s.backends?.claude?.value;if(v)console.log(v.slice(0,8)+'...')}catch{}" 2>/dev/null)
fi

if [ -n "$EXISTING_KEY" ]; then
  ok "기존 API 키 감지: $EXISTING_KEY"
  ask "유지할까요? (Y/n) "
  read -r keep_key
  if [[ "$keep_key" =~ ^[Nn] ]]; then
    EXISTING_KEY=""
  fi
fi

if [ -z "$EXISTING_KEY" ]; then
  echo ""
  echo -e "  Claude API 키가 필요합니다."
  echo -e "  ${DIM}발급: https://console.anthropic.com/settings/keys${NC}"
  echo -e "  ${DIM}없으면 Enter를 눌러 건너뛰기 (OAuth 로그인 필요)${NC}"
  echo ""
  ask "Anthropic API Key: "
  read -r API_KEY

  if [ -n "$API_KEY" ]; then
    cat > "$SECRETS_FILE" << EOFKEY
{
  "version": 1,
  "backends": {
    "claude": {
      "envKey": "ANTHROPIC_API_KEY",
      "value": "$API_KEY"
    }
  }
}
EOFKEY
    chmod 600 "$SECRETS_FILE"
    ok "API 키 저장 완료 (secrets.json)"
  else
    warn "API 키 건너뜀. Claude CLI OAuth 또는 웹 UI에서 나중에 설정 가능."
    cat > "$SECRETS_FILE" << EOFKEY
{
  "version": 1,
  "backends": {}
}
EOFKEY
    chmod 600 "$SECRETS_FILE"
  fi
fi

# ─── Step 5: Auth Token ───────────────────────

step "웹 접속 인증 설정"

CONFIG_FILE="$INSTALL_DIR/web-config.json"

echo -e "  외부에서 접속할 때 Bearer 토큰으로 인증합니다."
echo -e "  ${DIM}로컬만 사용하면 건너뛰어도 됩니다.${NC}"
echo ""
ask "인증 토큰 (Enter = 인증 비활성화): "
read -r AUTH_TOKEN

if [ -n "$AUTH_TOKEN" ]; then
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE','utf8'));
    cfg.auth = { enabled: true, token: '$AUTH_TOKEN' };
    fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
  "
  ok "인증 활성화 (토큰: ${AUTH_TOKEN:0:4}****)"
else
  ok "인증 비활성화 (로컬 전용)"
fi

# ─── Step 6: Working Directory ────────────────

step "기본 작업 디렉토리 설정"

echo -e "  에이전트가 파일을 읽고 쓸 기본 디렉토리입니다."
echo -e "  ${DIM}프로젝트 루트를 지정하면 에이전트가 코드에 접근 가능.${NC}"
echo ""
ask "작업 디렉토리 (Enter = $HOME): "
read -r WORK_DIR
WORK_DIR="${WORK_DIR:-$HOME}"
WORK_DIR=$(eval echo "$WORK_DIR")  # ~ 확장

# agents-config.json에 workingDir 설정
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$INSTALL_DIR/agents-config.json','utf8'));
  for (const a of Object.values(cfg.agents)) {
    if (!a.workingDir) a.workingDir = '$WORK_DIR';
  }
  fs.writeFileSync('$INSTALL_DIR/agents-config.json', JSON.stringify(cfg, null, 2));
"

# web-config에 allowedRoots 설정
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE','utf8'));
  cfg.allowedRoots = ['$WORK_DIR', '$INSTALL_DIR'];
  fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
"
ok "작업 디렉토리: $WORK_DIR"

# ─── Step 7: ngrok (optional) ─────────────────

step "ngrok 원격 접속 설정 (선택)"

echo -e "  ngrok으로 고정 URL을 만들면 어디서든 접속 가능."
echo -e "  ${DIM}필요 없으면 Enter로 건너뛰기.${NC}"
echo ""
ask "ngrok 설정할까요? (y/N) "
read -r setup_ngrok

NGROK_DOMAIN=""

if [[ "$setup_ngrok" =~ ^[Yy] ]]; then
  # ngrok 설치 확인
  if ! command -v ngrok &>/dev/null; then
    echo -e "  ${DIM}ngrok 설치 중...${NC}"
    if command -v brew &>/dev/null; then
      brew install ngrok 2>/dev/null || warn "brew install ngrok 실패. https://ngrok.com/download 에서 수동 설치."
    else
      warn "ngrok이 없음. https://ngrok.com/download 에서 설치 후 다시 실행."
    fi
  fi

  if command -v ngrok &>/dev/null; then
    ok "ngrok 설치됨"

    # authtoken
    ask "ngrok Authtoken (https://dashboard.ngrok.com 에서 복사): "
    read -r NGROK_TOKEN
    if [ -n "$NGROK_TOKEN" ]; then
      ngrok config add-authtoken "$NGROK_TOKEN" 2>/dev/null
      ok "ngrok 인증 완료"
    fi

    # 고정 도메인
    echo ""
    echo -e "  ${DIM}고정 도메인: https://dashboard.ngrok.com/domains → New Domain${NC}"
    ask "ngrok 고정 도메인 (예: xxx.ngrok-free.dev, Enter = 건너뛰기): "
    read -r NGROK_DOMAIN

    if [ -n "$NGROK_DOMAIN" ]; then
      ok "ngrok 도메인: $NGROK_DOMAIN"
    fi
  fi
fi

# ─── Step 8: LaunchAgent (macOS only) ─────────

step "자동 시작 등록 (macOS)"

if [[ "$(uname)" != "Darwin" ]]; then
  warn "macOS가 아님 — 수동으로 실행: npm start"
else
  ask "Mac 부팅 시 자동 시작할까요? (Y/n) "
  read -r auto_start

  if [[ ! "$auto_start" =~ ^[Nn] ]]; then
    PLIST_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$PLIST_DIR"

    # Server LaunchAgent
    cat > "$PLIST_DIR/com.claw-web.server.plist" << EOFPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claw-web.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(command -v node)</string>
        <string>$INSTALL_DIR/server/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claw-web.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claw-web.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOFPLIST
    ok "서버 LaunchAgent 등록"

    # ngrok LaunchAgent (도메인이 있으면)
    if [ -n "$NGROK_DOMAIN" ]; then
      NGROK_BIN=$(command -v ngrok || echo "/opt/homebrew/bin/ngrok")
      cat > "$PLIST_DIR/com.claw-web.ngrok.plist" << EOFPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claw-web.ngrok</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NGROK_BIN</string>
        <string>http</string>
        <string>3838</string>
        <string>--url=$NGROK_DOMAIN</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claw-web-ngrok.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claw-web-ngrok.log</string>
</dict>
</plist>
EOFPLIST
      ok "ngrok LaunchAgent 등록"
    fi

    # Load agents
    # macOS Ventura+ 에서는 bootstrap 사용 (load는 deprecated)
    LAUNCHCTL_UID=$(id -u)
    # 기존 서비스가 이미 등록돼 있으면 먼저 제거
    launchctl bootout "gui/$LAUNCHCTL_UID/com.claw-web.server" 2>/dev/null || true
    launchctl bootstrap "gui/$LAUNCHCTL_UID" "$PLIST_DIR/com.claw-web.server.plist" && ok "서버 서비스 등록됨" || {
      # fallback: 구 방식
      launchctl load "$PLIST_DIR/com.claw-web.server.plist" 2>/dev/null || true
      ok "서버 서비스 등록됨 (legacy)"
    }
    if [ -n "$NGROK_DOMAIN" ]; then
      launchctl bootout "gui/$LAUNCHCTL_UID/com.claw-web.ngrok" 2>/dev/null || true
      launchctl bootstrap "gui/$LAUNCHCTL_UID" "$PLIST_DIR/com.claw-web.ngrok.plist" 2>/dev/null || \
        launchctl load "$PLIST_DIR/com.claw-web.ngrok.plist" 2>/dev/null || true
      ok "ngrok 서비스 등록됨"
    fi
    # 서비스 시작 확인 (최대 5초 대기)
    echo -ne "  서버 시작 대기 중"
    for i in 1 2 3 4 5; do
      sleep 1
      if lsof -i :3838 -sTCP:LISTEN &>/dev/null; then
        echo ""
        ok "서버 시작 확인 (port 3838 열림)"
        break
      fi
      echo -n "."
      if [ "$i" -eq 5 ]; then
        echo ""
        warn "서버가 5초 내 시작되지 않음. 로그 확인: tail -f /tmp/claw-web.log"
      fi
    done
  else
    ok "자동 시작 건너뜀. 수동 실행: cd $INSTALL_DIR && npm start"
  fi
fi

# ─── Start server now ─────────────────────────
# LaunchAgent는 부팅 자동시작용. 지금 당장 포트를 열기 위해 직접 실행.

echo ""
echo -e "${CYAN}[!]${NC} ${BOLD}서버 즉시 시작${NC}"
echo -e "${DIM}────────────────────────────────${NC}"

# 기존에 3838 포트를 점유 중인 프로세스 종료
OLD_PID=$(lsof -ti :3838 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2>/dev/null || true
  sleep 1
  ok "기존 서버 프로세스 종료 (PID $OLD_PID)"
fi

cd "$INSTALL_DIR"
NODE_ENV=production nohup node server/index.js > /tmp/claw-web.log 2>&1 &
SERVER_PID=$!
echo -ne "  포트 열림 대기 중"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if lsof -i :3838 -sTCP:LISTEN &>/dev/null; then
    echo ""
    ok "서버 시작 완료! (PID $SERVER_PID, port 3838)"
    break
  fi
  echo -n "."
  if [ "$i" -eq 10 ]; then
    echo ""
    warn "서버 시작 실패. 로그 확인: tail -f /tmp/claw-web.log"
  fi
done

# ─── Done ─────────────────────────────────────

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  🦞 Claw Web 설치 완료!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}로컬 접속:${NC}  http://localhost:3838"
if [ -n "$NGROK_DOMAIN" ]; then
  echo -e "  ${BOLD}외부 접속:${NC}  https://$NGROK_DOMAIN"
fi
if [ -n "$AUTH_TOKEN" ]; then
  echo -e "  ${BOLD}인증 토큰:${NC}  $AUTH_TOKEN"
fi
echo ""
echo -e "  ${DIM}서버 로그:   tail -f /tmp/claw-web.log${NC}"
echo -e "  ${DIM}서버 재시작: kill \$(lsof -ti :3838) && NODE_ENV=production nohup node $INSTALL_DIR/server/index.js > /tmp/claw-web.log 2>&1 &${NC}"
echo -e "  ${DIM}서버 중지:   launchctl bootout gui/\$(id -u)/com.claw-web.server 2>/dev/null; kill \$(lsof -ti :3838) 2>/dev/null${NC}"
echo ""
