#!/usr/bin/env bash
set -euo pipefail

BUILD_DIR="build"
ZIP_NAME="traker-extension.zip"

rm -rf "$BUILD_DIR" "$ZIP_NAME"
mkdir -p "$BUILD_DIR"

# Copy all extension files
cp extension/manifest.json "$BUILD_DIR/manifest.json"
cp extension/config.js "$BUILD_DIR/config.js"
cp extension/popup.html "$BUILD_DIR/popup.html"
cp extension/popup.js "$BUILD_DIR/popup.js"
cp extension/popup-avatar.js "$BUILD_DIR/"
cp extension/background.js "$BUILD_DIR/background.js"
cp extension/content_picker.js "$BUILD_DIR/content_picker.js"
cp extension/content_scraper.js "$BUILD_DIR/content_scraper.js"
cp extension/web_bridge.js "$BUILD_DIR/web_bridge.js"
cp extension/permission-grant.html "$BUILD_DIR/"
cp extension/permission-grant.js "$BUILD_DIR/"
mkdir -p "$BUILD_DIR/shared"
cp extension/shared/api-utils.js "$BUILD_DIR/shared/"
cp -r extension/icons "$BUILD_DIR/"

# Flip DEV to false in the build copy
sed -i.bak 's/const DEV = true;/const DEV = false;/' "$BUILD_DIR/config.js"
rm -f "$BUILD_DIR/config.js.bak"

# Package
cd "$BUILD_DIR"
zip -r "../$ZIP_NAME" . -x "*.bak"
cd ..

echo ""
echo "Built $ZIP_NAME"
echo "  - config.js: DEV = false"
echo "  - manifest.json: production content_scripts matches"
echo ""
echo "To develop locally, keep using the source directory with DEV = true."
echo "If you need localhost content_scripts, copy extension/manifest.dev.json over extension/manifest.json."
