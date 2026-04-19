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
echo "→ 서버 의존성 설치..."
npm --prefix "$REPO_ROOT" install --loglevel=error

echo "→ 클라이언트 의존성 설치..."
npm --prefix "$REPO_ROOT/client" install --loglevel=error

echo "→ 클라이언트 빌드..."
npm --prefix "$REPO_ROOT" run build

echo "✓ 번들 준비 완료"

# ── 앱 파일 복사 (node_modules·dist 포함, 로컬데이터 제외) ───
rsync -a \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='client/node_modules/.cache/' \
  --exclude='packaging/' \
  --exclude='*.pkg' \
  --exclude='sessions.json' \
  --exclude='web-metadata.json' \
  --exclude='secrets.json' \
  --exclude='backends.json' \
  --exclude='agents-config.json' \
  --exclude='hooks.json' \
  --exclude='schedules.json' \
  --exclude='projects.json' \
  --exclude='skills.json' \
  --exclude='logs/' \
  --exclude='uploads/' \
  --exclude='backups/' \
  --exclude='.migration-done' \
  --exclude='*.backup.*' \
  --exclude='.DS_Store' \
  "$REPO_ROOT/" "$STAGING/"

echo "✓ 파일 복사 완료 (node_modules + client/dist 포함)"

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
