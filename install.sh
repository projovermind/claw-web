#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
#  🦞 Claw Web Installer
#  Claude 에이전트 관리 웹 플랫폼
#
#  대화형:  ./install.sh
#  무인:    CLAW_YES=1 ./install.sh   또는   ./install.sh --yes
#
#  무인 모드에서 참고하는 환경변수 (없으면 안전한 기본값):
#    CLAW_TOKEN          웹 인증 토큰 (미지정 시 랜덤 6자리 자동생성)
#    CLAW_API_KEY        Anthropic API 키 (미지정 시 건너뜀 — CLI OAuth 사용)
#    CLAW_WORKDIR        에이전트 기본 작업 디렉토리 (기본: $HOME)
#    CLAW_NGROK_DOMAIN   ngrok 고정 도메인 (미지정 시 ngrok 설정 안 함)
#    CLAW_NGROK_TOKEN    ngrok authtoken
#    CLAW_NO_SERVICE=1   자동 시작(LaunchAgent/systemd) 등록 건너뛰기
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

# ─── 무인 모드 판정 ────────────────────────────

ASSUME_YES=0
[ "${CLAW_YES:-}" = "1" ] && ASSUME_YES=1
for arg in "$@"; do
  case "$arg" in
    -y|--yes|--unattended) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '4,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
  esac
done

# curl | bash 로 실행되면 stdin 이 스크립트 본문이라 read 가 스크립트를 먹는다.
# 대화형 입력은 항상 /dev/tty 에서 받고, tty 가 없으면 무인 모드로 강등한다.
HAS_TTY=0
[ -r /dev/tty ] && [ -t 1 ] && HAS_TTY=1
if [ "$ASSUME_YES" = 0 ] && [ "$HAS_TTY" = 0 ]; then
  ASSUME_YES=1
  echo -e "  ${YELLOW}⚠${NC} 터미널 입력이 없어 무인 모드로 진행합니다."
fi

# prompt_read VAR "질문" "기본값"  — 무인이면 기본값을 그대로 쓴다
prompt_read() {
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if [ "$ASSUME_YES" = 1 ]; then
    printf -v "$__var" '%s' "$__def"
    return 0
  fi
  ask "$__q"
  read -r __ans < /dev/tty || __ans=""
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# confirm "질문" Y|N  — 무인이면 기본값대로 답한 셈 친다
confirm() {
  local __q="$1" __def="${2:-Y}" __ans=""
  if [ "$ASSUME_YES" = 1 ]; then
    [[ "$__def" =~ ^[Yy] ]] && return 0 || return 1
  fi
  ask "$__q"
  read -r __ans < /dev/tty || __ans=""
  __ans="${__ans:-$__def}"
  [[ "$__ans" =~ ^[Yy] ]]
}

IS_MAC=0
[ "$(uname)" = "Darwin" ] && IS_MAC=1

# port_listening PORT — lsof/ss/curl 중 있는 것으로 확인 (Linux 엔 lsof 가 없을 수 있다)
port_listening() {
  local p="$1"
  if command -v lsof &>/dev/null; then
    lsof -i ":$p" -sTCP:LISTEN &>/dev/null && return 0 || return 1
  elif command -v ss &>/dev/null; then
    ss -ltn 2>/dev/null | grep -q ":$p " && return 0 || return 1
  else
    curl -s -o /dev/null -m 2 "http://127.0.0.1:$p/api/health" &>/dev/null && return 0 || return 1
  fi
}

# ─── Welcome ──────────────────────────────────

[ "$HAS_TTY" = 1 ] && clear
echo ""
echo -e "${BOLD}  🦞 Claw Web Installer${NC}"
echo -e "${DIM}  Claude 에이전트 관리 웹 플랫폼${NC}"
echo ""
echo -e "  이 스크립트는 다음을 수행합니다:"
echo -e "  ${DIM}1. 필수 프로그램 확인 (Node.js, Claude CLI)"
echo -e "  2. 의존성 설치 + 클라이언트 빌드"
echo -e "  3. API 키 & 인증 설정"
echo -e "  4. (선택) ngrok 고정 URL 설정"
echo -e "  5. 자동 시작 등록 (macOS LaunchAgent / Linux systemd)${NC}"
echo ""
[ "$ASSUME_YES" = 1 ] && echo -e "  ${DIM}무인 모드 — 프롬프트 없이 진행합니다.${NC}" && echo ""
if ! confirm "계속할까요? (Y/n) " Y; then
  echo "취소됨."; exit 0
fi

# ─── Detect install directory ─────────────────

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
echo ""
ok "설치 디렉토리: ${BOLD}$INSTALL_DIR${NC}"

# ─── Step 1: Prerequisites ────────────────────

step "필수 프로그램 확인"

# 항상 exit 0 (node 부재 시 빈 문자열) — set -e 아래에서 대입이 죽지 않게
node_major() { node -v 2>/dev/null | sed 's/v//' | cut -d. -f1 || true; }

# Node 20+ 가 없으면 brew(mac) → nvm(공통) 순으로 직접 설치를 시도한다.
install_node() {
  if [ "$IS_MAC" = 1 ] && command -v brew &>/dev/null; then
    echo -e "  ${DIM}brew install node@20 ...${NC}"
    if brew install node@20 >/tmp/claw-node-install.log 2>&1; then
      local prefix; prefix="$(brew --prefix node@20 2>/dev/null || echo '')"
      [ -n "$prefix" ] && export PATH="$prefix/bin:$PATH"
      brew link --overwrite --force node@20 >>/tmp/claw-node-install.log 2>&1 || true
      [ -n "$(node_major)" ] && [ "$(node_major)" -ge 20 ] 2>/dev/null && return 0
    fi
    warn "brew 설치 실패 — nvm 으로 재시도 (로그: /tmp/claw-node-install.log)"
  fi

  # nvm (sudo 불필요, 사용자 홈에 설치)
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo -e "  ${DIM}nvm 설치 중...${NC}"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash \
      >>/tmp/claw-node-install.log 2>&1 || true
  fi
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # nvm.sh 는 unbound 변수를 건드리므로 잠시 -u 를 끈다
    set +u; . "$NVM_DIR/nvm.sh"; set -u
    echo -e "  ${DIM}nvm install 20 ...${NC}"
    nvm install 20 >>/tmp/claw-node-install.log 2>&1 || true
    nvm use 20 >>/tmp/claw-node-install.log 2>&1 || true
  fi
  [ -n "$(node_major)" ] && [ "$(node_major)" -ge 20 ] 2>/dev/null
}

NODE_MAJOR="$(node_major)"
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 20 ]; then
  ok "Node.js $(node -v)"
