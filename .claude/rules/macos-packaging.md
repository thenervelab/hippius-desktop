---
paths:
  - "macos/**"
  - ".github/workflows/tauri-*.yml"
  - "src-tauri/src/finder_bridge/**"
  - "src-tauri/entitlements.plist"
  - "src-tauri/Info.plist"
  - "src-tauri/tauri.conf.json"
  - "app/components/FinderExtensionGuard.tsx"
---

# macOS: Finder extension, signing, notarization

## Signed dev builds (optional, recommended)

macOS TCC remembers "Allow this app to access Documents/Desktop/Downloads" per signed identity (Designated Requirement), not per binary hash. Ad-hoc signed builds — what `pnpm tauri:dev` produces by default — get a fresh DR every rebuild, so TCC re-prompts on every run.

If the Hippius **Developer ID Application** cert is imported into your login keychain, sign dev builds with it so TCC consent persists across rebuilds:

```bash
# Add to ~/.zshrc (or export per-session)
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Company> (<TEAMID>)"
```

`tauri.conf.json`'s `bundle.macOS.signingIdentity` is `null`, which means Tauri reads the signing identity from this env var at build time. No config changes needed.

The default migration sync root (`~/Hippius-Migration-YYYY-MM-DD`, see `sync::migration::compute_default_sync_path`) lives outside every TCC-protected folder, so new installs never trigger a prompt at all.

## Testing the Finder extension from source

`pnpm tauri:dev` runs the raw debug binary, not a `.app` bundle, so it can't host the Finder Sync extension by itself. **`pnpm finder:dev`** (`macos/dev-finder.sh`) builds the `.appex`, builds + signs a debug `.app`, embeds + inside-out re-signs the extension, and registers it with `pluginkit` — once (auto-detecting the Developer ID identity).

The App Group `V28B5X732P.com.hippius.shared` is granted only to code signed by Team `V28B5X732P`, so a second machine must first import the shared Hippius **Developer ID Application** cert (the CI `APPLE_CERTIFICATE` .p12) into its login keychain — ad-hoc/other-team certs can't grant the container, and everything except the Finder feature still runs under a plain `pnpm tauri:dev` with no cert. After that, `pnpm tauri:dev` **does** drive the full feature: the app binds the App-Group socket and creates the container itself (`finder_bridge::socket::FinderBridge::start`), so the hot-reload dev binary owns the socket the already-registered extension connects to. Re-run `pnpm finder:dev` only after editing `macos/HippiusFinder/*.swift`. See `docs/plans/2026-07-01-finder-release-packaging.md`.

**That script is also why the Finder feature can look shipped while being invisible to every new user.** macOS registers a third-party Finder extension but leaves it **switched off**, and until the user enables it Finder never loads the extension — so a fresh install shows no "Share with Hippius" item at all, not even the "Open Hippius to share" fallback that `HippiusFinderSync.swift`'s `menu(for:)` returns unconditionally for anything under `$HOME`. `dev-finder.sh` step 4/4 runs `pluginkit -e use -i hippius.com.FinderSync`, an election keyed by **bundle identifier** that survives replacing the app with a released DMG build, so every developer Mac has had it on since its first `pnpm finder:dev` and the acceptance pass in `docs/release-checklist.md` never had to enable anything. The packaging itself is fine and was verified against a shipped DMG — appex embedded, sandbox + App-Group entitlements intact, notarized and stapled.

## Finder-extension enablement nudge

`finder_bridge/enablement.rs` owns the decision — `finder_extension_state` (returns the tagged `{"kind": "enabled" | "disabled" | "unsupported"}`), `open_finder_extension_settings`, and `enable_finder_extension`.

**There are THREE reasons the extension can be unusable, and triage must tell them apart.** `pluginkit -mAvvv -p com.apple.FinderSync | grep -A6 hippius` is the one-line triage:

| Output | State |
|---|---|
| leading `+` | registered and enabled |
| leading `-` | registered but switched off |
| no output | never registered — the extension is in NO pane, so no wording change or deep-link can fix it |

