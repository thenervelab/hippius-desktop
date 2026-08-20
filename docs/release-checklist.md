# Manual Release QA Checklist

Run through this list before every release. Each item is a user-visible behavior to
verify by hand in the built app (not `pnpm tauri:dev`, unless a step says so) —
install the actual release artifact the way a user would.

Conventions:

- **[mac]** / **[win]** / **[linux]** — platform-specific step; run on that OS.
  Unmarked steps apply everywhere.
- "Fresh account" means an account with no drives configured; "seeded account"
  means one with at least one synced folder containing nested folders and a mix
  of small + large (>100 MB) files.
- Where a step depends on a second device, the web console at the same account
  works as the second device.

---

## 1. Build, install & update

- [ ] Install from the release DMG **[mac]** / installer **[win]** / package **[linux]** on a clean machine or VM.
- [ ] **[mac]** App launches from `/Applications` with no Gatekeeper warning (signed + notarized).
- [ ] **[mac]** Launch the app directly from the mounted DMG (do not copy to /Applications): the "move Hippius to /Applications" translocation notice appears and persists.
- [ ] **[mac]** After moving to /Applications: grant Documents/Desktop folder access once, relaunch — macOS does **not** re-prompt for folder access.
- [ ] Splash screen shows during boot and hands off to the app without a blank-window gap.
- [ ] With an older version installed: the in-app updater offers the new version, downloads, and relaunches into it. (Known gap: verify `latest.json` was actually regenerated for this release — see CLAUDE.md "Finder extension in releases".)
- [ ] Second launch while the app is running focuses the existing window instead of opening a second instance.

## 2. Onboarding & authentication

- [ ] First-run onboarding carousel renders (video panel crops correctly when the window is resized).
- [ ] Create/login with **mnemonic** works and lands on the overview.
- [ ] Login with **access key** works.
- [ ] **OAuth** login (each provider button shown) round-trips through the browser and back via deep link.
- [ ] "Recover account" dialog: entering the recovery password on a fresh device restores the account and its drives decrypt (fresh-device unlock).
- [ ] Quit and relaunch while logged in: session restores without re-login, drives auto-init.
- [ ] Logout: returns to the login screen, sync stops, tray reflects signed-out state, no residue from the previous account (notifications, tray latch, drive list).
- [ ] Login as a **different** account after logout: no data from the previous account appears anywhere (files, shares, notifications, tray).
- [ ] Wrong password / malformed mnemonic shows a clear inline error, not a crash or silent failure.

## 3. Migration (legacy S3 accounts only)

- [ ] On an account with legacy S3 data: the migration prompt appears with the default folder pre-filled (`~/Hippius-Migration-YYYY-MM-DD`).
- [ ] Picking a custom folder in the prompt is respected; migration completes and files appear in the drive.
- [ ] Accounts with nothing to migrate never see the prompt.

## 4. Overview (home page)

- [ ] Available credits tile shows the live balance.
- [ ] Storage usage bars render and match the files actually stored.
- [ ] Credit usage chart renders (currently drive-scoped — `DRIVE_SCOPED_CREDITS_ENABLED = true`); the info tooltip explains the scope.
- [ ] Recent files list shows this device's recent sync activity; clicking a row opens/previews it.

## 5. Drive — sync folders (lifecycle)