else
  if [ -n "$NODE_MAJOR" ]; then
    warn "Node.js 20+ 필요 (현재: $(node -v))"
  else
    warn "Node.js가 설치되어 있지 않습니다."
  fi
  if confirm "Node 20 을 지금 설치할까요? (Y/n) " Y && install_node; then
    ok "Node.js $(node -v) 설치 완료"
  else
    [ "$HAS_TTY" = 1 ] && open "https://nodejs.org/en/download" 2>/dev/null || true
    fail "Node.js 20 LTS 설치 후 다시 실행해주세요. (로그: /tmp/claw-node-install.log)"
  fi
fi

# npm
if command -v npm &>/dev/null; then
  ok "npm $(npm -v)"
else
  fail "npm이 없음. Node.js를 재설치해주세요."
fi

# Claude CLI (선택 — API 키로도 동작)
CLAUDE_BIN=""
for p in /usr/local/bin/claude /opt/homebrew/bin/claude "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude"; do
  if [ -x "$p" ]; then CLAUDE_BIN="$p"; break; fi
done
if command -v claude &>/dev/null; then
  CLAUDE_BIN=$(command -v claude)
fi

if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_VER=$($CLAUDE_BIN --version 2>/dev/null || echo "unknown")
  ok "Claude CLI: $CLAUDE_BIN ($CLAUDE_VER)"
else
  warn "Claude CLI가 없습니다 (채팅 기능에 필수)"
  if confirm "지금 설치할까요? (Y/n) " Y; then
    echo -e "  ${DIM}npm install -g @anthropic-ai/claude-code ...${NC}"
    npm install -g @anthropic-ai/claude-code 2>&1 | tail -3 || \
      warn "전역 설치 실패 (권한?). 수동: npm install -g @anthropic-ai/claude-code"
    CLAUDE_BIN=$(command -v claude 2>/dev/null || echo "")
    if [ -n "$CLAUDE_BIN" ]; then
      ok "Claude CLI 설치 완료: $CLAUDE_BIN"
    else
      warn "설치 후 PATH에서 claude를 찾지 못했습니다. 터미널을 재시작 후 확인하세요."
    fi
  else
    warn "나중에 직접 설치: npm install -g @anthropic-ai/claude-code"
  fi
