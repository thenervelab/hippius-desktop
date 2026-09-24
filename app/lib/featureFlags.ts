// Single-source feature flags: a `boolean` constant every consumer imports,
// so flipping a release just edits one line.
//
// Add new flags here only when they gate user-visible behaviour and a
// future release is expected to flip them.
//
// A flag is either a plain literal — the same on every lane — or
// `enabledFrom(channel)` from `app/lib/buildChannel.ts`, which turns the
// feature on from that release lane outwards (`"beta"` → beta and
// staging, never production). `SHARED_DRIVES_ENABLED` uses it.
//
// Either way, gate on the LANE and never by editing this file differently
// per branch: `staging → beta` is a merge and `beta → main` a squash, so a
// per-branch value either conflicts on every promotion or rides into
// production through a hunk nobody read.

import { enabledFrom } from "@/app/lib/buildChannel";

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
 * `NotReady(SHARED_DRIVES_UNAVAILABLE)`, which the FE matches and hides).
 *
 * **Gated to beta** (`enabledFrom("beta")`): off production, on beta/staging.
 *
 * Console splits create vs use (`SHARED_DRIVES` on prod for members/invite
 * accept; `SHARED_DRIVES_CREATE` off prod until launch). Desktop still uses
 * one flag for both mint and use. Matching that split is a follow-up — do
 * not silently enable create on production without an explicit decision.
 *
 * Two gates still stand in front of it, which is what makes that safe:
 *
 *   - a plan without the perk never sees "Share drive" at all
 *     (`planSupportsSharedDrives`), and the server refuses a mint with
 *     `shared_drives_not_entitled` even if it somehow did;
 *   - a server fleet without `HCFS_FEATURE_SHARED_DRIVES=1` answers the
 *     unmounted routes as `NotReady(SHARED_DRIVES_UNAVAILABLE)`, which the
 *     UI hides rather than erroring on.
 *
 * So the worst case on a lane whose fleet is not ready is a menu item that
 * opens a modal saying the feature is not available — not a broken flow.
 *
 * Worth remembering why it was dark: it was left `true` through 0.6.0 without
 * ever being announced, which left the app contradicting itself — the Drive
 * plan cards grey out the shared team drive perk as "coming soon" while the
 * sharing surfaces were reachable. Check that copy still matches before this
 * reaches production.
 *
 * **Gated to beta because the console gates itself the same way.** The desktop
 * owns only part of the flow: an invite link is ACCEPTED on the console's
 * `/invite/[token]` page, and the console keeps its own `SHARED_DRIVES` flag
 * off in production. On everywhere here would let a production owner mint
 * links that land on a console page with the feature off — the desktop half
 * working perfectly and the flow dying at the one step it does not own.
 * Nothing in either codebase catches that, so the two flags flip together at
 * launch. `pnpm dev` resolves to staging (see `next.config.ts`), so local
 * work still sees it.
 */
export const SHARED_DRIVES_ENABLED = enabledFrom("beta");

/**
 * Folder collaboration: share ONE folder of a drive as Viewer or Editor, by
 * link or by email, and let an Editor holder write inside it.
 *
 * Built against HCFS #475 (not merged yet), documented in one place: the
 * module doc of `src-tauri/src/shared_drives/folder_roles.rs`. Inside this
 * flag nothing is hidden on a server capability: "Share folder" is always
 * offered to owners and drive Managers, and whatever the server refuses
 * (folder invites off, Editor off, email off) reads as "coming soon", so each
 * piece lights up on its own when the server turns it on. With the flag off,
 * folder sharing stays the read-only, capability-gated version.
 *
 * **Staging only** (`enabledFrom("staging")`): off in beta and production
 * until #475 merges and is checked against this build.
 */
export const FOLDER_ROLES_ENABLED = enabledFrom("staging");

/**
 * API token settings. When `false`, the surface is fully invisible: the
 * "API Token" item is filtered out of the settings sidebar
 * (`filterSettingsNavItems`) and the section does not render even if the
 * `api-key` section is reached by other means.
 *
 * Off because the token is for calling the Hippius API directly, which is
 * a thing people do from scripts and the console, not from the desktop
 * app — and showing a full-access credential on a screen nobody came here
 * for is a disclosure risk with no matching use.
 *
 * All the code stays (`ApiTokenSection.tsx` and its cards), same
 * keep-don't-delete policy as wallet and VPN. Flip to `true` to restore
 * the entry and the page.
 */
export const API_TOKEN_FEATURE_ENABLED = false;

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
