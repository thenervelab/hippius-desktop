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
}

export function filterSettingsNavItems<T extends GatedSettingsItem>(
  items: T[],
  flags: SettingsNavFlags,
): T[] {
  return items.filter(
    (item) =>
      (flags.vpnEnabled || item.section !== "vpn") &&
      (flags.walletEnabled || item.section !== "wallets"),
  );
}
