# macOS Finder Share Extension — Design

**Date:** 2026-06-30
**Status:** Design validated, ready for implementation planning
**Scope:** Native macOS Finder right-click sharing for Hippius, with status badges, file + folder, public + password-private links.

## Problem

A user wants to share files the way Dropbox/ownCloud do: **right-click a file or folder in macOS Finder** (the OS file manager, not inside the Hippius app window) and get a share link — public or private, file or folder. Today Hippius can only share from inside its own app window, and only a single file as an anyone-with-link 24h link.

## What already exists (do not rebuild)

The app already ships an end-to-end-encrypted share engine, gated only on the server advertising `shares: true`:

- `hcfs_create_share(folder_label, relative_path)` mints a link `…/share/<token>#k=<key>`. The decryption key lives in the URL **fragment** (`#k=`), which browsers never send to the server — so the server stores only ciphertext. This is already a "public link": anyone with the URL can open it, nobody else can.
- A "My Shares" page with copy / revoke / reshare (`app/(pages)/shares/page.tsx`), a `ShareFileModal` with a `ShareProgress` bar, and an in-window right-click `FileContextMenu` → `onShareFile`.
- Rust module `src-tauri/src/shares/` (`commands.rs`, `client.rs`, `keystore.rs`, `origin.rs`, `history.rs`, `capabilities.rs`).
- The underlying `hcfs_client::create_share` takes a raw byte stream + filename + mime — it does **not** require the file to be in a synced folder. The desktop only resolves `(folder_label, relative_path)` to record a *reshare origin*. The "My Shares" page already handles null-origin rows.

**Implication:** this feature is mostly the **OS bridge**, not new sharing logic.

## Decisions (validated with stakeholder)

| Question | Decision |
|---|---|
| Fidelity | **Full Finder Sync Extension** (`FIFinderSync`) — top-level menu items **and** status badges |
| Platforms | **macOS only** for now (Windows Explorer parity deferred) |
| Files outside a Hippius folder | **Offer "Upload & Share"** (share any file, not just synced ones) |
| Delivery | Extension **embedded in the app bundle** — installing the app installs the extension; one-time enable in System Settings |
| Folder sharing | **Zip into one link** (archive + encrypt the folder into a single `application/zip` blob; recipient downloads one archive — no per-file browsing) |
| Private link | **Password-protected** — the share key is wrapped client-side with an Argon2-derived key; the password never reaches the server |
| Expiry | **Keep the fixed 24h TTL for now** (custom/never expiry deferred) |
| Badges | **In scope** (the larger half of the extension work, accepted) |

## Architecture

Three components plus an explicit packaging/signing prerequisite phase.

```
┌──────────────────────┐   Unix-domain socket    ┌───────────────────────────┐
│ Finder Sync Extension│  in App Group container │  Hippius app (running)     │
│  (Swift .appex)      │ <─────────────────────> │  finder_bridge/ (Rust)     │
│  - registers roots   │  App→Ext: REGISTER_PATH  │  - socket server           │
│  - paints badges     │           STATUS:<state> │  - path → share resolution │
│  - builds menu       │  Ext→App: SHARE:<path>   │  - reuses shares/ engine   │
│  - NO real work      │           UPLOAD_SHARE   │  - zip + password-wrap     │
└──────────────────────┘                          └───────────────────────────┘
```

### The IPC bridge

The app serves a **Unix-domain socket inside the App Group container** (`~/Library/Group Containers/<group>/`) — the one directory both the sandboxed extension and the (non-sandboxed) app can reach. This is ownCloud's proven mechanism. A small line-based protocol, two directions:

- **App → extension:** `REGISTER_PATH:<sync-root>` for each Hippius drive (on login / drive add / drive remove) so the extension knows which folders to light up; `STATUS:<state>:<path>` badge updates (`SYNCED` / `SYNCING` / `SHARED`).
- **Extension → app:** on a menu click, one line — `SHARE:<abs-path>` or `UPLOAD_SHARE:<abs-path>`.

The extension builds its menu **from state it already holds** (is this path under a registered root?) — no synchronous round-trip, so Finder's context menu stays instant. Per Apple's guidance the extension does **no heavy work**; it only renders badges + menu and forwards the click. The single long-running worker is the Hippius app, which already exists.

### Menu items

| Target | Item |
|---|---|
| File inside a Hippius drive | **Share via Hippius** (public) / **Share via Hippius (password)** |
| File outside any Hippius drive | **Upload & Share via Hippius** |
| Folder | **Share Folder via Hippius** (zips, then shares) |
| App not running / not logged in | **Open Hippius to share** (just launches the app — no half-working attempts) |

### The share flow (app side)

When the app receives a path:

1. **Inside a drive** → derive `(folder_label, relative_path)` (reuse `ensure_within` for traversal safety) → existing `create_share_inner` → records reshare origin.
2. **Outside a drive** → open the file as a byte reader → lower-level `hcfs_client::create_share` → null origin.
3. **Folder** → stream the folder into a **zip tempfile** (reuse the existing *chunked* share path, which already tempfiles + chunk-uploads large plaintext, so big folders scale) → share as `application/zip`.
4. **Password link** → wrap the share key client-side (see crypto below); the URL carries the wrapped key instead of the raw key.
5. On success → **auto-copy the link to the clipboard** *and* reveal the main window with `ShareFileModal` showing the link, expiry, and revoke. Big transfers show the existing `ShareProgress` bar.

