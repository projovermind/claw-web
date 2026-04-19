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

# ⚠️ BUILD_DIR 은 반드시 APFS(macOS 네이티브 FS)에 둬야 함.
# SCRIPT_DIR 이 exFAT/FAT32/noowners 외장드라이브일 경우 chmod 가 조용히 실패해서
# pkg 설치 후 파일이 700 권한으로 잠기는 치명적 버그 발생.
# (2026-04-19 까지 10+ 릴리즈가 이 문제로 실패함 — /Volumes/Core 가 exFAT)
BUILD_DIR="/tmp/claw-web-pkg-build-$$"
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

# 서버 코드 (node_modules + client/dist 포함 — postinstall npm install 불필요)
rsync -a \
  --exclude='/client/node_modules' \
  --exclude='/.git' \
  --exclude='/dist' \
  --exclude='/pkg' \
  --exclude='*.backup-*' \
  --exclude='*.pkg' \
  --exclude='.playwright-mcp' \
  --exclude='.migration-backup-*' \
  --exclude='.vercel' \
  --exclude='.DS_Store' \
  --exclude='._*' \
  --exclude='notion-*.png' \
  --exclude='*.log' \
  --exclude='sessions.json' \
  --exclude='secrets.json' \
  --exclude='web-metadata.json' \
  --exclude='hooks.json' \
  --exclude='schedules.json' \
  --exclude='push-subscriptions.json' \
  --exclude='running-processes.json' \
  --exclude='activity.jsonl' \
  --exclude='/logs' \
  --exclude='/uploads' \
  --exclude='/backups' \
  --exclude='/tests' \
  --exclude='/docs' \
  --exclude='/packaging' \
  --exclude='/build-pkg.sh' \
  --exclude='/install.sh' \
  "$SCRIPT_DIR/" "$BUILD_DIR/payload/"

FILE_COUNT=$(find "$BUILD_DIR/payload" -type f | wc -l | tr -d ' ')
echo "   Payload: ${FILE_COUNT} files"

# 권한 정리 — 일반 유저도 읽기/실행 가능하도록 (pkg 설치 후 /usr/local/lib/claw-web 이 700 권한으로 잠기는 버그 차단)
# 디렉토리와 파일 타입별로 분리 적용해야 안정적 (macOS chmod 는 u=rwX,go=rX 조합이 타입 판정에 따라 다르게 동작)
find "$BUILD_DIR/payload" -type d -exec chmod 755 {} \;
find "$BUILD_DIR/payload" -type f -exec chmod 644 {} \;
# 실행 비트가 필요한 바이너리/스크립트는 유지 (node_modules 안의 .node, .sh 등)
find "$BUILD_DIR/payload" -type f \( -name '*.sh' -o -name '*.node' \) -exec chmod 755 {} \;

# 검증 — 실제로 chmod 가 적용됐는지 확인 (exFAT 같은 비정상 FS 에서 실패 방지)
SAMPLE=$(find "$BUILD_DIR/payload" -type f -name 'package.json' | head -1)
if [ -n "$SAMPLE" ]; then
  ACTUAL=$(stat -f '%Sp' "$SAMPLE" 2>/dev/null)
  if [ "$ACTUAL" != "-rw-r--r--" ]; then
    echo "❌ FATAL: chmod did not apply (got $ACTUAL, expected -rw-r--r--)"
    echo "   BUILD_DIR=$BUILD_DIR is on a filesystem that ignores chmod."
    echo "   Ensure BUILD_DIR is on APFS (not exFAT/FAT32)."
    exit 1
  fi
fi
echo "   Permissions: dirs=755, files=644 (verified on $SAMPLE → $ACTUAL)"

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