fi

# ─── Step 2: Dependencies ─────────────────────

step "의존성 설치"

cd "$INSTALL_DIR"
# NODE_ENV=production 환경에서도 vite/tsc 가 필요하므로 --include=dev 를 명시한다
echo -e "  ${DIM}npm install ...${NC}"
npm install --include=dev --loglevel=error --no-audit --no-fund 2>&1 | tail -3
ok "서버 의존성 설치 완료"

echo -e "  ${DIM}npm --prefix client install ...${NC}"
npm --prefix client install --include=dev --loglevel=error --no-audit --no-fund 2>&1 | tail -3
ok "클라이언트 의존성 설치 완료"

# ─── Step 3: Build client ─────────────────────

step "클라이언트 빌드"

npm run build > /tmp/claw-build.log 2>&1 || { tail -25 /tmp/claw-build.log; fail "빌드 실패 (로그: /tmp/claw-build.log)"; }
ok "빌드 완료"

# ─── Step 4: API Key ──────────────────────────

step "Claude API 키 설정"

SECRETS_FILE="$INSTALL_DIR/data/private/secrets.json"
mkdir -p "$INSTALL_DIR/data/private"
EXISTING_KEY=""

if [ -f "$SECRETS_FILE" ]; then
  EXISTING_KEY=$(CLAW_SECRETS="$SECRETS_FILE" node -e "try{const s=JSON.parse(require('fs').readFileSync(process.env.CLAW_SECRETS,'utf8'));const v=s.backends?.claude?.value;if(v)console.log(v.slice(0,8)+'...')}catch{}" 2>/dev/null)
fi

if [ -n "$EXISTING_KEY" ]; then
  ok "기존 API 키 감지: $EXISTING_KEY"
  if ! confirm "유지할까요? (Y/n) " Y; then
    EXISTING_KEY=""
  fi
fi

if [ -z "$EXISTING_KEY" ]; then
  echo ""
  echo -e "  Claude API 키가 필요합니다."
  echo -e "  ${DIM}발급: https://console.anthropic.com/settings/keys${NC}"
  echo -e "  ${DIM}없으면 Enter를 눌러 건너뛰기 (OAuth 로그인 필요)${NC}"
  echo ""
  prompt_read API_KEY "Anthropic API Key: " "${CLAW_API_KEY:-}"

  if [ -n "$API_KEY" ]; then
    CLAW_SECRETS="$SECRETS_FILE" CLAW_KEY="$API_KEY" node -e "
      const fs = require('fs');
      fs.writeFileSync(process.env.CLAW_SECRETS, JSON.stringify({
        version: 1,
        backends: { claude: { envKey: 'ANTHROPIC_API_KEY', value: process.env.CLAW_KEY } }
      }, null, 2));
    "
    chmod 600 "$SECRETS_FILE"
    ok "API 키 저장 완료 (secrets.json)"
  else
    warn "API 키 건너뜀. Claude CLI OAuth 또는 웹 UI에서 나중에 설정 가능."
    [ -f "$SECRETS_FILE" ] || printf '{\n  "version": 1,\n  "backends": {}\n}\n' > "$SECRETS_FILE"
    chmod 600 "$SECRETS_FILE"
  fi
fi

# ─── Step 5: Auth Token ───────────────────────

step "웹 접속 인증 설정"

CONFIG_FILE="$INSTALL_DIR/data/private/web-config.json"

# 신규 클론엔 web-config.json 이 없다 (private 파일이라 git tracked 아님).
# 서버도 부팅 시 같은 템플릿으로 시드하지만, 아래 node -e 들이 먼저 읽으므로 여기서 만든다.
mkdir -p "$INSTALL_DIR/data/private"
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -f "$INSTALL_DIR/data/shared/web-config.template.json" ]; then
    cp "$INSTALL_DIR/data/shared/web-config.template.json" "$CONFIG_FILE"
  else
    echo '{}' > "$CONFIG_FILE"
  fi
fi

echo -e "  외부에서 접속할 때 Bearer 토큰으로 인증합니다."
echo -e "  ${DIM}로컬만 사용하면 건너뛰어도 됩니다.${NC}"
echo ""

