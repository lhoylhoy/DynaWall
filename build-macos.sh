#!/bin/bash
#
# Build DynaWall.app — the native macOS live wallpaper host.
#
#   ./build-macos.sh
#
# Produces an ad-hoc signed Universal 2 bundle at dist/DynaWall.app: an arm64 slice
# for Apple silicon and an x86_64 slice for Intel Macs, merged with `lipo`. macOS
# refuses to translate an arm64-only app on Intel hardware (Rosetta 2 goes the other
# way), so a single-architecture DMG built on the arm64 release runner would simply
# not launch on an Intel Mac.
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
# 5K time-of-day pictures plus the six generated abstracts. The macOS host seeds
# these into ~/Pictures/DynaWall the first time that folder is created, so the app
# has wallpapers to rotate before the user picks a folder. `images/` also holds
# 4K/5K/HEIC/Light-Dark duplicates of the same six Golden Gate scenes (~13.5 MB)
# that no collection ever rotates through, so they are deliberately left out.
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

for tool in swiftc lipo xcrun; do
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

for asset in index.html style.css script.js "${FONT_ASSETS[@]}" macos/DynaWall.entitlements; do
  if [[ ! -f "$ROOT/$asset" ]]; then
    echo "error: missing build input: $asset" >&2
    exit 1
  fi
done

for photo in "${CURATED_PHOTOS[@]}"; do
  if [[ ! -f "$ROOT/images/$photo" ]]; then
    echo "error: missing curated wallpaper: images/$photo" >&2
    exit 1
  fi
done

# Universal 2, and the toolchain has to be able to link every slice before anything is
# written: a preflight failure must leave the previous dist/DynaWall.app untouched.
#
# DYNAWALL_ARCHS="arm64" builds a single slice for a quick local iteration. The release
# path (build-dmg.sh and CI) always builds both and fails if either slice is missing.
#
# One whole-module optimisation pass per slice (the single source file can be inlined
# and specialised as a unit, and unused generic/SwiftUI shims are dropped by the
# linker) rather than per-file -O, then `lipo` stitches the slices into a fat binary.
ARCHS="${DYNAWALL_ARCHS:-arm64 x86_64}"
[[ -n "$ARCHS" ]] || ARCHS="$(uname -m)"
BUILD_DIR="$DIST_DIR/bin"

# A toolchain can describe a target it cannot link: the Swift compatibility libraries
# have to carry a slice for that architecture too. Apple's newest Command Line Tools
# ship them for arm64 only, and `-target x86_64-…` then dies inside the linker with a
# `__swift_FORCE_LOAD_$_swiftCompatibility56` dump. Catch that up front and say what to
# do, instead of letting the linker explain it.
SWIFT_LIB_DIR="$(cd "$(dirname "$(xcrun --find swiftc)")/../lib/swift/macosx" 2>/dev/null && pwd || true)"
for arch in $ARCHS; do
  compat="$SWIFT_LIB_DIR/libswiftCompatibility56.a"
  if [[ -f "$compat" ]] && ! lipo -archs "$compat" | tr ' ' '\n' | grep -qx "$arch"; then
    echo "error: this toolchain cannot link $arch (libswiftCompatibility56.a has: $(lipo -archs "$compat"))" >&2
    echo "       install a full Xcode, or build one slice with: DYNAWALL_ARCHS=\"$(uname -m)\" $0" >&2
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

echo "==> Compiling for $ARCHS (Universal 2)"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

SLICES=()
for arch in $ARCHS; do
  echo "    - $arch"
  swiftc -parse-as-library -swift-version 5 -O -whole-module-optimization \
    -module-cache-path "/tmp/dynawall-swift-module-cache/$arch" \
    -target "$arch-apple-macos$MIN_MACOS" \
    -framework AppKit -framework WebKit -framework SwiftUI -framework ServiceManagement \
    -Xlinker -dead_strip \
    "$ROOT/macos/DynaWallApp.swift" \
    -o "$BUILD_DIR/$APP_NAME-$arch"
  SLICES+=("$BUILD_DIR/$APP_NAME-$arch")
done

if [[ ${#SLICES[@]} -gt 1 ]]; then
  lipo -create "${SLICES[@]}" -output "$MACOS_BIN/$APP_NAME"
else
  cp "${SLICES[0]}" "$MACOS_BIN/$APP_NAME"
fi
rm -rf "$BUILD_DIR"

echo "==> Assembling the app bundle"
cp "$ROOT/macos/Info.plist" "$CONTENTS/Info.plist"
cp "$ROOT/macos/AppIcon.icns" "$RESOURCES/AppIcon.icns"
cp "$ROOT/index.html" "$ROOT/style.css" "$ROOT/script.js" "$RESOURCES/"
cp -R "$ROOT/assets" "$RESOURCES/"
for photo in "${CURATED_PHOTOS[@]}"; do
  cp "$ROOT/images/$photo" "$RESOURCES/images/"
done
printf 'APPL????' > "$CONTENTS/PkgInfo"

BUILT_ARCHS="$(lipo -archs "$MACOS_BIN/$APP_NAME")"
for arch in $ARCHS; do
  if [[ " $BUILT_ARCHS " != *" $arch "* ]]; then
    echo "error: the $arch slice is missing from $MACOS_BIN/$APP_NAME ($BUILT_ARCHS)" >&2
    exit 1
  fi
done

echo "==> Signing (ad-hoc, hardened runtime)"
# `--options runtime` turns on the hardened runtime, so the kernel itself enforces the
# platform's protections (library validation, W^X, no DYLD_* injection) for the whole
# process — including anything that would otherwise be injected into the host that
# holds the WebKit message handlers. The ad-hoc identity stays: DynaWall ships
# un-notarised, and `--entitlements` is what keeps the macOS 12 login-item fallback
# able to talk to System Events under that runtime.
codesign --force --sign - --options runtime \
  --entitlements "$ROOT/macos/DynaWall.entitlements" \
  --timestamp=none "$APP_BUNDLE"
codesign --verify --verbose=2 "$APP_BUNDLE"

echo "==> Built $APP_BUNDLE ($BUILT_ARCHS)"
echo "    Launch with: open $APP_BUNDLE"
