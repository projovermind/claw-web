#!/bin/bash
# ╔═══════════════════════════════════════════════╗
# ║     🦞 Claw Web — macOS .pkg Builder          ║
# ╚═══════════════════════════════════════════════╝
#
# Usage: ./build-pkg.sh
# Output: dist/Claw-Web-1.0.0.pkg

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# package.json 에서 자동 추출 (매번 수정 필요 없음)
VERSION=$(node -p "require('./package.json').version")
PKG_ID="com.claw-web"
INSTALL_LOCATION="/usr/local/lib/claw-web"

BUILD_DIR="$SCRIPT_DIR/dist/pkg-build"
OUTPUT_DIR="$SCRIPT_DIR/dist"

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║  Building Claw Web v${VERSION} .pkg               ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# ── 1. 클린업 ─────────────────────────────────────────────
echo "→ [1/4] Preparing build directory..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/payload" "$BUILD_DIR/scripts" "$OUTPUT_DIR"

# ── 2. payload 구성 ───────────────────────────────────────
echo "→ [2/4] Assembling payload..."

# 서버 코드
rsync -a \
  --exclude='node_modules' \
  --exclude='client/node_modules' \
  --exclude='client/dist' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='pkg' \
  --exclude='*.backup-*' \
  --exclude='sessions.json' \
  --exclude='secrets.json' \
  --exclude='web-metadata.json' \
  --exclude='hooks.json' \
  --exclude='schedules.json' \
  --exclude='logs' \
  --exclude='uploads' \
  --exclude='backups' \
  --exclude='build-pkg.sh' \
  --exclude='install.sh' \
  "$SCRIPT_DIR/" "$BUILD_DIR/payload/"

FILE_COUNT=$(find "$BUILD_DIR/payload" -type f | wc -l | tr -d ' ')
echo "   Payload: ${FILE_COUNT} files"

# ── 3. 스크립트 복사 ──────────────────────────────────────
cp pkg/scripts/preinstall "$BUILD_DIR/scripts/"
cp pkg/scripts/postinstall "$BUILD_DIR/scripts/"
chmod +x "$BUILD_DIR/scripts/preinstall" "$BUILD_DIR/scripts/postinstall"

# ── 4. pkgbuild → 코어 패키지 ─────────────────────────────
echo "→ [3/4] Building core package (pkgbuild)..."

pkgbuild \
    --root "$BUILD_DIR/payload" \
    --scripts "$BUILD_DIR/scripts" \
    --identifier "$PKG_ID" \
    --version "$VERSION" \
    --install-location "$INSTALL_LOCATION" \
    "$BUILD_DIR/claw-web-core.pkg"

echo "   Core: $(du -sh "$BUILD_DIR/claw-web-core.pkg" | cut -f1)"

# ── 5. productbuild → 최종 .pkg ───────────────────────────
echo "→ [4/4] Building installer package (productbuild)..."

# {{VERSION}} placeholder 치환본 생성 (pkg/ 원본은 git clean 유지)
PKG_TMP="$BUILD_DIR/pkg-tmp"
mkdir -p "$PKG_TMP/resources"
cp pkg/resources/* "$PKG_TMP/resources/"
sed "s/{{VERSION}}/$VERSION/g" pkg/distribution.xml > "$PKG_TMP/distribution.xml"
sed -i '' "s/{{VERSION}}/$VERSION/g" "$PKG_TMP/resources/welcome.html"

productbuild \
    --distribution "$PKG_TMP/distribution.xml" \
    --resources "$PKG_TMP/resources" \
    --package-path "$BUILD_DIR" \
    "$OUTPUT_DIR/Claw-Web-${VERSION}.pkg"

# ── 완료 ──────────────────────────────────────────────────
PKG_SIZE=$(du -sh "$OUTPUT_DIR/Claw-Web-${VERSION}.pkg" | cut -f1)

rm -rf "$BUILD_DIR"

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║  ✅ Build complete!                           ║"
echo "╠═══════════════════════════════════════════════╣"
echo "║                                               ║"
echo "║  Output: dist/Claw-Web-${VERSION}.pkg           ║"
echo "║  Size:   ${PKG_SIZE}                              ║"
echo "║                                               ║"
echo "║  Install:                                     ║"
echo "║    open dist/Claw-Web-${VERSION}.pkg             ║"
echo "║                                               ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""