# 무인 모드에선 인증 없이 열어두면 위험하므로, 토큰이 없으면 랜덤 6자리를 만든다.
AUTH_DEFAULT="${CLAW_TOKEN:-}"
if [ "$ASSUME_YES" = 1 ] && [ -z "$AUTH_DEFAULT" ]; then
  AUTH_DEFAULT=$(node -e "process.stdout.write(String(Math.floor(Math.random()*900000)+100000))")
  echo -e "  ${DIM}CLAW_TOKEN 미지정 — 랜덤 토큰을 생성합니다.${NC}"
fi
prompt_read AUTH_TOKEN "인증 토큰 (Enter = 인증 비활성화): " "$AUTH_DEFAULT"

if [ -n "$AUTH_TOKEN" ]; then
  CLAW_CFG="$CONFIG_FILE" CLAW_TOK="$AUTH_TOKEN" node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync(process.env.CLAW_CFG,'utf8'));
    cfg.auth = { enabled: true, token: process.env.CLAW_TOK };
    fs.writeFileSync(process.env.CLAW_CFG, JSON.stringify(cfg, null, 2));
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
prompt_read WORK_DIR "작업 디렉토리 (Enter = $HOME): " "${CLAW_WORKDIR:-$HOME}"
WORK_DIR="${WORK_DIR:-$HOME}"
WORK_DIR=$(eval echo "$WORK_DIR")  # ~ 확장

# 신규 클론이면 agents-config 도 템플릿에서 시드 (서버 부팅 때도 하지만,
# workingDir 을 여기서 넣으려면 파일이 먼저 있어야 한다)
mkdir -p "$INSTALL_DIR/data/user"
if [ ! -f "$INSTALL_DIR/data/user/agents-config.json" ] && \
   [ -f "$INSTALL_DIR/data/shared/agents-config.template.json" ]; then
  cp "$INSTALL_DIR/data/shared/agents-config.template.json" "$INSTALL_DIR/data/user/agents-config.json"
fi

# agents-config.json에 workingDir 설정 (파일 없으면 건너뜀)
if [ -f "$INSTALL_DIR/data/user/agents-config.json" ]; then
  CLAW_AGENTS="$INSTALL_DIR/data/user/agents-config.json" CLAW_WD="$WORK_DIR" node -e "
    const fs = require('fs');
    const p = process.env.CLAW_AGENTS;
    const cfg = JSON.parse(fs.readFileSync(p,'utf8'));
    for (const a of Object.values(cfg.agents || {})) {
      if (!a.workingDir) a.workingDir = process.env.CLAW_WD;
    }
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  "
fi

# web-config에 allowedRoots 설정
CLAW_CFG="$CONFIG_FILE" CLAW_WD="$WORK_DIR" CLAW_DIR="$INSTALL_DIR" node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync(process.env.CLAW_CFG,'utf8'));
  cfg.allowedRoots = [process.env.CLAW_WD, process.env.CLAW_DIR];
  fs.writeFileSync(process.env.CLAW_CFG, JSON.stringify(cfg, null, 2));
"
ok "작업 디렉토리: $WORK_DIR"

# ─── Step 7: ngrok (optional) ─────────────────

step "ngrok 원격 접속 설정 (선택)"

NGROK_DOMAIN=""

# 무인 모드에선 CLAW_NGROK_DOMAIN 이 있을 때만 설정한다.
SETUP_NGROK=0
if [ "$ASSUME_YES" = 1 ]; then
  [ -n "${CLAW_NGROK_DOMAIN:-}" ] && SETUP_NGROK=1
else
  echo -e "  ngrok으로 고정 URL을 만들면 어디서든 접속 가능."
  echo -e "  ${DIM}필요 없으면 Enter로 건너뛰기.${NC}"
  echo ""
  confirm "ngrok 설정할까요? (y/N) " N && SETUP_NGROK=1
fi

