#!/usr/bin/env bash
# LaunchAgent 레이블을 구버전 개인 설치본(cc.subinggrae.*) 에서
# 표준(com.claw-web.*) 으로 옮긴다. plist 파일명과 내부 Label 키를 함께 바꾸고,
# 단계마다 bootout → bootstrap 으로 다시 등록한다.
#
#   bash scripts/migrate-launchagent-labels.sh            # 드라이런 (기본, 아무것도 안 바꿈)
#   bash scripts/migrate-launchagent-labels.sh --apply    # 실제 수행
#   bash scripts/migrate-launchagent-labels.sh --only claw-web --apply
#
# 매핑:
#   cc.subinggrae.claw-web         → com.claw-web.server
#   cc.subinggrae.claw-web-update  → com.claw-web.update
#   cc.subinggrae.omniroute        → com.claw-web.omniroute
#   cc.subinggrae.cloudflared      → com.claw-web.tunnel
#
# 실패하면 그 항목은 백업본으로 되돌리고 원래 레이블로 다시 bootstrap 한다.
set -uo pipefail

LA="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
TS="$(date '+%Y%m%d-%H%M%S')"
PLISTBUDDY=/usr/libexec/PlistBuddy

APPLY=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --only) ONLY="${2:-}"; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
err()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; }
dry()  { printf '\033[90m  · (드라이런) %s\033[0m\n' "$*"; }

cat <<'BANNER'

  ⚠️  경고 — claw-web 세션 안에서 실행하지 말 것
      이 스크립트는 claw-web 서버 LaunchAgent 를 bootout/bootstrap 한다.
      claw-web 이 띄운 세션(웹 UI·위임 워커) 안에서 돌리면 자기 러너가 같이 죽어
      작업이 중간에 끊긴다. 터미널에서 직접 실행할 것.

BANNER

if [ "$(uname -s)" != "Darwin" ]; then
  err "macOS 전용이다 (launchd)."; exit 1
fi
[ -x "$PLISTBUDDY" ] || { err "PlistBuddy 가 없다: $PLISTBUDDY"; exit 1; }

if [ "$APPLY" = "1" ]; then
  warn "--apply — 실제로 변경한다."
else
  warn "드라이런이다. 실제로 바꾸려면 --apply 를 붙여라."
fi

# old:new
PAIRS=(
  "cc.subinggrae.claw-web:com.claw-web.server"
  "cc.subinggrae.claw-web-update:com.claw-web.update"
  "cc.subinggrae.omniroute:com.claw-web.omniroute"
  "cc.subinggrae.cloudflared:com.claw-web.tunnel"
)

MIGRATED=0
SKIPPED=0
FAILED=0

migrate_one() { # migrate_one <old-label> <new-label>
  local old="$1" new="$2"
  local oldp="$LA/$old.plist" newp="$LA/$new.plist"
  local backup="$oldp.bak.$TS"

  step "$old → $new"

  if [ ! -f "$oldp" ]; then
    warn "구 plist 없음 — 건너뜀 ($oldp)"; SKIPPED=$((SKIPPED+1)); return 0
  fi
  if [ -f "$newp" ]; then
    warn "표준 plist 가 이미 있다 — 건너뜀 (중복 등록 방지: $newp)"; SKIPPED=$((SKIPPED+1)); return 0
  fi

  if [ "$APPLY" != "1" ]; then
    dry "cp '$oldp' '$backup'"
    dry "launchctl bootout $DOMAIN/$old"
    dry "plist 복사 + 내부 Label → $new  ($newp)"
    dry "rm '$oldp'"
    dry "launchctl bootstrap $DOMAIN '$newp'"
    MIGRATED=$((MIGRATED+1)); return 0
  fi

  cp -p "$oldp" "$backup" || { err "백업 실패 — 중단"; FAILED=$((FAILED+1)); return 1; }
  ok "백업 $backup"

  # 1) 새 plist 를 먼저 만들어 둔다 (내부 Label 키까지 치환)
  cp -p "$oldp" "$newp" || { err "복사 실패"; rm -f "$newp"; FAILED=$((FAILED+1)); return 1; }
  if ! "$PLISTBUDDY" -c "Set :Label $new" "$newp" 2>/dev/null; then
    if ! "$PLISTBUDDY" -c "Add :Label string $new" "$newp" 2>/dev/null; then
      err "Label 키 치환 실패"; rm -f "$newp"; FAILED=$((FAILED+1)); return 1
    fi
  fi
  ok "plist 생성 + Label=$new"

  # 2) 구 레이블 내리기 (등록돼 있지 않아도 진행)
  launchctl bootout "$DOMAIN/$old" 2>/dev/null && ok "bootout $old" || warn "bootout $old — 등록돼 있지 않았음"

  # 3) 구 plist 치우고 새 레이블로 올리기
  rm -f "$oldp"
  if launchctl bootstrap "$DOMAIN" "$newp" 2>/dev/null && launchctl print "$DOMAIN/$new" >/dev/null 2>&1; then
    ok "bootstrap $new"
    MIGRATED=$((MIGRATED+1)); return 0
  fi

  # 4) 실패 — 원래대로 되돌린다
  err "bootstrap 실패 — 원복한다"
  launchctl bootout "$DOMAIN/$new" 2>/dev/null
  rm -f "$newp"
  cp -p "$backup" "$oldp" || err "원복 실패! 백업을 손으로 되돌려라: $backup"
  if launchctl bootstrap "$DOMAIN" "$oldp" 2>/dev/null; then
    ok "원복 완료 — $old 로 다시 등록됨"
  else
    err "원복 bootstrap 실패 — 손으로 확인: launchctl bootstrap $DOMAIN '$oldp'"
  fi
  FAILED=$((FAILED+1)); return 1
}

for pair in "${PAIRS[@]}"; do
  old="${pair%%:*}"; new="${pair##*:}"
  if [ -n "$ONLY" ] && [ "$old" != "$ONLY" ] && [ "$new" != "$ONLY" ] && [ "${old#cc.subinggrae.}" != "$ONLY" ]; then
    continue
  fi
  migrate_one "$old" "$new"
done

step "요약"
if [ "$APPLY" = "1" ]; then
  echo "  이동 $MIGRATED · 건너뜀 $SKIPPED · 실패 $FAILED"
else
  echo "  이동 예정 $MIGRATED · 건너뜀 $SKIPPED   (드라이런 — 아무것도 바꾸지 않았다)"
  echo "  실제 수행: bash $0 --apply"
fi
[ "$FAILED" -eq 0 ] || exit 1
