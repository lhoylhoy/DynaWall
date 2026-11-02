#!/bin/bash
#
# Build DynaWall.app — the native macOS live wallpaper host.
#
#   ./build-macos.sh
#
# Produces an ad-hoc signed bundle at dist/DynaWall.app, targeted at macOS 12+ and
# built for the Mac running the script (the release DMG is built on an Apple
# silicon runner; an Intel Mac runs `./build-macos.sh` itself).
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

# The twelve curated wallpapers that ship inside the bundle: the six Golden Gate
# 5K time-of-day pictures plus the six generated abstracts. `images/` also holds
# 4K/5K/HEIC/Light-Dark duplicates of the same six Golden Gate scenes (~13.5 MB)
# that no collection ever rotates through, so they are deliberately left out —
# keep this list in sync with GOLDEN_GATE_PHOTOS + ABSTRACT_PHOTOS in script.js
# (tests/verify.cjs asserts it).
CURATED_PHOTOS=(
  "iClarified-macOS-27-Golden-Gate-Wallpaper-5K-Light.jpg"
  "iClarified-macOS-27-Golden-Gate-Day-Wallpaper.jpg"
  "iClarified-macOS-27-Golden-Gate-Sunset-Wallpaper.jpg"
  "iClarified-macOS-27-Golden-Gate-Evening-Wallpaper.jpg"
  "iClarified-macOS-27-Golden-Gate-Night-Wallpaper.jpg"
  "iClarified-macOS-27-Golden-Gate-Wallpaper-5K-Dark.jpg"
  "01-neon-dusk.jpg"
  "02-solar-flare.jpg"
  "03-deep-ocean.jpg"
  "04-mint-fog.jpg"
  "05-candy-sky.jpg"
  "06-graphite.jpg"
)

for tool in swiftc lipo; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found. Install the Xcode Command Line Tools: xcode-select --install" >&2
    exit 1
  fi
done

# Every bundled face ships in two forms: the latin WOFF2 the page loads through
# @font-face and the static Regular/SemiBold TTFs the popover registers so each
# preset previews in its own typeface. Keep this list in step with
# BUNDLED_FONT_FAMILIES in script.js.
FONT_ASSETS=()
for font in outfit google-sans-flex space-grotesk geist; do
  FONT_ASSETS+=(
    "assets/fonts/$font-latin.woff2"
    "assets/fonts/$font-regular.ttf"
    "assets/fonts/$font-semibold.ttf"
  )
done

for asset in index.html style.css script.js "${FONT_ASSETS[@]}"; do
  if [[ ! -f "$ROOT/$asset" ]]; then
    echo "error: missing web wallpaper asset: $asset" >&2
    exit 1
  fi
done

for photo in "${CURATED_PHOTOS[@]}"; do
  if [[ ! -f "$ROOT/images/$photo" ]]; then
    echo "error: missing curated wallpaper: images/$photo" >&2
    exit 1
  fi
done

echo "==> Cleaning $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_BIN" "$RESOURCES/images"

if [[ ! -f "$ROOT/macos/AppIcon.icns" || "$ROOT/macos/make-icon.swift" -nt "$ROOT/macos/AppIcon.icns" ]]; then
  echo "==> Generating AppIcon.icns"
  swift -module-cache-path /tmp/swift-module-cache "$ROOT/macos/make-icon.swift" "$ROOT/macos"
fi

# One whole-module optimisation pass (the single source file can be inlined and
# specialised as a unit, and unused generic/SwiftUI shims are dropped by the
# linker) rather than per-file -O.
echo "==> Compiling for $(uname -m)"
swiftc -parse-as-library -swift-version 5 -O -whole-module-optimization \
  -module-cache-path /tmp/swift-module-cache \
  -target "$(uname -m)-apple-macos$MIN_MACOS" \
  -framework AppKit -framework WebKit -framework SwiftUI -framework ServiceManagement \
  -Xlinker -dead_strip \
  "$ROOT/macos/DynaWallApp.swift" \
  -o "$MACOS_BIN/$APP_NAME"

echo "==> Assembling the app bundle"
cp "$ROOT/macos/Info.plist" "$CONTENTS/Info.plist"
cp "$ROOT/macos/AppIcon.icns" "$RESOURCES/AppIcon.icns"
cp "$ROOT/index.html" "$ROOT/style.css" "$ROOT/script.js" "$RESOURCES/"
cp -R "$ROOT/assets" "$RESOURCES/"
for photo in "${CURATED_PHOTOS[@]}"; do
  cp "$ROOT/images/$photo" "$RESOURCES/images/"
done
printf 'APPL????' > "$CONTENTS/PkgInfo"

echo "==> Signing (ad-hoc)"
codesign --force --sign - --timestamp=none "$APP_BUNDLE"
codesign --verify --verbose=2 "$APP_BUNDLE"

echo "==> Built $APP_BUNDLE ($(lipo -archs "$MACOS_BIN/$APP_NAME"))"
echo "    Launch with: open $APP_BUNDLE"
