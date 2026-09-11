// Pure visibility resolver for the settings sidebar's feature-gated entries —
// the settings-page counterpart of filterNavSections in NavData.tsx. Gated
// entries stay in the nav array; flipping a flag in featureFlags.ts is the
// only release change needed. Unit-tested in __tests__/settingsNavGating.test.ts.

export interface GatedSettingsItem {
  section: string;
}

export interface SettingsNavFlags {
  vpnEnabled: boolean;
  walletEnabled: boolean;
  apiTokenEnabled: boolean;
}

export function filterSettingsNavItems<T extends GatedSettingsItem>(
  items: T[],
  flags: SettingsNavFlags,
): T[] {
  return items.filter(
    (item) =>
      (flags.vpnEnabled || item.section !== "vpn") &&
      (flags.walletEnabled || item.section !== "wallets") &&
      (flags.apiTokenEnabled || item.section !== "api-key"),
  );
}

/** The section shown when none is named, or the named one is unavailable. */
export const DEFAULT_SETTINGS_SECTION = "sync";

/**
 * Which settings section to actually render.
 *
 * A gated-off section is not merely unlinked, it is unreachable: the
 * section is chosen by query string, which is typed, bookmarked and
 * restored across launches, so hiding the sidebar entry alone leaves the
 * page reachable. Rendering it then produced the worst of both — the
 * section's own heading and description above an empty body, because the
 * heading lookup never consulted the flag.
 *
 * Falls back to the default, which is what an unrecognised section
 * already did.
 */
export function resolveSettingsSection(
  requested: string | null | undefined,
  flags: SettingsNavFlags,
): string {
  const section = requested ?? DEFAULT_SETTINGS_SECTION;
  const available: Record<string, boolean> = {
    vpn: flags.vpnEnabled,
    wallets: flags.walletEnabled,
    "api-key": flags.apiTokenEnabled,
  };
  return available[section] === false ? DEFAULT_SETTINGS_SECTION : section;
}

