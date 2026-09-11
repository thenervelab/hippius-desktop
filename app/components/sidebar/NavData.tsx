import { Icons } from "@/components/ui";
import { Share2Icon } from "lucide-react";
import Support from "../ui/icons/Support";
import {
  WALLET_FEATURE_ENABLED,
  REFERRALS_FEATURE_ENABLED,
} from "@/app/lib/featureFlags";

export interface SubMenuItemData {
  label: string;
  path: string;
  icon?: React.ReactNode;
  comingSoon?: boolean;
}

export interface NavItemData {
  label: string;
  path: string;
  icon: React.ReactNode;
  isActive?: boolean;
  comingSoon?: boolean;
  subMenuItems?: SubMenuItemData[];
  // When true, `path` is a full external URL opened in the user's system
  // browser via the Tauri opener plugin instead of being navigated to with
  // the in-app router. Mirrors hippius-web's `newTab` flag.
  external?: boolean;
  // Capability gate consulted by the sidebar before rendering this
  // item. `"shares"` hides the entry until the connected hcfs-server
  // advertises `shares: true` (see `shareFeatureEnabledAtom`); `"wallet"`
  // hides it while `WALLET_FEATURE_ENABLED` is off; `"referrals"` hides it
  // while `REFERRALS_FEATURE_ENABLED` is off. Adding a new gate is one
  // entry here plus one branch in `filterNavSections`.
  featureFlag?: "shares" | "wallet" | "referrals";
}

export interface NavSection {
  label: string;
  items: NavItemData[];
}

const ICON_CLASS = "size-[18px]";

export const navSections: NavSection[] = [
  {
    label: "ESSENTIALS",
    items: [
      {
        label: "Overview",
        path: "/",
        icon: <Icons.Home className={ICON_CLASS} />,
        isActive: true,
      },
    ],
  },
  {
    label: "INFRASTRUCTURE",
    items: [
      {
        label: "Drive",
        path: "/files",
        icon: <Icons.Category className={ICON_CLASS} />,
      },
      // The "Confidential Computing" group and its single Virtual Machines
      // child were removed here on 2026-09-08: the term is going from the
      // product, and the group's only child is gated off by
      // VM_FEATURE_ENABLED anyway, so it advertised a name we no longer use
      // for a page that redirects. Restoring VM to the sidebar when the flag
      // flips means adding a plain item under INFRASTRUCTURE — not the
      // wrapper group, which is what collapsed into a link to a 404 when its
      // only child was gated off. The /vm routes and their redirect are
      // untouched.
    ],
  },
  {
    label: "ACCOUNT",
    items: [
      // Subscription Plans and Billing were two adjacent entries for one
      // subject split by tense — what you could buy vs what you have paid.
      // Plan detail now lives under Billing, and Billing lives in
      // Settings → Billing, so neither belongs in this sidebar. The
      // /billing and /drive-plans routes still exist for deep links and
      // for the upgrade prompts that push to them.
      {
        label: "Wallet",
        path: "/wallet",
        icon: <Icons.Wallet className={ICON_CLASS} />,
        featureFlag: "wallet",
      },
      {
        label: "Referrals",
        path: "/referrals",
        icon: <Share2Icon className={ICON_CLASS} strokeWidth={1.5} />,
        featureFlag: "referrals",
      },
    ],
  },
  {
    label: "SUPPORT",
    items: [
      {
        label: "Documentation",
        path: "https://docs.hippius.com/",
        icon: <Icons.DocumentNormal className={ICON_CLASS} />,
        external: true,
      },
      {
        label: "Help & Support",
        path: "/support",
        icon: <Support className={ICON_CLASS} />,
      },
    ],
  },
];

/**
 * Resolve which nav sections/items are visible for the current gates.
 *
 * Pure so the gating rules are unit-testable: `shares` is a runtime server
 * capability (passed in by the sidebar from `shareFeatureEnabledAtom`),
 * while `wallet` and `referrals` are the build-time `WALLET_FEATURE_ENABLED`
 * / `REFERRALS_FEATURE_ENABLED` flags (defaulted here so callers don't
 * re-import them). Sections whose items are all filtered out are dropped
 * entirely so no orphaned heading renders.
 */
export function filterNavSections(
  sections: NavSection[],
  gates: {
    shareEnabled: boolean;
    walletEnabled?: boolean;
    referralsEnabled?: boolean;
  },
): NavSection[] {
  const walletEnabled = gates.walletEnabled ?? WALLET_FEATURE_ENABLED;
  const referralsEnabled =
    gates.referralsEnabled ?? REFERRALS_FEATURE_ENABLED;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (item.featureFlag === "shares") return gates.shareEnabled;
        if (item.featureFlag === "wallet") return walletEnabled;
        if (item.featureFlag === "referrals") return referralsEnabled;
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);
}