if [ "$SETUP_NGROK" = 1 ]; then
  # ngrok 설치 확인
  if ! command -v ngrok &>/dev/null; then
    echo -e "  ${DIM}ngrok 설치 중...${NC}"
    if command -v brew &>/dev/null; then
      brew install ngrok >/dev/null 2>&1 || warn "brew install ngrok 실패. https://ngrok.com/download 에서 수동 설치."
    else
      warn "ngrok이 없음. https://ngrok.com/download 에서 설치 후 다시 실행."
    fi
  fi

  if command -v ngrok &>/dev/null; then
    ok "ngrok 설치됨"

    prompt_read NGROK_TOKEN "ngrok Authtoken (https://dashboard.ngrok.com 에서 복사): " "${CLAW_NGROK_TOKEN:-}"
    if [ -n "$NGROK_TOKEN" ]; then
      ngrok config add-authtoken "$NGROK_TOKEN" 2>/dev/null && ok "ngrok 인증 완료" || warn "ngrok 인증 실패"
    fi

    echo ""
    echo -e "  ${DIM}고정 도메인: https://dashboard.ngrok.com/domains → New Domain${NC}"
    prompt_read NGROK_DOMAIN "ngrok 고정 도메인 (예: xxx.ngrok-free.dev, Enter = 건너뛰기): " "${CLAW_NGROK_DOMAIN:-}"

    if [ -n "$NGROK_DOMAIN" ]; then
      ok "ngrok 도메인: $NGROK_DOMAIN"
    fi
  fi
else
  ok "ngrok 건너뜀"
fi

# ─── Step 8: 자동 시작 (macOS launchd / Linux systemd) ─

step "자동 시작 등록"

SERVICE_STARTED=0

register_launchagent() {
  PLIST_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$PLIST_DIR"

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
        <string>$(dirname "$(command -v node)"):$HOME/.npm-global/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
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

  # macOS Ventura+ 에서는 bootstrap 사용 (load는 deprecated)
  LAUNCHCTL_UID=$(id -u)
  launchctl bootout "gui/$LAUNCHCTL_UID/com.claw-web.server" 2>/dev/null || true
  launchctl bootstrap "gui/$LAUNCHCTL_UID" "$PLIST_DIR/com.claw-web.server.plist" 2>/dev/null && ok "서버 서비스 등록됨" || {
    launchctl load "$PLIST_DIR/com.claw-web.server.plist" 2>/dev/null || true
    ok "서버 서비스 등록됨 (legacy)"
  }
  if [ -n "$NGROK_DOMAIN" ]; then
    launchctl bootout "gui/$LAUNCHCTL_UID/com.claw-web.ngrok" 2>/dev/null || true
    launchctl bootstrap "gui/$LAUNCHCTL_UID" "$PLIST_DIR/com.claw-web.ngrok.plist" 2>/dev/null || \
      launchctl load "$PLIST_DIR/com.claw-web.ngrok.plist" 2>/dev/null || true
    ok "ngrok 서비스 등록됨"
  fi

  # launchd 가 RunAtLoad 로 이미 띄웠으면 아래에서 kill+재실행 하지 않는다.
  # (KeepAlive 가 살아있는 상태에서 죽이면 launchd 재시작과 포트를 다툰다)
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    port_listening 3838 && { SERVICE_STARTED=1; break; }
    sleep 1
  done
}

register_systemd() {
  # WSL 셋업 스크립트와 같은 unit 이름/형식을 쓴다 (scripts/self-update.sh 가 이 이름을 재시작한다)
  local unit_dir="$HOME/.config/systemd/user"
  local node_bin node_dir
  node_bin="$(command -v node)"; node_dir="$(dirname "$node_bin")"
  mkdir -p "$unit_dir" "$INSTALL_DIR/data/user/logs"

  cat > "$unit_dir/claw-web.service" << EOFUNIT
[Unit]
Description=Claw Web
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
Environment=PATH=$node_dir:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$node_bin $INSTALL_DIR/server/index.js
Restart=always
RestartSec=3
StandardOutput=append:$INSTALL_DIR/data/user/logs/claw-web.log
StandardError=append:$INSTALL_DIR/data/user/logs/claw-web.err.log

[Install]
WantedBy=default.target
EOFUNIT
  ok "systemd unit 작성: $unit_dir/claw-web.service"

  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now claw-web 2>/dev/null; then
    ok "claw-web 서비스 시작됨"
    # 터미널을 다 닫아도 살아있게 (sudo 없으면 그냥 넘어간다)
    sudo -n loginctl enable-linger "$(id -un)" 2>/dev/null && ok "linger 활성" || \
      warn "linger 미설정 — 로그아웃 시 서비스가 멈출 수 있습니다: sudo loginctl enable-linger $(id -un)"
    SERVICE_STARTED=1
  else
    warn "systemd --user 사용 불가 — 수동 실행으로 대체합니다."
  fi
}

