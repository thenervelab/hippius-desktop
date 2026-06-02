// Single-source feature flags. Same pattern as `IS_SYNC_PAUSED` in
// `app/components/ui/SyncPausedAlert.tsx`: a literal `boolean` constant
// every consumer imports, so flipping a release just edits one line.
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
