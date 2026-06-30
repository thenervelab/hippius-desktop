# Phase 0 — Finder Extension Packaging & Signing Runbook (macOS)

**Date:** 2026-06-30
**Companion to:** `2026-06-30-macos-finder-share-extension-design.md`
**Goal:** Get an empty `FIFinderSync` extension building, embedded in `Hippius.app`, signed inside-out, notarized, and loadable in Finder — *before* any feature code. When this is green you can right-click in Finder and see a (stub) "Hippius" menu item.

> Correction to the design doc: with a **Team-ID-prefixed** App Group ID, **no Apple Developer portal registration is required** for Developer ID distribution. The `com.apple.security.application-groups` entitlement is unrestricted on macOS as long as the group ID begins with your Team ID. Portal registration is only needed if you use the iOS-style `group.…` format. We use the Team-ID-prefixed style → zero portal steps.

---

## 0. Identifiers you will reuse everywhere

| Thing | Value | Notes |
|---|---|---|
| App bundle ID | `hippius.com` | existing (`tauri.conf.json` `identifier`) |
| Extension bundle ID | `hippius.com.FinderSync` | **must** be prefixed by the app bundle ID |
| Team ID | `<TEAMID>` (10 chars) | from your Developer ID cert — see Step 1 |
| App Group ID | `<TEAMID>.com.hippius.shared` | Team-ID-prefixed → no portal registration |
| App Group container | `~/Library/Group Containers/<TEAMID>.com.hippius.shared/` | where the IPC socket lives |
| Signing identity | `Developer ID Application: <Team> (<TEAMID>)` | already in CI as `APPLE_SIGNING_IDENTITY` |

Pick the literal App Group ID once and use it identically in: the app entitlements, the extension entitlements, and both the Swift and Rust code that resolve the container path.

---

## 1. Find your Team ID

Locally, with the Developer ID cert in your keychain:

```bash
security find-identity -v -p codesigning
# →  1) ABC... "Developer ID Application: Hippius (AB12CD34EF)"
#                                                    ^^^^^^^^^^  = Team ID
```

Or: developer.apple.com → **Membership details** → Team ID. It is the same 10-char string embedded in the cert name.

> If you only have the CI secret and not the cert locally, ask whoever set up signing for the Team ID, or decode it from the `.p12` once imported. The Team ID is **not** secret — it ships inside every signed binary.

---

## 2. Add the App Group to the main app entitlements

Edit `src-tauri/entitlements.plist` — add (keep the app **non-sandboxed**, do not flip `app-sandbox`):

```xml
<key>com.apple.security.application-groups</key>
<array>
    <string>AB12CD34EF.com.hippius.shared</string>
</array>
```

The non-sandboxed app reaches the container by literal path (`~/Library/Group Containers/AB12CD34EF.com.hippius.shared/`) — the entitlement is what lets the *sandboxed extension* share that same container.

---

## 3. Create the extension's own entitlements

New file `macos/FinderSync.entitlements` — the extension **must** be sandboxed:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <key>com.apple.security.application-groups</key>
    <array>
        <string>AB12CD34EF.com.hippius.shared</string>
    </array>
</dict>
</plist>
```

No network entitlement: the extension only reads/writes the Unix-domain socket inside the group container and forwards paths. Finder grants the extension access to the file URLs the user selected in monitored folders, so no `files.user-selected` entitlement is needed for the menu/badge work.

---

## 4. Build the extension bundle (sidecar Xcode target)

Create a minimal Xcode project at `macos/HippiusFinder/` from the **Finder Sync Extension** template (Swift). Key settings:

- **Product type:** App Extension (`.appex`), `NSExtensionPointIdentifier = com.apple.FinderSync`.
- **Bundle identifier:** `hippius.com.FinderSync`.
- **Deployment target:** ≤ your app's `minimumSystemVersion` (currently `10.13.0`; `FIFinderSync` needs 10.10+, fine).
- **Code Signing:** set to manual / none here — the inject script signs it (Step 5).

A stub `FinderSync.swift` is enough for Phase 0: override `init()` to register one monitored directory (any folder, e.g. `~`) and `menu(for:)` to return a one-item menu titled "Hippius". This proves the bundle loads and the menu appears.

Build it from CI/local with:

```bash
xcodebuild \
  -project macos/HippiusFinder/HippiusFinder.xcodeproj \
  -scheme HippiusFinder \
  -configuration Release \
  -derivedDataPath build/finder \
  CODE_SIGNING_ALLOWED=NO \
  build
# → build/finder/Build/Products/Release/HippiusFinder.appex
```

---

## 5. Inject + inside-out sign (the core of Phase 0)

After Tauri produces `Hippius.app`, injecting the appex invalidates the app's signature, so the app **must** be re-signed last. Order is strict: **extension first, app last.**

Add `macos/embed-finder-extension.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_PATH="$1"                       # …/Hippius.app
APPEX_SRC="$2"                      # …/HippiusFinder.appex
IDENTITY="${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
APP_ENTITLEMENTS="src-tauri/entitlements.plist"
EXT_ENTITLEMENTS="macos/FinderSync.entitlements"