- [ ] Fresh account: Files page shows the drive onboarding; "Start syncing" configures the first folder.
- [ ] Fresh device, existing account: onboarding offers to **restore drives that already exist on the server**; restoring one downloads its content.
- [ ] Adding a drive with **zero credits** is blocked up front with an insufficient-credits message.
- [ ] **Selective sync**: when adding a drive, the remote folder browser lets you deselect subfolders; deselected ones are not downloaded. Changing the selection later from settings (Sync & Storage) applies without breaking the drive.
- [ ] Delete a **remote-only** folder (one listed on the server but not synced here): it disappears from the server list and the console.
- [ ] "Reveal in Finder/Explorer" on a drive opens its sync root.
- [ ] Add a **second** sync folder while the first is mid-sync: the app does not freeze, both drives sync.
- [ ] Add two folders with the same basename: both get distinct labels (`tags`, `tags-2`), neither overwrites the other.
- [ ] **Pause** a drive (all three surfaces: settings → Sync & Storage 3-dot menu, files-page folder tab menu, tray submenu) — status flips to Paused everywhere at once.
- [ ] **Resume** the drive from each surface — status flips to Active, sync catches up.
- [ ] Paused state survives quit + relaunch, and survives logout + login.
- [ ] **Remove** a drive: row disappears everywhere, local files on disk are untouched; re-adding the same folder later does NOT delete local files.
- [ ] Drive init failure (e.g. sync root folder deleted on disk) surfaces an error status with a retry affordance, not a silent dead drive.

## 6. Drive — file operations

- [ ] Upload a file via the Add button; it appears in the table, syncs, and shows in the web console.
- [ ] Upload a **folder** (folder-to-folder dialog); nested structure is preserved server-side.
- [ ] Drag & drop files onto the drop zone uploads them.
- [ ] File/folder pickers remember the last browsed directory.
- [ ] Upload with **zero credits**: blocked up front with an "insufficient credits" message (not a cryptic server error).
- [ ] Drop a file into the sync folder in Finder/Explorer: it is picked up and uploaded without touching the app.
- [ ] **Rename** a file from the row menu and from right-click: renames on disk, propagates to the server as a rename (check console shows the new name; no delete + re-upload flicker).
- [ ] Rename validation: empty name, `/`, `..`, and Windows-reserved names (`con.txt`) are rejected inline.
- [ ] Rename is disabled (with tooltip) on cloud-only rows from other devices.
- [ ] **Delete** a file: gone from table, disk, and console after the next cycle.
- [ ] Delete a **folder** (including an empty one): it disappears immediately from the current view — including inside an expanded/nested view — and does not reappear ("resurrect") after the next sync cycle.
- [ ] Delete the **last** entry of a subfolder while inside it: the view updates without navigating away.
- [ ] Create an **empty folder** on this device: it appears in the console; create one in the console: it materializes on disk here.
- [ ] Rename a file to a name that already exists: blocked with a clear message (nothing silently overwritten).

## 7. Drive — browsing, preview & download

- [ ] Table view and card view both render; switching preserves the file set.
- [ ] Expand a folder inline (expander rows): children page in with infinite scroll and stay aligned.
- [ ] Navigate into nested subfolders; breadcrumbs work; a subtree not yet downloaded on this device still lists (rows show pending status), no empty-folder lie.
- [ ] Preview an **image**, a **video**, and a **PDF** from: the table, an expanded subfolder, and search results.
- [ ] In the viewer, prev/next and the thumbnail rail walk the folder the file actually lives in (not the top-level page list).
- [ ] Preview a **cloud-only** file (uploaded from another device, not synced here): it downloads, decrypts, and previews.
- [ ] **Download** a synced file to a chosen location; download a **cloud-only** file — both produce a correct, openable file.
- [ ] Download an entire folder.
- [ ] Reveal-in-Finder/Explorer from the context menu opens the right location.
- [ ] Sort and filter controls (type/size/date) work on the files page.
- [ ] Thumbnails render in card view and the viewer's thumbnail rail (images/videos).
- [ ] The refresh button re-lists without a full-page flash, including while a sync is running.

## 8. Search

- [ ] ⌘/Ctrl-F (or clicking the sidebar search pill) opens the centered search palette from any page.
- [ ] Empty query shows account-wide **last uploads** (includes uploads from other devices).
- [ ] Typing searches the **server** (cross-device, cross-drive): a file uploaded only from the console/another device is found.
- [ ] Arrow keys + Enter select; Esc and overlay-click close.
- [ ] Opening a result previews it; downloading a cloud-only result works.
- [ ] Result rows show sensible sync status: files on disk or on-server-only show "synced"; only genuinely queued-for-download files show "pending".

