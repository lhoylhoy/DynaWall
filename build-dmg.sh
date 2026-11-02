#!/bin/bash
#
# Build DynaWall.dmg — the distributable macOS disk image.
#
#   ./build-dmg.sh
#
# Runs ./build-macos.sh for a fresh, ad-hoc signed dist/DynaWall.app, then stages
# that bundle next to an /Applications symlink and packs the folder into a
# compressed read-only image with the built-in hdiutil:
#
#   dist/dmg_root/DynaWall.app        the app
#   dist/dmg_root/Applications -> /Applications   the drag-and-drop target
#   dist/DynaWall.dmg                 UDZO image (zlib-compressed, read-only)
#
# Requirements: macOS 12+, Xcode Command Line Tools (`xcode-select --install`).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="DynaWall"
DIST_DIR="$ROOT/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
DMG="$DIST_DIR/$APP_NAME.dmg"
STAGE="$DIST_DIR/dmg_root"
VOLUME_NAME="$APP_NAME"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: build-dmg.sh runs on macOS only (it needs hdiutil and codesign)" >&2
  exit 1
fi

for tool in hdiutil codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found; install the Xcode Command Line Tools: xcode-select --install" >&2
    exit 1
  fi
done

# Staging is temporary; never leave a half-built tree behind after a failure.
cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT

echo "==> Building $APP_NAME.app"
"$ROOT/build-macos.sh"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "error: $APP_BUNDLE was not produced by build-macos.sh" >&2
  exit 1
fi

echo "==> Staging the disk image"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP_BUNDLE" "$STAGE/"
# The drag-and-drop installer: DynaWall.app on the left, Applications on the right.
ln -s /Applications "$STAGE/Applications"
# A mounted volume is a Finder window too; keep the source tree's metadata out.
find "$STAGE" -name .DS_Store -delete 2>/dev/null || true

echo "==> Creating $DMG (UDZO)"
rm -f "$DMG"
hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG"

echo "==> Signing the disk image (ad-hoc)"
# The app inside is already ad-hoc signed by build-macos.sh; signing the image
# itself keeps Gatekeeper from reporting a damaged download when the DMG is
# copied between Macs. It is still an unsigned distribution, so macOS asks for
# a one-time right-click → Open on first launch.
codesign --force --sign - --timestamp=none "$DMG"
codesign --verify --verbose=2 "$DMG"

SIZE="$(du -h "$DMG" | awk '{print $1}')"
echo "==> Built $DMG ($SIZE)"
echo "    Open it with: open $DMG"
