#!/usr/bin/env bash
# scripts/soft-restart.sh
# 소프트 재시작: .soft-restart 플래그 기록 후 서버 재시작
# 사용법: ./scripts/soft-restart.sh [source]
#   source: 재시작 이유 힌트 (예: delegation-cli, agent-triggered)
#           이 값이 delegation-cli/agent-triggered 이면 boot 시 autoResume 억제됨

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIR="$REPO_ROOT/data/user/logs"  # index.js·admin/restart.js 와 동일 위치
SOFT_RESTART_FLAG="$LOGS_DIR/.soft-restart"
# JSON 두 군데(플래그 파일·API 본문)에 그대로 들어가므로 영숫자/-/_ 만 남긴다.
SOURCE="$(printf %s "${1:-manual}" | tr -cd 'A-Za-z0-9_-' | cut -c1-64)"
[ -n "$SOURCE" ] || SOURCE="manual"

mkdir -p "$LOGS_DIR"

# .soft-restart 플래그 기록
cat > "$SOFT_RESTART_FLAG" <<JSON
{"at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","source":"$SOURCE"}
JSON

echo "soft-restart flag written (source=$SOURCE)"


# 서버 재시작: API 호출 시도 → 실패 시 SIGTERM
#
# auth 가 켜져 있으면 /api/admin/restart 는 Bearer 토큰을 요구한다. 헤더 없이
# 부르면 401 → curl -sf 실패 → 매번 아래 SIGTERM 경로로 떨어진다.
# 토큰은 gitignore 된 운영 config 에서 읽는다 — 스크립트에 박아 커밋하지 않는다.
TOKEN="$(node -e '
  const fs = require("node:fs");
  try {
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (cfg?.auth?.enabled !== false && cfg?.auth?.token) process.stdout.write(String(cfg.auth.token));
  } catch { /* config 없음 = auth 미설정 */ }
' "$REPO_ROOT/data/private/web-config.json" 2>/dev/null || true)"

restart_via_api() {
  if [ -n "$TOKEN" ]; then
    curl -sf -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TOKEN" \
      -d "{\"force\":false,\"source\":\"$SOURCE\"}" \
      "http://localhost:3838/api/admin/restart" -o /dev/null
  else
    curl -sf -X POST \
      -H "Content-Type: application/json" \
      -d "{\"force\":false,\"source\":\"$SOURCE\"}" \
      "http://localhost:3838/api/admin/restart" -o /dev/null
  fi
}

if restart_via_api; then
  echo "restart requested via API"
else
  echo "API unreachable — sending SIGTERM to server process"
  # -sTCP:LISTEN 필수: 이게 없으면 3838 로 연결된 소켓(cloudflared 등)까지 잡혀
  # 엉뚱한 프로세스에 SIGTERM 이 간다. 실제로 터널을 죽인 적이 있다.
  PID=$(lsof -ti tcp:3838 -sTCP:LISTEN 2>/dev/null | head -1 || true)
  if [ -n "$PID" ]; then
    COMM=$(ps -p "$PID" -o comm= 2>/dev/null || true)
    case "$COMM" in
      *node*) ;;
      *) echo "Port 3838 listener is not node ($COMM) — aborting"; exit 1 ;;
    esac
    kill -TERM "$PID"
    echo "SIGTERM sent to PID $PID ($COMM)"
  else
    echo "No process found on port 3838"
    exit 1
  fi
fi
