// Single-source feature flags: a literal `boolean` constant every consumer
// imports, so flipping a release just edits one line.
//
// Add new flags here only when they gate user-visible behaviour and a
// future release is expected to flip them.

/**
 * Switch the home-page Credit Usage chart and the Total Credit Used
 * tile between the wallet-wide marketplace credits source (`false`,
 * default — covers drive + S3 + every other product) and the
 * drive-scoped source backed by `/user-credits-by-storage-history`
 * (`true` — matches the Storage Usage chart and Total Storage Used
 * tile, both already drive-scoped).
 *
 * Off in this release because the indexer event stream still reports
 * subscription-driven charges that aren't fully attributable to drive
 * usage; an explanatory `<InfoTooltip>` next to the chart title makes
 * the wallet-wide scope visible to users while the gate is off.
 *
 * Flip to `true` when the next release wants to surface drive-only
 * usage. The Rust `get_drive_credits_chart` / `get_drive_credits_total`
 * IPCs and the `useDriveCreditsTotal` FE hook stay live so the flip
 * needs no other code changes.
 */
export const DRIVE_SCOPED_CREDITS_ENABLED = true;

/**
 * VPN feature. When `false`, every VPN UI surface is hidden:
 *   - the top-bar VPN menu/button (`TopBarActions`),
 *   - the "VPN Settings" item in the settings sidebar (`SettingsSidebar`),
 *   - the VPN section on the settings page (`app/(pages)/settings/page.tsx`).
 *
 * No VPN code is deleted — all components, atoms and styles remain under
 * `app/components/dashboard-title-wrapper/vpn-menu/` and
 * `app/components/page-sections/settings/VPNSettings.tsx`. Flip to `true` to
 * restore VPN. The backend `get_vpn_status` command must also be registered
 * for the menu to work — its absence is why the (now-hidden) menu's status
 * fetch logged "Command get_vpn_status not found".
 */
export const VPN_FEATURE_ENABLED = false;

/**
 * Wallet page. When `false`, the wallet is fully invisible: the sidebar
 * entry is filtered out (`filterNavSections` in NavData.tsx) and a direct
 * `/wallet` navigation redirects to the overview (`FeatureDisabledRedirect`
 * in the page). All wallet code stays in place — same keep-don't-delete
 * policy as VPN. Flip to `true` to restore the page and sidebar entry.
 */
export const WALLET_FEATURE_ENABLED = false;

/**
 * Virtual Machines. When `false`:
 *   - the "Virtual Machines" sidebar sub-item renders disabled with an
 *     orange "Coming Soon" tag (mirrors the web console's treatment),
 *   - `/vm`, `/vm/create` and `/vm/instance-details` redirect to the
 *     overview (`FeatureDisabledRedirect`),
 *   - the tray context menu's "Open Virtual Machines" item is omitted.
 * VM code stays intact. Flip to `true` to re-enable everything.
 */
export const VM_FEATURE_ENABLED = false;

/**
 * VM-connection VPN (NetBird, app-scoped). When `false`, the per-VM "Connect
 * via VPN" surface in the VM instance-details view is hidden. The VPN is
 * **opt-in and VM-only**: it never routes the app's regular traffic, only
 * explicit connections to a VM's overlay address (the `nebula_ip` successor)
 * via a localhost forward.
 *
 * Independent of the legacy `VPN_FEATURE_ENABLED` (which gated the removed
 * whole-system Nebula menu). Off until (a) the backend mints the desktop's
 * per-tenant NetBird credential, (b) the `netbird-vpn` Cargo feature ships the
 * real embedded engine, and (c) VM functionality is live. The Rust `vpn_*` IPC
 * commands stay registered regardless, so flipping this needs no other change.
 * Also gated by `VM_FEATURE_ENABLED` since it lives inside the VM views.
 */
export const VM_VPN_ENABLED = false;

/**
 * Shared drives (cross-account team drives). When `false`, every shared-drive
 * UI surface is hidden:
 *   - the "Share drive…" item in both LocalFoldersSection menus (the row's
 *     3-dot `TableActionMenu` and the right-click `FolderCardContextMenu`),
 *   - `ShareDriveModal` (mounted in `app/(pages)/layout.tsx` beside
 *     `ShareFileModal` — renders nothing while the flag is off),
 *   - the "Shared with me" section in `MultiFolderSyncManager` (settings)
 *     and `DriveOnboarding` (files page),
 *   - the cosmetic owner badge on member rows in `LocalFoldersSection`.
 *
 * Deliberately NOT flag-gated: the member-row menu protections
 * (`folderMenuGating.ts` — owner-only item hiding and the "Leave shared
 * drive" wording/routing) key on the row's `ownerSs58` data alone, so
 * rolling this flag back after release cannot hand an existing member row
 * "Delete from Server" (the backend would key the delete by the wrong
 * identity) or a plain Remove that strands a live server-side membership.
 *
 * The Rust IPCs (`create_drive_invite`, `list_drive_members`,
 * `remove_drive_member`, `list_my_drive_memberships`, `leave_shared_drive`,
 * `add_shared_drive`) stay registered regardless, so flipping this needs no
 * other code change. Against a feature-off server every surface degrades
 * silently anyway (the backend maps the unmounted routes to
 * `NotReady(SHARED_DRIVES_UNAVAILABLE)`, which the FE matches explicitly
 * and hides).
 *
 * **The value differs by lane, and that is deliberate.** `beta` carries
 * `true` so the feature keeps getting exercised against the live fleet
 * (which runs `HCFS_FEATURE_SHARED_DRIVES=1`) and the console's
 * `/invite/{token}` accept page. Production carries `false`: desktop
 * invite links mint at the console, so shipping the surface before the
 * console flag is on for everyone would offer a flow that dead-ends.
 *
 * Because the lanes disagree, every `beta` -> `main` promotion shows this
 * line as a diff. Re-assert `false` on the promotion rather than taking
 * beta's value — see `docs/release-checklist.md`. It cannot be pinned by
 * `release_lane_pins.rs`, which runs on all three lanes.
 */
export const SHARED_DRIVES_ENABLED = false;

/**
 * Referrals page. When `false`, referrals is fully invisible: the sidebar
 * entry is filtered out (`filterNavSections` in NavData.tsx) and a direct
 * `/referrals` navigation redirects to the overview (`FeatureDisabledRedirect`
 * in the page). All referrals code stays in place — same keep-don't-delete
 * policy as wallet/VPN. Flip to `true` to restore the page and sidebar entry.
 */
export const REFERRALS_FEATURE_ENABLED = false;

/**
 * Referrals readiness. Only consulted while `REFERRALS_FEATURE_ENABLED` is
 * `true`: when this is also `true`, the referrals page renders behind the
 * blurred `ComingSoon` overlay (the sidebar link still routes there and the
 * page still mounts — matching the web console's referrals gating). Flip to
 * `false` when the program goes live.
 */
export const REFERRALS_COMING_SOON = true;
