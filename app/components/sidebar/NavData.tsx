import { Icons } from "@/components/ui";
import { Monitor, Share2Icon } from "lucide-react";
import Support from "../ui/icons/Support";
import SidebarVm from "../ui/icons/SidebarVm";

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
  // Capability gate consulted by the sidebar before rendering this
  // item. `"shares"` hides the entry until the connected hcfs-server
  // advertises `shares: true` (see `shareFeatureEnabledAtom`). Adding
  // a new gate is one entry here plus one branch in the sidebar.
  featureFlag?: "shares";
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
      {
        label: "Confidential Computing",
        path: "/vm",
        icon: <Monitor className={ICON_CLASS} strokeWidth={1.5} />,
        subMenuItems: [
          {
            label: "Virtual Machines",
            path: "/vm",
            icon: <SidebarVm className={ICON_CLASS} strokeWidth={1.5} />,
          },
        ],
      },
    ],
  },
  {
    label: "ACCOUNT",
    items: [
      {
        label: "Billing",
        path: "/billing",
        icon: <Icons.CreditCard className={ICON_CLASS} />,
      },
      {
        label: "Wallet",
        path: "/wallet",
        icon: <Icons.Wallet className={ICON_CLASS} />,
      },
      {
        label: "Referrals",
        path: "/referrals",
        icon: <Share2Icon className={ICON_CLASS} strokeWidth={1.5} />,
      },
    ],
  },
  {
    label: "SUPPORT",
    items: [
      {
        label: "Help & Support",
        path: "/support",
        icon: <Support className={ICON_CLASS} />,
      },
    ],
  },
];
