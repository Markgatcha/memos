#!/usr/bin/env bash
# Package MemOS Desktop as MemOS.app + MemOS-Desktop.dmg.
# Run from apps/desktop-gpui after `cargo build --release` on macOS.
set -euo pipefail

cd "$(dirname "$0")/../.."

APP_NAME="MemOS"
BIN="target/release/memos-desktop"
APP_DIR="target/release/${APP_NAME}.app"
DMG="target/release/MemOS-Desktop.dmg"
ICONSET="target/release/memos-desktop.iconset"
ICON_SRC="packaging/linux/icons/memos-desktop-512.png"

[ -f "$BIN" ] || { echo "missing $BIN; run cargo build --release first" >&2; exit 1; }

rm -rf "$APP_DIR" "$DMG" "$ICONSET"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" "$ICONSET"

cp "$BIN" "$APP_DIR/Contents/MacOS/memos-desktop"
cp packaging/macos/Info.plist "$APP_DIR/Contents/Info.plist"

for entry in "icon_16x16 16" "icon_16x16@2x 32" "icon_32x32 32" "icon_32x32@2x 64" \
    "icon_128x128 128" "icon_128x128@2x 256" "icon_256x256 256" "icon_256x256@2x 512" \
    "icon_512x512 512" "icon_512x512@2x 1024"; do
    name="${entry%% *}"
    px="${entry##* }"
    sips -z "$px" "$px" "$ICON_SRC" --out "$ICONSET/${name}.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP_DIR/Contents/Resources/memos-desktop.icns"

# Ad-hoc signature so macOS treats the bundle consistently. Distribution
# outside the developer's machine needs a Developer ID cert + notarization.
codesign --force --deep --sign - "$APP_DIR"

hdiutil create -volname "$APP_NAME" -srcfolder "$APP_DIR" -ov -format UDZO "$DMG"
echo "wrote $DMG"
