#!/usr/bin/env bash
# build-pkg.sh — Claw Web macOS .pkg 빌드
# 사용법: cd packaging && ./build-pkg.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=$(node -e "console.log(require('$REPO_ROOT/package.json').version)")
PKG_NAME="claw-web-$VERSION.pkg"
STAGING="$SCRIPT_DIR/.staging"
INSTALL_LOCATION="/usr/local/share/claw-web"

echo ""
echo "  🦞 Claw Web PKG 빌드"
echo "  버전: $VERSION"
echo "  출력: $REPO_ROOT/$PKG_NAME"
echo ""

# ── pkgbuild 확인 ──────────────────────────────────────────
if ! command -v pkgbuild &>/dev/null; then
  echo "✗ pkgbuild 없음. Xcode Command Line Tools 필요:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

# ── rsync 확인 ─────────────────────────────────────────────
if ! command -v rsync &>/dev/null; then
  echo "✗ rsync 없음" >&2
  exit 1
fi

# ── 스테이징 초기화 ────────────────────────────────────────
echo "→ 스테이징 디렉토리 준비..."
rm -rf "$STAGING"
mkdir -p "$STAGING"

# ── 의존성 설치 및 클라이언트 빌드 (번들링) ──────────────────
# 주의: dev deps (tsc, vite) 가 빌드에 필요하므로 --include=dev 로 설치.
# 최종 pkg 에는 서버 쪽만 prod 의존성으로 남기고, client 는 dist 만 포함 (node_modules 불필요).
echo "→ 서버 의존성 설치 (dev 포함, 빌드용)..."
NODE_ENV=development npm --prefix "$REPO_ROOT" install --include=dev --loglevel=error

echo "→ 클라이언트 의존성 설치 (dev 포함)..."
NODE_ENV=development npm --prefix "$REPO_ROOT/client" install --include=dev --loglevel=error

echo "→ 클라이언트 빌드 (tsc + vite)..."
NODE_ENV=development npm --prefix "$REPO_ROOT" run build

echo "→ 서버 의존성 prod 모드로 정리..."
npm --prefix "$REPO_ROOT" prune --omit=dev --loglevel=error

echo "✓ 번들 준비 완료 (서버: prod only, 클라이언트: dist)"

# ── 앱 파일 복사 (화이트리스트 방식 — 허용된 것만 복사) ──────
# 보안상 블랙리스트 방식 금지. 명시된 것만 staging 으로 복사한다.
echo "→ 화이트리스트 방식으로 파일 복사..."

# 필수 디렉토리 복사 (있는 것만)
for dir in server client/dist node_modules client/public deploy; do
  if [ -d "$REPO_ROOT/$dir" ]; then
    mkdir -p "$STAGING/$(dirname $dir)"
    rsync -a \
      --exclude='.DS_Store' \
      --exclude='*.log' \
      --exclude='*.backup-*' \
      --exclude='*.backup.*' \
      "$REPO_ROOT/$dir/" "$STAGING/$dir/"
  fi
done

# 필수 파일 복사 (있는 것만)
for f in package.json package-lock.json install.sh README.md CLAUDE.md .gitignore vitest.config.js client/package.json client/package-lock.json client/vite.config.ts client/tsconfig.json client/tsconfig.node.json client/index.html client/tailwind.config.js client/postcss.config.js; do
  if [ -f "$REPO_ROOT/$f" ]; then
    mkdir -p "$STAGING/$(dirname $f)"
    cp "$REPO_ROOT/$f" "$STAGING/$f"
  fi
done

echo "✓ 화이트리스트 복사 완료"

# ── 민감 파일 감지 검증 (빌드 실패 조건) ───────────────────
echo "→ 민감 파일 감지 검증..."
LEAK_PATTERNS=(
  'sessions.json'
  'web-metadata.json'
  'secrets.json'
  'backends.json'
  'agents-config.json'
  'hooks.json'
  'schedules.json'
  'projects.json'
  'skills.json'
  'web-config.json'
  'push-subscriptions.json'
  '.env'
  '.env.local'
  '.claude'
  '.vercel'
  '.playwright-mcp'
  'snapshot*.md'
  'snapshot*.txt'
  'test-*.png'
  'notion-*.png'
  '*.backup-*'
  '*.backup.*'
  '.migration-backup-*'
  '.migration-done'
  'logs'
  'uploads'
  'backups'
)
LEAKS_FOUND=0
for pattern in "${LEAK_PATTERNS[@]}"; do
  # grep -v 가 매치 없을 때 exit 1 → set -e + pipefail 로 스크립트 중단되는 문제 회피
  matches=$(find "$STAGING" -name "$pattern" 2>/dev/null | { grep -v node_modules || true; })
  if [ -n "$matches" ]; then
    echo "  ⚠️ 민감 파일 발견 ($pattern):"
    echo "$matches" | sed 's/^/     /'
    LEAKS_FOUND=$((LEAKS_FOUND + 1))
  fi
done

if [ "$LEAKS_FOUND" -gt 0 ]; then
  echo ""
  echo "✗ 빌드 중단: $LEAKS_FOUND 개 민감 패턴 감지. staging 검토 필요." >&2
  echo "  staging: $STAGING" >&2
  exit 1
fi

echo "✓ 민감 파일 없음 — 안전 확인"

# ── 스크립트 실행 권한 부여 ────────────────────────────────
chmod +x "$SCRIPT_DIR/scripts/preinstall"
chmod +x "$SCRIPT_DIR/scripts/postinstall"

# ── pkgbuild ───────────────────────────────────────────────
echo "→ pkgbuild 실행..."
pkgbuild \
  --root "$STAGING" \
  --install-location "$INSTALL_LOCATION" \
  --scripts "$SCRIPT_DIR/scripts" \
  --identifier "com.claw-web.server" \
  --version "$VERSION" \
  "$REPO_ROOT/$PKG_NAME"

# ── 정리 ───────────────────────────────────────────────────
rm -rf "$STAGING"

echo ""
echo "  ✓ 빌드 완료: $PKG_NAME"
echo ""
echo "  설치 방법:"
echo "    더블클릭: open '$REPO_ROOT/$PKG_NAME'"
echo "    CLI:      sudo installer -pkg '$REPO_ROOT/$PKG_NAME' -target /"
echo ""
echo "  설치 후 접속: http://localhost:3838"
echo "  설치 로그:    tail -f /tmp/claw-web-install.log"
echo ""
