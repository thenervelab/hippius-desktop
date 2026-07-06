# Finder Share Extension — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add native macOS Finder right-click sharing to Hippius — share a file or folder, public or password-private, via a Finder Sync Extension that drives the existing share engine.

**Architecture:** A sandboxed Swift `FIFinderSync` extension embedded in `Hippius.app` renders menus + status badges and forwards the clicked path over a Unix-domain socket in an App Group container to the running Tauri app; a new Rust `finder_bridge/` module resolves the path and reuses the existing `shares/` engine (folder→zip, password→client-side Argon2 key-wrap). The `hcfs` *server* is unchanged; `hcfs-client`(+wasm) gains Argon2 wrap/unwrap; the `hippius-console` recipient page learns `#p=` password links.

**Tech Stack:** Tauri 2 + Rust, Swift (`FinderSync`/`AppKit`), xcodegen, `codesign`/`notarytool`, Unix-domain sockets, Argon2id, zip.

**Companion docs:** `2026-06-30-macos-finder-share-extension-design.md` (design), `2026-06-30-finder-extension-phase0-signing-runbook.md` (signing detail).

---

## Phasing overview

- **Phase 0 — Packaging & signing** (this doc, detailed): empty extension builds, embeds, signs inside-out, notarizes, loads in Finder, and proves the App-Group socket channel. *Gate: nothing else can run until the extension can talk to the app.*
- **Phase 1 — IPC bridge** (Rust `finder_bridge/`, TDD): socket server + line protocol + path validation.
- **Phase 2 — Share flow**: resolve in-drive path → existing `create_share_inner`; outside file → raw-reader share; folder → zip-stream share; password → Argon2 key-wrap + `#p=` URL.
- **Phase 3 — Badges**: map sync snapshot → `STATUS:` lines.
- **Phase 4 — Frontend**: public/private (password) toggle in `ShareFileModal`; "Enable Hippius in Finder" nudge; auto-copy-on-share.
- **Phase 5 — hcfs-client(+wasm)**: shared Argon2 `wrap_share_key`/`unwrap_share_key` with a cross-crate equivalence test.
- **Phase 6 — hippius-console**: recipient `/share/[token]` page handles `#p=` (password prompt + unwrap).

Phases 1–6 are expanded into bite-sized TDD tasks once Phase 0 is green (their shapes depend on Phase 0 artifacts existing). This document details **Phase 0** fully.

---

## Conventions

- App Group ID: `<TEAMID>.com.hippius.shared` (Team-ID-prefixed → no Apple-portal step).
- Extension bundle ID: `hippius.com.FinderSync`. App bundle ID: `hippius.com` (existing).
- New native files live under `macos/`. The `<TEAMID>` is injected at build time from the signing identity, not hard-coded in committed source where avoidable (use a placeholder + build-time substitution, or a single `macos/group.env`).
- Commit after each task. Branch: `design/finder-share-extension` (or a fresh `feat/finder-share` worktree).

---

## Phase 0

### Task 0.1: Capture the Team ID and pin the App Group identifier

**Files:**
- Create: `macos/group.env`

**Step 1:** Read the Team ID from the local signing identity:

Run: `security find-identity -v -p codesigning | grep "Developer ID Application"`
Expected: a line `… "Developer ID Application: <Team> (XXXXXXXXXX)"` — the 10-char value is the Team ID.

**Step 2:** Write `macos/group.env` (this single file is the source of truth that the entitlements substitution and both code sides read):

```bash
# Source of truth for the App Group identifier. TEAMID from the Developer ID cert.
HIPPIUS_TEAM_ID=XXXXXXXXXX
HIPPIUS_APP_GROUP=XXXXXXXXXX.com.hippius.shared
```

**Step 3:** Commit.

```bash
git add macos/group.env
git commit -m "chore(macos): pin Finder extension App Group identifier"
```

> If the cert isn't on this machine, ask the operator for the 10-char Team ID; it is not secret.

---

### Task 0.2: Add the App Group to the main app entitlements

**Files:**
- Modify: `src-tauri/entitlements.plist`

**Step 1:** Add the `application-groups` key (keep `app-sandbox` = false). Use the literal group string from `macos/group.env`:

```xml
<key>com.apple.security.application-groups</key>
<array>
    <string>XXXXXXXXXX.com.hippius.shared</string>
</array>
```

**Step 2:** Verify the plist still parses.

Run: `plutil -lint src-tauri/entitlements.plist`
Expected: `OK`

**Step 3:** Commit (`feat(macos): app group entitlement on main app`).

---

### Task 0.3: Create the extension entitlements

**Files:**
- Create: `macos/FinderSync.entitlements`

**Step 1:** Sandboxed + same App Group:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key><true/>
    <key>com.apple.security.application-groups</key>
    <array><string>XXXXXXXXXX.com.hippius.shared</string></array>
</dict>
</plist>
```

**Step 2:** `plutil -lint macos/FinderSync.entitlements` → `OK`.

**Step 3:** Commit.

---

### Task 0.4: Scaffold the Finder Sync extension (Swift + xcodegen)

**Files:**
- Create: `macos/HippiusFinder/project.yml` (xcodegen)
- Create: `macos/HippiusFinder/FinderSync.swift`
- Create: `macos/HippiusFinder/Info.plist`

**Step 1:** `FinderSync.swift` — stub that registers a monitored dir and returns a one-item menu:

```swift
import Cocoa
import FinderSync

class FinderSync: FIFinderSync {
    override init() {
        super.init()
        // Phase 0 smoke test: monitor the home dir so the menu is reachable.
        FIFinderSyncController.default().directoryURLs = [URL(fileURLWithPath: NSHomeDirectory())]
    }
    override func menu(for menuKind: FIMenuKind) -> NSMenu {
        let menu = NSMenu(title: "")
        menu.addItem(withTitle: "Hippius (stub)", action: #selector(stub(_:)), keyEquivalent: "")
        return menu
    }
    @objc func stub(_ sender: AnyObject?) {
        NSLog("Hippius Finder stub clicked: \(FIFinderSyncController.default().selectedItemURLs() ?? [])")
    }
}
```

**Step 2:** `Info.plist` with the `NSExtension` dict (`NSExtensionPointIdentifier = com.apple.FinderSync`, principal class `FinderSync`).

**Step 3:** `project.yml` declaring one app-extension target `HippiusFinder`, bundle id `hippius.com.FinderSync`, the entitlements file `../FinderSync.entitlements`, deployment target 10.13.

**Step 4:** Generate + build unsigned:

Run: `cd macos/HippiusFinder && xcodegen generate && xcodebuild -project HippiusFinder.xcodeproj -scheme HippiusFinder -configuration Release CODE_SIGNING_ALLOWED=NO build`
Expected: a `HippiusFinder.appex` under DerivedData.

**Step 5:** Commit (`feat(macos): scaffold Finder Sync extension (stub)`).

> If `xcodegen` is absent: `brew install xcodegen`. If unavailable in CI, commit the generated `.xcodeproj` too.

---

### Task 0.5: Write the embed + inside-out sign script

**Files:**
- Create: `macos/embed-finder-extension.sh`

**Step 1:** Script per the runbook (sources `macos/group.env`, takes `APP_PATH` + `APPEX_SRC`, signs extension then app, verifies). `set -euo pipefail`, `shellcheck`-clean.

**Step 2:** Lint.

Run: `shellcheck macos/embed-finder-extension.sh && shfmt -d macos/embed-finder-extension.sh`
Expected: no findings.

**Step 3:** Commit.

---

### Task 0.6: Local end-to-end smoke (build → embed → sign → verify → load)

**Step 1:** Build the app (app-only bundle):

Run: `export APPLE_SIGNING_IDENTITY="Developer ID Application: … (XXXXXXXXXX)"` then `pnpm tauri build --bundles app`
Expected: `src-tauri/target/release/bundle/macos/Hippius.app`.

**Step 2:** Embed + sign:

Run: `macos/embed-finder-extension.sh src-tauri/target/release/bundle/macos/Hippius.app <path>/HippiusFinder.appex`
Expected: `embed + sign OK`; `codesign --verify --deep --strict` passes.

**Step 3:** Register + enable + verify the menu:

Run: `pluginkit -mAvvv -p com.apple.FinderSync | grep hippius.com.FinderSync` then `pluginkit -e use -i hippius.com.FinderSync`
Expected: the extension is listed; right-clicking a file in `~` shows "Hippius (stub)".

**Step 4:** No commit (manual verification). Record the result in the PR description.

---

### Task 0.7: Wire embed + notarize into CI

**Files:**
- Modify: `.github/workflows/tauri-build.yml`

**Step 1:** On `macos-latest`, after the app builds: install xcodegen, build the appex, run `embed-finder-extension.sh`, then notarize the re-signed `.app` with the existing `APPLE_API_*` env, staple, build + notarize + staple the DMG. Switch the macOS bundle to app-only so the script owns the DMG.

**Step 2:** `actionlint .github/workflows/tauri-build.yml` → clean.

**Step 3:** Commit (`ci(macos): embed + sign + notarize Finder extension`).

---

### Task 0.8: App-Group socket channel smoke test (the real gate)

**Goal:** prove the extension and app share the container *before* building the protocol.

**Step 1:** Temporary: have the app (debug) write a file `ping` into `~/Library/Group Containers/<group>/` on startup; have the extension stub read it in `init()` and `NSLog` the contents.

**Step 2:** Build + run both; confirm the extension logs the app's `ping` (Console.app, filter `Hippius`).

**Step 3:** Revert the temporary code (the real socket replaces it in Phase 1). No commit of the throwaway.

**Phase 0 done-criteria:** the extension is listed by `pluginkit`, the stub menu shows in Finder, app + DMG notarize/staple, and the App-Group container is shared both ways. → proceed to Phase 1.

---

## Phases 1–6 (task outlines — expanded when Phase 0 is green)

**Phase 1 — `finder_bridge/` (Rust, TDD):** `protocol.rs` (pure line parse/format: `REGISTER_PATH`/`STATUS`/`SHARE`/`UPLOAD_SHARE` — proptest round-trip), `socket.rs` (UDS server in the group container, `tokio::net::UnixListener`), path validation (`ensure_within` for in-drive, regular-file check for outside), wired into `AppState` + `main.rs` startup. Swift side: replace the stub with socket connect + menu-from-state + click→`SHARE:`.

**Phase 2 — Share flow:** `share_path` dispatcher → in-drive (`create_share_inner`), outside (new `create_share_for_external_path` via raw reader, null origin), folder (`zip_folder_to_temp` stream → chunked share, `application/zip`), password (`wrap_share_key` + build `#p=` URL). TDD each resolver; the zip + wrap helpers get proptests (round-trip zip entries; `unwrap(wrap(k,pw),pw)==k`).

**Phase 3 — Badges:** `finder_bridge` subscribes to the sync snapshot, pushes `STATUS:<state>:<path>`; Swift registers badge images + `setBadgeIdentifier`. Throttle/diff so only changed paths emit.

**Phase 4 — Frontend:** add public/password toggle + password field to `ShareFileModal`; `cache`-free auto-copy on success; `TranslocationGuard`-style "Enable Hippius in Finder" sonner when `pluginkit` reports the extension disabled (new `is_finder_extension_enabled` IPC).

**Phase 5 — hcfs-client(+wasm):** `wrap_share_key(key, password) -> (salt,nonce,wrapped)` + inverse, Argon2id params shared native/wasm, cross-crate equivalence test (native wrap → wasm unwrap), pin params in a KAT.

**Phase 6 — hippius-console:** recipient `/share/[token]/page.tsx` detects `#p=`, prompts for password, derives the unwrap key via the wasm helper, unwraps, then runs the existing decrypt path. Wrong-password → clear error, no server round-trip leak.

---

## Risks / watch-items

- `xcodegen` availability in CI (fallback: commit the `.xcodeproj`).
- Sandboxed extension reaching the UDS: the socket path **must** be inside the group container; a path elsewhere is blocked by the sandbox.
- Argon2id cost vs. recipient WASM latency — tune before Phase 6 ships.
- Finder extension instances are short-lived/multiple — keep all state in the app, none in the extension (Apple guidance).
- Notarization adds minutes to macOS CI; keep it on release builds only.