if [ "${CLAW_NO_SERVICE:-}" = "1" ]; then
  ok "자동 시작 등록 건너뜀 (CLAW_NO_SERVICE=1)"
elif confirm "부팅 시 자동 시작할까요? (Y/n) " Y; then
  if [ "$IS_MAC" = 1 ]; then
    register_launchagent
  elif command -v systemctl &>/dev/null; then
    register_systemd
  else
    warn "launchd/systemd 를 찾을 수 없음 — 수동 실행: npm start"
  fi
  # ngrok 상주화는 macOS LaunchAgent 만 처리한다
  if [ "$IS_MAC" = 0 ] && [ -n "$NGROK_DOMAIN" ]; then
    warn "ngrok 은 직접 띄워야 합니다: ngrok http 3838 --url=$NGROK_DOMAIN"
  fi
else
  ok "자동 시작 건너뜀. 수동 실행: cd $INSTALL_DIR && npm start"
fi

# ─── Start server now ─────────────────────────
# 서비스 등록은 부팅 자동시작용. 지금 당장 포트를 열기 위해 직접 실행한다.
# (systemd 가 이미 띄웠으면 건너뛴다)

echo ""
echo -e "${CYAN}[!]${NC} ${BOLD}서버 즉시 시작${NC}"
echo -e "${DIM}────────────────────────────────${NC}"

PORT=3838
SERVER_UP=0

if [ "$SERVICE_STARTED" = 1 ]; then
  for i in 1 2 3 4 5 6 7 8 9 10; do
    port_listening "$PORT" && { SERVER_UP=1; break; }
    sleep 1
  done
  if [ "$SERVER_UP" = 1 ]; then
    ok "서비스가 서버를 띄웠습니다 (port $PORT)"
    [ "$HAS_TTY" = 1 ] && { open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null || true; }
  fi
fi

if [ "$SERVER_UP" = 0 ]; then
  # 기존에 포트를 점유 중인 프로세스 종료
  if command -v lsof &>/dev/null; then
    OLD_PID=$(lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$OLD_PID" ]; then
      kill $OLD_PID 2>/dev/null || true
      sleep 1
      ok "기존 서버 프로세스 종료 (PID $OLD_PID)"
    fi
  fi

  cd "$INSTALL_DIR"
  NODE_ENV=production nohup node server/index.js > /tmp/claw-web.log 2>&1 &
  SERVER_PID=$!
  echo -ne "  포트 열림 대기 중"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if port_listening "$PORT"; then
      echo ""
      ok "서버 시작 완료! (PID $SERVER_PID, port $PORT)"
      SERVER_UP=1
      if [ "$HAS_TTY" = 1 ]; then
        open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null || true
      fi
      break
    fi
    echo -n "."
  done
  [ "$SERVER_UP" = 0 ] && { echo ""; warn "서버 시작 실패. 로그 확인: tail -f /tmp/claw-web.log"; }
fi

# ─── Done ─────────────────────────────────────

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  🦞 Claw Web 설치 완료!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}로컬 접속:${NC}  http://localhost:$PORT"
if [ -n "$NGROK_DOMAIN" ]; then
  echo -e "  ${BOLD}외부 접속:${NC}  https://$NGROK_DOMAIN"
fi
if [ -n "$AUTH_TOKEN" ]; then
  echo -e "  ${BOLD}인증 토큰:${NC}  ${BOLD}$AUTH_TOKEN${NC}   ${DIM}(브라우저 첫 접속 시 입력)${NC}"
else
  echo -e "  ${BOLD}인증:${NC}       비활성화 (로컬 전용)"
fi
echo ""
echo -e "  ${DIM}설치 경로:   $INSTALL_DIR${NC}"
if [ "$IS_MAC" = 1 ]; then
  echo -e "  ${DIM}서버 로그:   tail -f /tmp/claw-web.log${NC}"
  echo -e "  ${DIM}서버 중지:   launchctl bootout gui/\$(id -u)/com.claw-web.server 2>/dev/null; kill \$(lsof -ti :$PORT) 2>/dev/null${NC}"
else
  echo -e "  ${DIM}서버 로그:   tail -f $INSTALL_DIR/data/user/logs/claw-web.log${NC}"
  echo -e "  ${DIM}서버 제어:   systemctl --user {status,restart,stop} claw-web${NC}"
fi
echo ""
