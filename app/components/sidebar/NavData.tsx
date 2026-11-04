import { Icons } from "@/components/ui";
import { Camera, MessagesSquare, Share2Icon, Users } from "lucide-react";
import Support from "../ui/icons/Support";
import {
  WALLET_FEATURE_ENABLED,
  REFERRALS_FEATURE_ENABLED,
  SHARED_DRIVES_ENABLED,
} from "@/app/lib/featureFlags";
import { BILLING_ROUTE } from "@/app/lib/routes";

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
  // while `REFERRALS_FEATURE_ENABLED` is off; `"chat"` hides it until Rust's
  // `chat_get_config` reports `enabled: true` (see `chatEnabledAtom`);
  // `"capture"` hides it unless the caller says capture is on for this
  // computer (`SCREEN_CAPTURE_ENABLED` and Rust's `capture_support`);
  // `"sharedDrives"` hides it while `SHARED_DRIVES_ENABLED` is off.
  // Adding a new gate is one entry here plus one branch in
  // `filterNavSections`.
  featureFlag?: "shares" | "wallet" | "referrals" | "chat" | "capture" | "sharedDrives";
}

export interface NavSection {
  key: string;
  // The section's title. Left out, the section draws no heading: Overview
  // stands on its own, as in the console's sidebar.
  label?: string;
  items: NavItemData[];
}

const ICON_CLASS = "size-[18px]";

// The product first, then your account, then help: one logic for this
// sidebar and the console's, with the same names (#1081 in hippius-console).
export const navSections: NavSection[] = [
  {
    key: "overview",
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
    // A section title, not a collapsible menu: a Drive submenu would turn
    // Drive into a toggle. The product name, as on the website.
    key: "drive",
    label: "DRIVE",
    items: [
      {
        // "My" only because Shared Drives exists beside it.
        label: "My Drive",
        path: "/files",
        icon: <Icons.Category className={ICON_CLASS} />,
      },
      // Right under My Drive, as the console orders them: the drives shared
      // with this account and the ones it shared, in one place. Its own row
      // for the same reason Captures is one.
      {
        label: "Shared Drives",
        path: "/shared-drives",
        icon: <Users className={ICON_CLASS} strokeWidth={1.5} />,
        featureFlag: "sharedDrives",
      },
      // In Drive, as its own row: every capture is a file in a drive, so
      // this reads as a view of Drive.
      {
        label: "Captures",
        path: "/captures",
        icon: <Camera className={ICON_CLASS} strokeWidth={1.5} />,
        featureFlag: "capture",
      },
    ],
  },
  // The "Confidential Computing" group and its single Virtual Machines child
  // were removed on 2026-09-08: the group's only child is gated off by
  // VM_FEATURE_ENABLED, so it advertised a page that redirects. Restoring VM
  // when the flag flips means a plain item after DRIVE, named as in the
  // console (Confidential Compute > Virtual Machines) — not a wrapper group
  // around one gated child, which is what collapsed into a link to a 404.
  // The /vm routes and their redirect are untouched.
  {
    key: "account",
    label: "ACCOUNT",
    items: [
      // Money first, then people, then referrals. One entry for plans and
      // billing, named as in the console, that opens its own page under this
      // sidebar (`/billing`), where the plan catalogue, the subscription and
      // the credit balance all live. It is not in Settings, so it is not
      // offered twice; Settings redirects an old `?section=billing` here and
      // /drive-plans still resolves for deep links.
      {
        label: "Plans & Billing",
        path: BILLING_ROUTE,
        icon: <Icons.CreditCard className={ICON_CLASS} />,
      },
      {
        label: "Wallet",
        path: "/wallet",
        icon: <Icons.Wallet className={ICON_CLASS} />,
        featureFlag: "wallet",
      },
      // In Account, as in the console, with the parts of the account that
      // are about other people. Untitled under DRIVE it read as a fourth
      // Drive row.
      {
        label: "Chat",
        path: "/chat",
        icon: <MessagesSquare className={ICON_CLASS} strokeWidth={1.5} />,
        featureFlag: "chat",
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
    key: "support",
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
 * capability (passed in by the sidebar from `shareFeatureEnabledAtom`) and
 * `chat` is the runtime answer of Rust's `chat_get_config` (from
 * `chatEnabledAtom`; defaults to hidden until known), `wallet` and
 * `referrals` are the build-time `WALLET_FEATURE_ENABLED` /
 * `REFERRALS_FEATURE_ENABLED` flags (defaulted here so callers don't
 * re-import them), and `capture` is the capture flag AND Rust's support for
 * this computer (`useCaptureAvailability`), hidden unless said to be on: the
 * flag alone is true in production on platforms that cannot capture. Sections whose items are all filtered out are dropped
 * entirely so no orphaned heading renders.
 */
export function filterNavSections(
  sections: NavSection[],
  gates: {
    shareEnabled: boolean;
    chatEnabled?: boolean;
    walletEnabled?: boolean;
    referralsEnabled?: boolean;
    captureEnabled?: boolean;
    sharedDrivesEnabled?: boolean;
  },
): NavSection[] {
  const walletEnabled = gates.walletEnabled ?? WALLET_FEATURE_ENABLED;
  const sharedDrivesEnabled = gates.sharedDrivesEnabled ?? SHARED_DRIVES_ENABLED;
  const referralsEnabled =
    gates.referralsEnabled ?? REFERRALS_FEATURE_ENABLED;
  const captureEnabled = gates.captureEnabled === true;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (item.featureFlag === "shares") return gates.shareEnabled;
        if (item.featureFlag === "wallet") return walletEnabled;
        if (item.featureFlag === "referrals") return referralsEnabled;
        if (item.featureFlag === "chat") return gates.chatEnabled === true;
        if (item.featureFlag === "capture") return captureEnabled;
        if (item.featureFlag === "sharedDrives") return sharedDrivesEnabled;
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);
}