PLUGINS="$APP_PATH/Contents/PlugIns"
mkdir -p "$PLUGINS"
rm -rf "$PLUGINS/HippiusFinder.appex"
cp -R "$APPEX_SRC" "$PLUGINS/HippiusFinder.appex"

# 1) sign the extension FIRST (hardened runtime + timestamp + its own entitlements)
codesign --force --options runtime --timestamp \
  --entitlements "$EXT_ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$PLUGINS/HippiusFinder.appex"

# 2) re-sign the whole app LAST (inside-out); this re-seals the new PlugIns dir
codesign --force --options runtime --timestamp \
  --entitlements "$APP_ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$APP_PATH"

# 3) verify both
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -d --entitlements :- "$PLUGINS/HippiusFinder.appex" | grep -q application-groups
echo "embed + sign OK"
```

`chmod +x macos/embed-finder-extension.sh`.

---

## 6. Notarize + staple + DMG

Tauri-action normally builds the `.app`, signs, notarizes, and makes the DMG in one shot — but we must inject **between** signing and notarization. So change the macOS path to: Tauri emits only the `.app`, then our script injects → re-signs → notarizes → staples → builds the DMG.

1. In `tauri.conf.json`, scope the bundle so the DMG isn't auto-made on macOS (or pass `--bundles app` via the build args). The script makes the DMG.
2. Notarize the re-signed app:

```bash
DITTO_ZIP="$RUNNER_TEMP/Hippius.zip"
ditto -c -k --keepParent "Hippius.app" "$DITTO_ZIP"
xcrun notarytool submit "$DITTO_ZIP" \
  --key   "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait
xcrun stapler staple "Hippius.app"
```

3. Build the DMG from the stapled app (`create-dmg` or `hdiutil`), then notarize + staple the DMG too (Gatekeeper checks the DMG on download):

```bash
hdiutil create -volname Hippius -srcfolder "Hippius.app" -ov -format UDZO "Hippius.dmg"
xcrun notarytool submit "Hippius.dmg" --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "Hippius.dmg"
```

The CI secrets (`APPLE_API_KEY_PATH`/`APPLE_API_KEY`/`APPLE_API_ISSUER`) are already exported by the existing "Set up Apple signing & notarization" step in `tauri-build.yml` — reuse them.

---

## 7. Enable + verify the extension loads

After installing/running the app once, macOS registers the extension but does not auto-enable it.

```bash
# list registered Finder extensions (look for hippius.com.FinderSync)
pluginkit -mAvvv -p com.apple.FinderSync

# force-enable for testing without the GUI
pluginkit -e use -i hippius.com.FinderSync
```

GUI path for end users (and the in-app nudge target): **System Settings → General → Login Items & Extensions → Extensions** → find **Finder** / Hippius → toggle on. Right-click a file in a monitored folder → the "Hippius" menu item appears.

> Local dev: App Groups need a **real** Team ID — ad-hoc (`-`) signing won't grant container access. Export `APPLE_SIGNING_IDENTITY="Developer ID Application: … (AB12CD34EF)"` and run the same `embed-finder-extension.sh` against your debug `Hippius.app` to test the extension locally.

---

## 8. Phase 0 done-criteria (checklist)

- [ ] Team ID known; App Group ID chosen as `<TEAMID>.com.hippius.shared`.
- [ ] `application-groups` added to `src-tauri/entitlements.plist` (app stays non-sandboxed).
- [ ] `macos/FinderSync.entitlements` created (sandbox + same group).
- [ ] Sidecar Xcode project builds `HippiusFinder.appex` (stub menu).
- [ ] `embed-finder-extension.sh` injects + signs inside-out; `codesign --verify --deep --strict` passes.
- [ ] App + DMG notarize and staple successfully.
- [ ] `pluginkit -mAvvv -p com.apple.FinderSync` lists `hippius.com.FinderSync`; the stub menu item shows in Finder.
- [ ] Both the app and extension resolve the **same** container path `~/Library/Group Containers/<TEAMID>.com.hippius.shared/` (smoke test: app writes a file there, extension reads it).

When every box is checked, the OS bridge has somewhere to live and feature work (the socket protocol, share flow, badges) can begin.

## Sources
- Apple — [Register an app group](https://developer.apple.com/help/account/identifiers/register-an-app-group/)
- Apple DevForums — [Code Signing Identifiers Explained](https://developer.apple.com/forums/thread/811970) (macOS app-group = `TeamID.group`, unrestricted entitlement, iOS-style supported since Feb 2025)
- Apple — [App Extension Programming Guide: Finder Sync](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Finder.html)
- [ownCloud FinderSync.m](https://github.com/owncloud/client/blob/master/shell_integration/MacOSX/OwnCloudFinderSync/FinderSync.m) (App Group socket pattern)
- [tauri-plugin-widgets](https://github.com/s00d/tauri-plugin-widgets) (appex inject + re-sign post-build pattern)
- [Tauri — macOS code signing](https://v2.tauri.app/distribute/sign/macos/)
