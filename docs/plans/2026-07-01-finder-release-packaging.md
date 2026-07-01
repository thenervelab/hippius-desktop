# Finder extension: release packaging

**Goal:** A signed, notarized release (`v*` tag → `tauri-build.yml`) ships an
`Hippius.app` that contains the Finder Sync extension — so end users get the
right-click sharing feature, not just local dev builds.

## Why the release couldn't just "include" the extension

Tauri v2's macOS bundler **re-signs every nested bundle it detects** (dylib, app,
xpc, frameworks) with the app's single `entitlements.plist`. A Finder extension
**must** be sandboxed (`com.apple.security.app-sandbox = true`) with its own
App-Group entitlement (`macos/FinderSync.entitlements`). If Tauri signs the
`.appex` with the non-sandboxed *app* entitlements, macOS refuses to load it.

So the extension cannot be present while Tauri signs. It is embedded and
inside-out re-signed **after** Tauri finishes — which invalidates Tauri's
signature, notarization, and DMG. The release therefore re-owns the tail of the
pipeline. This is the same inside-out flow proven locally (the app
"satisfies its Designated Requirement" after `embed-finder-extension.sh`).

## The pieces

| File | Role | State |
|------|------|-------|
| `macos/build-finder-appex.sh` | Build the **universal** (arm64+x86_64) `.appex` via xcodegen+xcodebuild. Fails loudly if the binary isn't fat. | ✅ Tested locally (produces `x86_64 arm64`). |
| `macos/embed-finder-extension.sh` | Copy appex into `Contents/PlugIns`, sign extension first + app last, verify the App Group survives. | ✅ Proven locally (pre-existing). |
| `macos/finalize-macos-release.sh` | Orchestrate: build appex → embed → notarize+staple app → regenerate+sign updater tarball → build+sign+notarize+staple DMG. | ⚠️ Needs a real-release dry-run (Apple secrets). |
| `.github/workflows/tauri-build.yml` | macOS: install xcodegen+create-dmg; Tauri builds **app-only + signed, NOT notarized**; finalize step embeds + notarizes + DMG; upload to the draft release. | ⚠️ Needs a real-release dry-run. |

Key workflow changes:
- **Notarization moved out of `tauri-action`** — the App Store Connect key is a
  step *output* consumed only by the finalize step, not `GITHUB_ENV`. Tauri still
  gets the *cert* and signs the app.
- **macOS args = `--target universal-apple-darwin --bundles app`** — Tauri builds
  no DMG (finalize owns it) and no updater artifact (see the caveat below).

## Validated vs. needs live validation

**Validated locally (this Mac):**
- `build-finder-appex.sh` produces a genuinely universal `.appex`; stdout is only
  the artifact path; `lipo` confirms `x86_64 arm64`.
- `embed-finder-extension.sh` embeds + inside-out signs and passes
  `codesign --verify --deep --strict` (proven earlier today).
- All scripts pass `shellcheck` + `shfmt`; the workflow passes `actionlint` + `zizmor`.

**Needs a real `v*`-tag dry-run with the Apple secrets (the "take it from there" boundary):**
1. **Notarization** — `xcrun notarytool submit --wait` for the app and the DMG
   with `APPLE_API_KEY/_ISSUER/_KEY_PATH`; confirm both staple.
2. **DMG layout** — `create-dmg` icon/window coordinates are best-guess; verify the
   drag-to-Applications window looks right.
3. **Updater manifest (`latest.json`) — NOT wired yet.** Because macOS builds
   `--bundles app`, Tauri produces no updater artifact, so this release ships a
   correct **DMG (fresh installs)** but does not update `latest.json`. `finalize`
   regenerates + signs the updater `tar.gz`/`.sig` from the embedded app and
   uploads them, but a matching `latest.json` (with the new signature, per-arch
   URLs, version, pub_date) must still be generated and the **cross-repo updater
   endpoint** honored: `tauri.conf.json` points the updater at
   `thenervelab/hippius-desktop` (public), while builds draft in this repo. Until
   `latest.json` is wired, the auto-updater will not deliver this version — which
   is the *safe* failure (it won't ship an extension-less update), but it is the
   remaining task.
4. **Asset filenames** — confirm the finalize DMG/tarball names match whatever the
   promotion/`latest.json` process expects; `gh release upload --clobber` only
   replaces same-named assets.

## Testing the full feature from source (dev)

`pnpm tauri:dev` runs the raw debug binary (`target/debug/Hippius`), not a `.app`
bundle — and a Finder extension can only be hosted by a signed `.app` with the
`.appex` in `Contents/PlugIns/`, registered with `pluginkit`. So `tauri:dev`
alone cannot load the extension.

**`pnpm finder:dev`** (`macos/dev-finder.sh`) bridges that: it builds the appex,
builds + signs a debug `.app`, embeds + inside-out re-signs the extension, and
registers + enables it with `pluginkit` — once. It auto-detects the Developer ID
identity from the keychain (App Groups need a real Team ID; ad-hoc signing won't
grant the shared container).

After that one-time step, `pnpm tauri:dev` **does** drive the full feature: the
app binds the App-Group socket on every macOS launch and `create_dir_all`s the
container itself (`finder_bridge::socket::FinderBridge::start`), so the hot-reload
dev binary owns the socket and the already-registered extension connects to it.
Re-run `pnpm finder:dev` only after editing the Swift extension
(`macos/HippiusFinder/*.swift`); Rust/frontend changes just need `pnpm tauri:dev`.

## Fallback / alternative considered

Placing a pre-signed appex via `bundle.macOS.files` and letting Tauri own
notarization+DMG is simpler but bets on Tauri *not* re-signing `.appex` (its
nested-signing docs list "app", ambiguously). That bet is untestable without a
release and would silently mis-sign the extension if wrong, so the safer
post-build re-sign path above was chosen — it uses only standard Apple tooling
with predictable behavior.
