import { Icons } from "@/components/ui";
import { LockKeyhole, LockKeyholeOpen, Share2Icon } from "lucide-react";

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
    isActive: true
  },
  {
    label: "Files",
    path: "/files",
    icon: <Icons.DocumentText />,
    subMenuItems: [
      {
        label: "Private",
        path: "/files",
        icon: <LockKeyhole className="size-4" />
      },
      {
        label: "Public",
        path: "/files",
        icon: <LockKeyholeOpen className="size-4" />
      }
    ]
  },
  {
    label: "Wallet",
    path: "/wallet",
    icon: <Icons.Wallet />
  },
  {
    label: "Billing",
    path: "/billing",
    icon: <Icons.CreditCard />
  },
  {
    label: "Notifications",
    path: "/notifications",
    icon: <Icons.Notification />
  },
  {
    label: "Referrals",
    path: "/referrals",
    icon: <Share2Icon className="size-4" />
  },
  {
    label: "Settings",
    path: "/settings",
    icon: <Icons.Setting />
  }
];

export const footerNavItems: FooterNavItemData[] = [
  {
    label: "Logout",
    icon: <Icons.Logout />
  }
];