Also check `Contents/PlugIns/` before concluding anything: a build with no `.appex` is the third case. Every dev Mac is immune to the never-registered case because `macos/dev-finder.sh` runs `pluginkit -a` (register) + `-e use` (elect), and the election is keyed by BUNDLE ID so it survives replacing the app with a released build.

`enable_finder_extension` shells out to run those same two verbs, then re-asks Apple's API for the truth. That is the only mutation path — `FIFinderSyncController` can show the pane but not flip the switch — and it is contained deliberately: `pluginkit(8)` is a documented *debugging* tool that Apple DTS says not to architect around, so its output is **never parsed**, its failure is **never fatal** (the FE falls back to `open_finder_extension_settings`, i.e. exactly the old behavior, so an Apple removal degrades rather than breaks), and it only works at all because the app is **not sandboxed** (`entitlements.plist` sets `app-sandbox` false; DTS notes the call fails from inside a sandbox).

The bundle id is `FINDER_EXTENSION_BUNDLE_ID`, pinned against `macos/HippiusFinder/project.yml`'s `PRODUCT_BUNDLE_IDENTIFIER` by `bundle_id_matches_the_extension_project` — a drift there would make the elect verb a **silent** no-op, since `-e use` reports success for an unknown identifier.

**Reading** state goes through Apple's host-app API on `FIFinderSyncController` (`isExtensionEnabled` / `showExtensionManagementInterface`, macOS 10.14+), deliberately **not** by parsing `pluginkit(8)` and **not** by opening a hardcoded `x-apple.systempreferences:` URL, since that pane has moved between macOS releases (Extensions → Privacy & Security → Login Items & Extensions). The class is reached by declaring its `OBJC_CLASS_$_FIFinderSyncController` symbol rather than `objc_getClass`, because only a symbol reference makes the linker record FinderSync.framework — with a name-only lookup the framework is never loaded and the class never resolves (pinned by `is_extension_enabled_is_callable`, which also catches a misspelled selector).

Both commands hop to the main thread (`run_on_main_thread`); anything unanswerable — non-macOS, a failed hop, **or a build that embeds no `.appex` at all** — is `unsupported`, which the frontend treats exactly like `enabled`, because nagging on an unverifiable state is worse than missing a nudge.

**The `enablement.rs::hosting` gate is load-bearing**: `isExtensionEnabled` reports on the CALLING app's own extension, so `pnpm tauri:dev`'s raw binary (in no `.app` at all) and any bundle built without the Finder embed step get `false` unconditionally — meaning "there is no extension here", NOT "the user switched it off". Reading that as `Disabled` makes the nudge fire on every focus of every dev build while the INSTALLED app's extension is genuinely enabled. The gate resolves `current_exe`, walks out to the OUTERMOST `.app` ancestor (an `.appex` is itself a bundle, so the host app must win), and requires a `Contents/PlugIns/*.appex`; the path rule is pure and unit-tested on every platform. The commands are registered on **every** platform so the frontend needs no platform branch.

**Testing gotcha:** the answer is about the SYSTEM-ELECTED instance, not merely "is this identifier enabled" — with two registered copies of the app (a `pnpm finder:dev` bundle alongside `/Applications/Hippius.app`, which `pluginkit -mADvvv -i hippius.com.FinderSync` shows as two entries), the copy that is not the elected one reports `Disabled` while `pluginkit` shows `+`. Unregister the other instance (`pluginkit -r <appex>`) before concluding the check is broken.