### Password-private link — crypto (no server involvement)

- **Public link (today):** random 32-byte `share_key` → URL fragment `#k=<key>`; server stores only ciphertext.
- **Private link:** derive `wrap_key = Argon2id(password, salt)`; encrypt `share_key` with it; URL fragment becomes `#p=<base64url(salt ‖ nonce ‖ wrapped_key)>` — **the raw key never appears in the URL.** The recipient page prompts for the password, re-derives `wrap_key`, unwraps `share_key`, then decrypts as normal.
- The server never sees the password, salt, or key. A leaked URL alone is useless without the password. The threat model is unchanged from today except a URL now additionally requires the password.
- Argon2id parameters must be tuned for acceptable recipient-side (WASM) performance in the console; the console already builds on `hcfs-client-wasm`.

### Badges

The app maps its existing per-drive status + per-file sync snapshot to `STATUS:<state>:<path>` lines pushed over the socket. Finder renders a small fixed set of registered badge images (`SYNCED`, `SYNCING`, optionally `SHARED`). This is the larger half of the extension build and depends on a path→state lookup the `finder_bridge` answers from the existing snapshot system.

## Phase 0 — packaging & signing prerequisites

Already in place and reused unchanged:

- Developer ID Application cert + password (CI: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` — `tauri-build.yml`).
- Notarization via App Store Connect API key (`APPLE_API_KEY_CONTENT/ID/ISSUER_ID`).
- Hardened runtime on (`tauri.conf.json` `hardenedRuntime: true`); `providerShortName: "Hippius"`.
- Because the `.appex` lives inside the `.app`, the existing notarization step covers it — no new notarization secret.

New work required for the extension:

1. **App Group** — add `com.apple.security.application-groups` to **both** the app's `entitlements.plist` and the extension's entitlements. Using a **Team-ID-prefixed** group ID (`<TEAMID>.com.hippius.shared`) needs **no Apple-portal registration** for Developer ID distribution — the entitlement is unrestricted on macOS. (See the Phase 0 signing runbook.)
2. **Team ID as config** — currently only embedded inside the `APPLE_SIGNING_IDENTITY` secret string; the App Group ID and extension entitlements need it as an explicit value.
3. **Extension bundle + entitlements** — a second signable bundle (e.g. `hippius.com.FinderSync`) that **must be sandboxed** (`app-sandbox = true`), unlike the main app (deliberately `false`). App Groups bridge the sandbox boundary.
4. **Build/CI inject + inside-out re-sign** — Tauri does not natively embed `.appex`. Add a sidecar Xcode target that builds the extension, plus a post-build step (mirroring `tauri-plugin-widgets`): inject into `Contents/PlugIns/`, sign the extension first, then re-sign the app (inside-out) with hardened runtime, rebuild the DMG. Set the bundle `targets` so Tauri's built-in DMG (which omits the extension) is replaced by the script's.

## One-time enable UX

After first launch the extension is registered but macOS does not auto-activate third-party Finder extensions. Detect that it's off and show a one-time in-app nudge ("Enable Hippius in Finder") that deep-links to **System Settings → General → Login Items & Extensions → Finder Extensions** — the same step Dropbox prompts for.

## Cross-repo footprint

| Repo | Work |
|---|---|
| **hippius-desktop** | The bulk: Swift `.appex` + sidecar Xcode project + Phase-0 packaging/signing; `finder_bridge/` Rust socket module; share-anything + folder-zip + password-wrap; FE public/private toggle + "enable extension" nudge; badge feed |
| **hcfs-client (+ wasm)** | Small shared Argon2 key-wrap/unwrap helpers (native wraps, wasm unwraps — same cross-crate-equivalence test pattern already used) |
| **hippius-console** | Recipient `/share/[token]` page handles `#p=` password links (prompt + Argon2 unwrap). Required for private links to open |
| **hcfs-server** | **No schema change** (24h kept, zip is a file, password is client-side) |

## Security notes

- Path validation: the extension hands an absolute path the user selected. The app must validate it is a readable regular file/dir the user owns; for the in-drive case reuse `ensure_within` against the resolved sync root to prevent traversal/symlink escapes; for the outside case verify it is a regular file before reading.
- The socket lives in the App Group container shared only between the signed app and its signed extension (same Team ID); it is not a general localhost service.
- Password links: brute-force resistance rests on Argon2id parameters + password strength. The wrapped key + salt live in the URL fragment (never sent to the server, same channel as today's key).

## Out of scope (explicit, deferred)

- **Windows Explorer** shell extension (`IExplorerCommand`) — separate tech, deferred.
- **Custom / "never" expiry** — server keeps the fixed 24h TTL for now; `expires_at` is already a column and the reaper already keys off it, so this is a small later change.
- **Named-recipient privacy** (auth-gated downloads) — heavier server work; password links cover the "private" requirement.
- **Browsable folder tree** for recipients — zip-into-one-blob chosen instead.

## Open questions / follow-ups

- Exact badge state set and whether `SHARED` is worth the extra app→extension shared-state feed in v1.
- Whether the extension launches the app itself when the socket is down, or only shows "Open Hippius to share" (current plan: the latter — simplest, no sandbox launch-permission issues).
- Argon2id parameter choice (memory/time cost) balancing recipient WASM latency vs. brute-force cost.
- Zip policy for symlinks / empty subfolders inside a shared folder.