## 9. Sync progress UI

- [ ] Start a large sync: the sidebar widget appears with per-file rows, byte progress, speed, and ETA; the header "X of Y bytes" matches the ring percentage (no 0B-vs-16% divergence).
- [ ] Percent/ETA move smoothly — no lurching backwards mid-plan, no sticking at a stale high-water mark when files are added.
- [ ] A just-finished upload stays visible in the completed list with a stable timestamp (no "Just now" forever, no appear-then-vanish).
- [ ] Widget ✕ minimizes to the progress ring; clicking the ring re-expands. A new sync session un-minimizes it.
- [ ] Collapse the sidebar: the widget becomes the ring, aligned under the avatar.
- [ ] Completion shows "Complete" (not stuck on "Syncing…"); widget clears on idle.
- [ ] No red "Preparing" flash on idle no-op cycles; a genuine Finder-drop does surface the preparing state.
- [ ] During an active large sync the machine does **not** go to system sleep (display may sleep) **[mac]** **[win]**; after sync completes, sleep works normally.
- [ ] Kill connectivity mid-sync: widget/tray show a failure state; restore connectivity: sync recovers on its own.
- [ ] "Sync Failed" notification appears only after a sustained outage (~3 failed cycles), not for a single blip, and only once per outage.

Failed files:

- [ ] A file that repeatedly fails (e.g. locked/unreadable) surfaces the **Failed Files modal** / failure badge instead of retrying silently forever.
- [ ] Per-file **Retry**, **Skip**, and **Exclude** each do what they say; **Retry all** re-queues everything.
- [ ] An **excluded** file stops being retried and stays excluded across restarts; the rest of the drive keeps syncing.

## 10. Conflicts & Review Changes

- [ ] Provoke a conflict (edit the same file on two devices between syncs): the conflicts banner appears.
- [ ] Review Changes dialog: conflicts listed first; plan sections are collapsible with counts; destructive sections are visually flagged.
- [ ] Filenames render as real names, never a 64-char hex hash.
- [ ] Per-row choices and "Apply to all" stay in sync; picks survive the dialog being re-fed by a mid-review re-stage; closing and reopening the dialog keeps the picks.
- [ ] "Skip for now" defers (banner returns next cycle); an all-skip submission warns explicitly.
- [ ] Submitting closes the dialog immediately and hands progress to the sync widget; if a sync cycle is already running, the click gets a "retry shortly" toast (never a frozen spinner).

## 11. Sharing

In-app:

- [ ] Share via link from **each** surface: table row ⋮ menu, right-click context menu, card view, file viewer.
- [ ] Chooser offers **Anyone with the link** / **Password protected**, plus expiry (24 h / 7 d / 30 d / until revoked).
- [ ] Public share: link auto-copies; opening it in a browser downloads & decrypts the file.
- [ ] **Password** share: a strong password is pre-filled and editable (min 8 chars enforced); the done view shows the password exactly once with a copy button; the `#p=` link opens in the console only with the password; wrong password shows "Incorrect password".
- [ ] Progress bar runs for a large file (encrypting → uploading), and Try again works after a forced failure.
- [ ] Share a second file right after the first: the modal resets (no stale link shown).
- [ ] Shared files show the badge in the table; the tooltip lists the links.

My Shares page (`/shares`):

- [ ] All active links listed with filename, size, created/expiry.
- [ ] Password-protected rows show the lock badge, and Copy hands out a `#p=` link (never a password-free `#k=` link to a protected share).
- [ ] Change expiry in place (URL unchanged, new expiry live); Revoke kills the link (opening it now fails).
- [ ] Rows minted on another device show filename + Revoke but no Copy (no local key).
- [ ] **Share history**: expired/revoked links are listed in the history view; removing one row and clearing all history both work; history never shows a live link as historical.

