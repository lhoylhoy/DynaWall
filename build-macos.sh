#!/bin/bash
#
# Build DynaWall.app — the native macOS live wallpaper host.
#
#   ./build-macos.sh
#
# Produces an ad-hoc signed, single-architecture (arm64 or x86_64, whichever is
# running here) bundle at dist/DynaWall.app, targeted at macOS 12+.
#
# Requirements: macOS 12+ with the Xcode Command Line Tools (`xcode-select --install`).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="DynaWall"
MIN_MACOS="12.0"
DIST_DIR="$ROOT/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_BIN="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: swiftc not found. Install the Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

for asset in index.html style.css script.js \
  assets/fonts/outfit-latin.woff2; do
  if [[ ! -f "$ROOT/$asset" ]]; then
    echo "error: missing web wallpaper asset: $asset" >&2
    exit 1
  fi
done

for photo in "$ROOT"/images/*.jpg; do
  if [[ ! -f "$photo" ]]; then
    echo "error: the bundled slideshow photos are missing (images/*.jpg)" >&2
    exit 1
  fi
done

echo "==> Cleaning $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_BIN" "$RESOURCES"

if [[ ! -f "$ROOT/macos/AppIcon.icns" || "$ROOT/macos/make-icon.swift" -nt "$ROOT/macos/AppIcon.icns" ]]; then
  echo "==> Generating AppIcon.icns"
  swift -module-cache-path /tmp/swift-module-cache "$ROOT/macos/make-icon.swift" "$ROOT/macos"
fi

echo "==> Compiling for $(uname -m)"
swiftc -parse-as-library -swift-version 5 -O \
  -module-cache-path /tmp/swift-module-cache \
  -target "$(uname -m)-apple-macos$MIN_MACOS" \
  -framework AppKit -framework WebKit -framework SwiftUI \
  "$ROOT/macos/DynaWallApp.swift" \
  -o "$MACOS_BIN/$APP_NAME"

echo "==> Assembling the app bundle"
cp "$ROOT/macos/Info.plist" "$CONTENTS/Info.plist"
cp "$ROOT/macos/AppIcon.icns" "$RESOURCES/AppIcon.icns"
cp "$ROOT/index.html" "$ROOT/style.css" "$ROOT/script.js" "$RESOURCES/"
cp -R "$ROOT/assets" "$RESOURCES/"
cp -R "$ROOT/images" "$RESOURCES/"
printf 'APPL????' > "$CONTENTS/PkgInfo"

echo "==> Signing (ad-hoc)"
codesign --force --sign - --timestamp=none "$APP_BUNDLE"
codesign --verify --verbose=2 "$APP_BUNDLE"

echo "==> Built $APP_BUNDLE"
echo "    Launch with: open $APP_BUNDLE"
