import { Icons } from "@/components/ui";
import { Server, Share2Icon } from "lucide-react";
import Support from "../ui/icons/Support";

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
}

export interface FooterNavItemData {
  label: string;
  icon: React.ReactNode;
}

export const navItems: NavItemData[] = [
  {
    label: "Home",
    path: "/",
    icon: <Icons.Home />,
    isActive: true,
  },
  {
    label: "Drive",
    path: "/files",
    icon: <Icons.DocumentText />,
  },
  {
    label: "Virtual Machines",
    path: "/vm",
    icon: <Server className="size-4" />,
  },
  // {
  //   label: "Wallet",
  //   path: "/wallet",
  //   icon: <Icons.Wallet />
  // },
  {
    label: "Billing",
    path: "/billing",
    icon: <Icons.CreditCard />,
  },
  {
    label: "Referrals",
    path: "/referrals",
    icon: <Share2Icon className="size-4" />,
  },
  {
    label: "Help & Support",
    path: "/support",
    icon: <Support className="size-4" />,
  },
  {
    label: "Settings",
    path: "/settings",
    icon: <Icons.Setting />,
  },
];

export const footerNavItems: FooterNavItemData[] = [
  {
    label: "Logout",
    icon: <Icons.Logout />,
  },
];