**FE**: `app/components/FinderExtensionGuard.tsx` (mounted in `AppShell`'s full-app branch beside `TranslocationGuard`) raises one persistent sonner notice whose action is **"Enable"** — it calls `enable_finder_extension` and only falls back to `open_finder_extension_settings` when the result is not an explicit `enabled`. `unsupported` deliberately does NOT count as success: it means the backend could not verify the outcome. The notice styling is inherited from `AppShell`'s `ThemedToaster` — per-call `classNames` would make it inconsistent with every other toast. It re-checks on every **window focus** (Apple's documented flow, and what makes the notice clear itself when the user returns from System Settings) and never re-raises a notice the user closed (it returns on the next launch).

The notice copy names **File Providers**, not Finder: on Sequoia 15.2+ / Tahoe the Finder category is Apple's Quick Actions (Rotate Left, Markup, …) and Finder Sync lives under File Providers. The fallback if the pane will not open is `System Settings › General › Login Items & Extensions › File Providers`.

## CI release signing & notarization

`.github/workflows/tauri-build.yml` has a macOS-only "Set up Apple signing" step that activates from repo secrets — when a group of secrets is missing it logs a skip and the build proceeds (unsigned) instead of failing on empty values, which is why the vars are exported via `GITHUB_ENV` rather than the `tauri-action` env block.

- **Signing** (`APPLE_CERTIFICATE` = base64 .p12, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`): tauri-action imports the cert into a throwaway keychain and the bundler signs with hardened runtime + `src-tauri/entitlements.plist`. Public distribution requires a **Developer ID Application** cert (Account Holder-only to create); a Mac Development cert signs but Gatekeeper rejects it on other machines.
- **Notarization** (`APPLE_API_KEY_CONTENT` = base64 .p8, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`): an App Store Connect API key. It is deliberately **not** handed to tauri-action — it's decoded to disk and surfaced as step *outputs* consumed by the macOS finalize step, because the Finder extension is embedded (and the app re-signed) after tauri-action runs, which invalidates any earlier notarization.

**The bundle version comes from `tauri.conf.json` only.** `src-tauri/Info.plist` is merged OVER Tauri's generated plist, so a `CFBundleShortVersionString` there wins. One was pinned at `0.0.1` in the pre-1.0 era and shipped in every release through v0.3.4 — including signed, notarized production builds — so no installed copy could report which build it was. Nothing malfunctions, which is why it survived; the cost is diagnostic and real.

`CFBundleShortVersionString` is now absent from that file so Tauri generates it, and `tests/bundle_metadata_pin.rs` fails if it returns. **`CFBundleVersion` deliberately STAYS pinned at `1`** and is covered by the opposite assertion in that same test: macOS orders it component-wise, so letting Tauri generate it from `version` would sort `0.4.0` BELOW the `1` every shipped build carries — lowering the bundle version on upgrade, which Apple requires to increase monotonically and which LaunchServices/pkd consult when arbitrating duplicate registrations of one bundle id. Raising it properly needs a real monotonic build number (a CI run number), which this repo does not have yet. So a version bump touches `tauri.conf.json`, `Cargo.toml` and `package.json` — never `Info.plist`.

**A staging build without notarization creds has NO Finder extension.** `tauri-staging.yml`'s finalize step is gated `if: steps.apple.outputs.api_key != ''`; without the App Store Connect key the job falls back to a full Tauri build that is unsigned and embeds no `.appex`. That fallback is deliberate (staging is also used to test everything unrelated to Finder, so a lapsed secret should not cost the whole build) but a DMG that looks complete and is not costs testers days. It emits a `::error::` annotation AND stamps ` - NO FINDER EXTENSION` onto the release NAME plus a warning block into the release body, because the release list is where a tester picks a build. Swap the annotation for `exit 1` if the availability trade ever changes.

**Finder extension in releases** (`docs/plans/2026-07-01-finder-release-packaging.md`): Tauri v2 re-signs nested bundles with the app's single entitlements file, which would strip the extension's required sandbox + App-Group entitlements. So the release builds the app **app-only + signed but un-notarized** (macOS `args` = `--target universal-apple-darwin --bundles app`), then the **"Finalize macOS release"** step runs `macos/finalize-macos-release.sh`: build the universal `.appex` (`macos/build-finder-appex.sh`), embed + inside-out re-sign (`macos/embed-finder-extension.sh`), notarize + staple the app, then build + sign + notarize + staple the DMG and regenerate the updater tarball, uploading the finalized artifacts to the draft release.

**Known remaining item:** the updater manifest (`latest.json`) is not yet regenerated post-embed, so a release ships a correct DMG (fresh installs) but does not auto-update the fleet until that + the cross-repo updater endpoint are wired — the plan doc has the validation checklist.

Helper scripts that build the .p12 / validate the .p8 and push all secrets via `gh secret set` live in `~/Documents/hippius-signing/` (`finish-ci-signing.sh`, `set-notary-secrets.sh`) alongside the CSR/private key the certs must be issued against.
