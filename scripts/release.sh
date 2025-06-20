#!/bin/bash

# Exit on error
set -e

# Get the version from package.json
VERSION=$(node -p "require('./package.json').version")

# Build for all platforms
echo "Building version $VERSION..."

# Clean previous builds
rm -rf out/
rm -rf src-tauri/target/release/

# Build frontend
pnpm build

# Build Tauri app
pnpm tauri build

# Rename the release files to include version
mkdir -p releases

# Copy and rename the release files (adjust paths as needed)
cp src-tauri/target/release/bundle/dmg/*.dmg releases/hippius-$VERSION-macos.dmg
cp src-tauri/target/release/bundle/appimage/*.AppImage releases/hippius-$VERSION-linux.AppImage
cp src-tauri/target/release/bundle/msi/*.msi releases/hippius-$VERSION-windows.msi

echo "Release files created in the releases directory"
