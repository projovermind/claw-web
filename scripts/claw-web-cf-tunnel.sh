#!/usr/bin/env bash
# claw-web 을 Cloudflare named tunnel 로 외부에 노출한다 (WSL/Linux 용).
#
#   bash claw-web-cf-tunnel.sh win.subinggrae.cc
#
# cloudflared 설치 → 터널 생성 → DNS 라우팅 → config.yml → systemd --user 등록까지.
# `cloudflared tunnel login` 만 브라우저 승인이 필요해서 그 단계는 안내 후 대기한다.
set -euo pipefail

HOSTNAME_ARG="${1:-}"
PORT="${2:-3838}"
TUNNEL_NAME="${TUNNEL_NAME:-claw-web-$(hostname -s | tr '[:upper:]' '[:lower:]')}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
die()  { echo -e "  ${RED}✗${NC} $1"; exit 1; }
step() { echo ""; echo -e "${CYAN}==${NC} $1"; }

[ -n "$HOSTNAME_ARG" ] || die "사용법: bash $0 <호스트명>  (예: win.subinggrae.cc)"

# ── 1. cloudflared 설치 ────────────────────────────────
step "cloudflared 확인"
if command -v cloudflared &>/dev/null; then
  ok "이미 설치됨 ($(cloudflared --version 2>/dev/null | head -1))"
else
  arch=$(dpkg --print-architecture 2>/dev/null || echo amd64)
  url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
  echo -e "  ${DIM}$url${NC}"
  curl -fsSL "$url" -o /tmp/cloudflared.deb || die "다운로드 실패"
  sudo dpkg -i /tmp/cloudflared.deb >/dev/null || die "설치 실패"
  rm -f /tmp/cloudflared.deb
  ok "설치 완료 ($(cloudflared --version 2>/dev/null | head -1))"
fi

# ── 2. Cloudflare 계정 인증 ────────────────────────────
step "Cloudflare 인증"
CERT="$HOME/.cloudflared/cert.pem"
if [ -f "$CERT" ]; then
  ok "인증 완료됨 (cert.pem)"
else
  warn "브라우저 인증이 필요합니다. 아래 URL 을 열어 도메인을 선택·승인하세요."
  echo ""
  cloudflared tunnel login || die "인증 실패"
  [ -f "$CERT" ] || die "cert.pem 이 생성되지 않았습니다."
  ok "인증 완료"
fi

# ── 3. 터널 생성 ───────────────────────────────────────
step "터널 준비: $TUNNEL_NAME"
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  ok "기존 터널 재사용"
else
  cloudflared tunnel create "$TUNNEL_NAME" >/dev/null || die "터널 생성 실패"
  ok "터널 생성됨"
fi

TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1}' | head -1)
[ -n "$TUNNEL_ID" ] || die "터널 ID 를 못 찾았습니다."
CRED="$HOME/.cloudflared/${TUNNEL_ID}.json"
[ -f "$CRED" ] || die "자격증명 파일이 없습니다: $CRED"
ok "id: $TUNNEL_ID"

# ── 4. DNS 라우팅 ──────────────────────────────────────
step "DNS 라우팅: $HOSTNAME_ARG"
# 파이프로 판정하면 pipefail 이 cloudflared 의 실패를 grep 결과로 덮어쓴다 — 출력을 먼저 받는다
route_out=$(cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ARG" 2>&1) && route_rc=0 || route_rc=$?
if [ "$route_rc" -eq 0 ]; then
  ok "CNAME $HOSTNAME_ARG → ${TUNNEL_ID}.cfargotunnel.com"
elif grep -qi "already exists\|record with that host" <<<"$route_out"; then
  # 이미 같은 터널을 가리키면 정상 — 다른 대상이면 CF 대시보드에서 레코드를 지워야 한다
  warn "CNAME 이 이미 있습니다 — 기존 레코드를 그대로 씁니다."
  warn "다른 곳을 가리키고 있다면 Cloudflare DNS 에서 $HOSTNAME_ARG 레코드를 지우고 다시 실행하세요."
else
  echo "$route_out"
  die "DNS 라우팅 실패"
fi

# ── 5. config.yml ──────────────────────────────────────
step "설정 파일"
CONFIG="$HOME/.cloudflared/config.yml"
[ -f "$CONFIG" ] && cp "$CONFIG" "$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
cat > "$CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CRED

# HTTP/2 고정 — QUIC 은 일부 네트워크에서 끊긴다
protocol: http2

ingress:
  - hostname: $HOSTNAME_ARG
    service: http://localhost:$PORT
    originRequest:
      # claw-web 은 SSE/WebSocket 으로 오래 열려 있는 연결을 쓴다
      noTLSVerify: true
      connectTimeout: 30s
      tcpKeepAlive: 30s
  - service: http_status:404
EOF
ok "$CONFIG"

# ── 6. systemd --user 서비스 ───────────────────────────
step "서비스 등록"
if ! ps -p 1 -o comm= | grep -q systemd; then
  warn "systemd 가 아닙니다 — 서비스 등록을 건너뜁니다."
  warn "수동 실행: cloudflared tunnel run $TUNNEL_NAME"
  exit 0
fi

mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/cloudflared.service" <<EOF
[Unit]
Description=cloudflared tunnel ($HOSTNAME_ARG)
After=network.target

[Service]
Type=simple
ExecStart=$(command -v cloudflared) --no-autoupdate --config $CONFIG tunnel run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user daemon-reload
systemctl --user enable --now cloudflared
sleep 3
if systemctl --user is-active --quiet cloudflared; then
  ok "cloudflared 서비스 실행 중"
else
  systemctl --user status cloudflared --no-pager -l | tail -20
  die "서비스 시작 실패"
fi

# ── 7. 확인 ────────────────────────────────────────────
step "확인"
echo -e "  ${DIM}DNS 전파에 최대 1분 정도 걸립니다...${NC}"
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "https://$HOSTNAME_ARG/api/health" || true)
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then
    ok "https://$HOSTNAME_ARG 응답 (HTTP $code)"
    break
  fi
  sleep 5
done
[ "${code:-}" = "200" ] || [ "${code:-}" = "401" ] || warn "아직 응답이 없습니다 (마지막 HTTP ${code:-none}) — 1~2분 뒤 다시 확인하세요."

echo ""
echo -e "${GREEN}  완료${NC}"
echo -e "  외부 접속:  https://$HOSTNAME_ARG"
echo -e "  상태:       systemctl --user status cloudflared"
echo -e "  로그:       journalctl --user -u cloudflared -f"
echo ""
echo -e "  ${DIM}이제 portproxy 없이도 접속되므로, 원한다면 관리자 PowerShell 에서${NC}"
echo -e "  ${DIM}netsh interface portproxy reset 으로 LAN 포워딩을 정리해도 됩니다.${NC}"
echo ""