Finder extension **[mac]**:

- [ ] **On a Mac that has never run `pnpm finder:dev`** (`pluginkit -mAvvv -p com.apple.FinderSync | grep -A6 hippius` shows no leading `+`): first launch raises the "Turn on the Hippius Finder extension" notice, its **Open Settings** button opens the Extensions pane, and the notice clears by itself on returning to the app once the switch is on. A dev Mac cannot verify this — its enable election is keyed by bundle id and outlives reinstalls, which is exactly how the missing right-click menu shipped in v0.2.1.
- [ ] With the extension enabled, no notice appears on launch.
- [ ] Right-click a synced file in Finder → "Share with Hippius": app comes forward with the chooser; both public and password variants mint working links.
- [ ] Cancelling the chooser aborts (nothing uploaded, no orphan link).
- [ ] Folder share from Finder produces a working zip share.

## 12. Tray

- [ ] **[mac]** **[win]** Left-click the tray icon: popover opens anchored to the icon; clicking outside dismisses; clicking the icon again toggles (no instant re-open).
- [ ] Popover shows account identicon, address, live block number, credits; "Open Hippius" reveals the main window.
- [ ] Popover bell shows the correct unread count and opens the main window's notification menu.
- [ ] Popover "Search Files" focuses the main window's search; empty-state "Upload a File" navigates main to /files.
- [ ] Popover shows the live sync-progress summary during a sync; nothing when idle.
- [ ] Popover follows the app theme (System/Light/Dark) and is opaque on Windows (not see-through) **[win]**.
- [ ] Right-click: native context menu (Open Files / Quit; no VM item while flagged off).
- [ ] Signed out: left-click opens the main login window, never the popover.
- [ ] **[linux]** Tray click opens the menu; "Open Hippius" reveals the main window (no popover expected).
- [ ] Tray icon reflects sync state (active / complete / error) and the completed state doesn't flicker away when the engine goes idle.

## 13. Notifications

- [ ] Top-bar bell badge counts unread; opening the menu lists them; mark-as-read updates the badge.
- [ ] Notifications page (`/notifications`) lists, filters, and clears.
- [ ] Sync Complete and Sync Failed rows appear under the right conditions (see §9); credits-exhausted notification fires when balance runs out.
- [ ] **Low-credit warning** fires once when the balance drops below the threshold (half), and does not re-fire on every check.
- [ ] After an app update, the **version / what's-new notification** appears exactly once.
- [ ] User-initiated pause/remove/logout never produces a "Sync Failed" notification.

## 14. Billing

- [ ] Billing page shows balance, charts, and history; numbers agree with the console.
- [ ] Plan/subscription section loads without errors.

## 15. Settings

- [ ] **Sync & Storage**: folder manager lists every drive with status; pause/resume/remove work from here (cross-check §5).
- [ ] **Appearance**: System / Light / Dark switch applies instantly app-wide (main window **and** tray popover), persists across relaunch, and there is no wrong-theme flash at boot.
- [ ] **Security**: recovery phrase reveal (with confirmation); **change recovery password** completes, and afterwards login/unlock on a second device works with the new password only. Interrupt the rotation mid-way (quit): boot-time resume completes it.
- [ ] **Encrypted mnemonic backup**: export via the backup dialog produces a password-protected file; the password is required to use it (spot-check the file is not plaintext).
- [ ] **Notifications** section toggles behave.
- [ ] **API key** section: issue/copy/regenerate work; the key works against the API.
- [ ] **Customize RPC**: setting a custom endpoint takes effect; resetting restores the default.
- [ ] **Device name**: renaming persists and shows on uploads from this device.

## 16. Support

