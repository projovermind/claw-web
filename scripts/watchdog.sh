#!/bin/bash
# claw-web 헬스체크 워치독
# 30초 간격으로 localhost:3838 응답 확인
# 연속 2회 실패 시 → 좀비 프로세스 SIGKILL → launchd가 즉시 재시작

PORT=3838
FAIL_COUNT=0
MAX_FAIL=2
TIMEOUT=5

check_health() {
  curl -sf --max-time $TIMEOUT "http://localhost:$PORT/api/health" > /dev/null 2>&1 \
    || curl -sf --max-time $TIMEOUT "http://localhost:$PORT/" > /dev/null 2>&1
}

while true; do
  if check_health; then
    FAIL_COUNT=0
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "[$(date -u +%H:%M:%S)] health check FAILED ($FAIL_COUNT/$MAX_FAIL)"

    if [ "$FAIL_COUNT" -ge "$MAX_FAIL" ]; then
      echo "[$(date -u +%H:%M:%S)] ZOMBIE DETECTED — sending SIGKILL to claw-web"
      PIDS=$(lsof -ti :$PORT 2>/dev/null)
      if [ -n "$PIDS" ]; then
        echo "Killing PIDs: $PIDS"
        kill -9 $PIDS 2>/dev/null
      fi
      # launchd가 KeepAlive로 재시작할 때까지 잠시 대기
      FAIL_COUNT=0
      sleep 10
    fi
  fi
  sleep 30
done
