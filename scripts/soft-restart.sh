#!/usr/bin/env bash
# scripts/soft-restart.sh
# 소프트 재시작: .soft-restart 플래그 기록 후 서버 재시작
# 사용법: ./scripts/soft-restart.sh [source]
#   source: 재시작 이유 힌트 (예: delegation-cli, agent-triggered)
#           이 값이 delegation-cli/agent-triggered 이면 boot 시 autoResume 억제됨

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIR="$REPO_ROOT/logs"
SOFT_RESTART_FLAG="$LOGS_DIR/.soft-restart"
SOURCE="${1:-manual}"

mkdir -p "$LOGS_DIR"

# .soft-restart 플래그 기록
cat > "$SOFT_RESTART_FLAG" <<JSON
{"at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","source":"$SOURCE"}
JSON

echo "soft-restart flag written (source=$SOURCE)"

# 서버 재시작: API 호출 시도 → 실패 시 SIGTERM
if curl -sf -X POST \
    -H "Content-Type: application/json" \
    -d '{"force":false}' \
    "http://localhost:3838/api/admin/restart" \
    -o /dev/null; then
  echo "restart requested via API"
else
  echo "API unreachable — sending SIGTERM to server process"
  PID=$(lsof -ti tcp:3838 2>/dev/null | head -1 || true)
  if [ -n "$PID" ]; then
    kill -TERM "$PID"
    echo "SIGTERM sent to PID $PID"
  else
    echo "No process found on port 3838"
    exit 1
  fi
fi