- [ ] Open a support ticket from `/support`; it arrives with the entered content.
- [ ] "Attach logs": the bundle contains recent logs with secrets/identity **redacted** (spot-check: no mnemonics, tokens, wallet addresses, usernames, or email addresses in the zip).
- [ ] Documentation link in the sidebar opens the docs site in the system browser.

## 17. Feature flags — verify the gates hold

Current expected state (`app/lib/featureFlags.ts`) — update this section when a flag flips:

- [ ] **Wallet** (`WALLET_FEATURE_ENABLED = false`): no sidebar entry, `/wallet` redirects to overview, no Wallets section in settings.
- [ ] **VM** (`VM_FEATURE_ENABLED = false`): sidebar sub-item disabled with "Coming Soon" tag; `/vm`, `/vm/create`, `/vm/instance-details` redirect; no VM item in the tray menu.
- [ ] **VPN** (`VPN_FEATURE_ENABLED = false`, `VM_VPN_ENABLED = false`): no VPN menu in the top bar, no VPN settings entry/section, no per-VM connect surface.
- [ ] **Referrals** (`REFERRALS_FEATURE_ENABLED = false`): no sidebar entry, `/referrals` redirects.
- [ ] Direct navigation to every gated route lands on the overview (static export = client-side redirect; make sure no blank page).

## 18. Window & shell basics

- [ ] Resize, minimize, maximize, fullscreen all behave; layout has no broken breakpoints at narrow widths.
- [ ] Sidebar collapse/expand works and persists sensibly; collapsed rail keeps working nav.
- [ ] Closing the **main window hides to tray** — the app keeps running and sync continues (verify a transfer keeps progressing); reopening from the tray restores the window.
- [ ] **Quit** (tray menu) actually exits the process; relaunch restores cleanly.
- [ ] Deep links (OAuth callback) focus the running instance.
- [ ] No stray error toasts or console-visible IPC errors during a normal 10-minute session.

---

## Appendix A — flagged-off feature packs

Skip these while the flags are off (§17 only verifies they stay hidden). When a
flag flips ON for a release, pull the matching pack into the main run:

- **Wallet** (`WALLET_FEATURE_ENABLED`): balance display, send/receive (address
  validation, address book contacts), staking (bond / unbond / withdraw
  unbonded / claim rewards), local password-encrypted wallets (create, import,
  export backup + zip, rename, delete, set active, verify password), and the
  **bridge** (Alpha ↔ hAlpha). ⚠️ The bridge write paths are **funds-critical
  and compile-verified only** — smoke-test on a funded testnet wallet before
  any release that exposes them (see `src-tauri/src/blockchain/bridge/DEPOSIT_PORT_NOTES.md`).
- **VM** (`VM_FEATURE_ENABLED`): flavors/images/applications lists, create,
  instance details, start/stop/reboot/terminate, SSH keys (list/create/delete),
  tray "Open Virtual Machines" item.
- **VM VPN** (`VM_VPN_ENABLED`, requires the `netbird-vpn` Cargo feature):
  connect/disconnect, per-VM localhost forward opens, status surfaces once,
  teardown on logout.
- **Referrals** (`REFERRALS_FEATURE_ENABLED` / `REFERRALS_COMING_SOON`):
  referral link list + generate; or the blurred Coming Soon overlay while the
  second flag is on.

## Appendix B — known dead/unwired surfaces (do not test, consider removing)

- `change_sync_folder` IPC is registered but has no frontend caller.
- `get_vpn_status` is referenced by the (hidden) VPN menu but not registered.

---

## Suggested minimum matrix

| Scenario | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Fresh install + new account | ✔ | ✔ | ✔ |
| Update from previous release | ✔ | ✔ | — |
| Seeded account, full pass §5–§13 | ✔ | ✔ | ✔ (skip popover/Finder) |
| Finder extension §11 | ✔ | — | — |

Sign-off: every unchecked box either passes, or is filed as an issue linked next
to the box before the release ships.
