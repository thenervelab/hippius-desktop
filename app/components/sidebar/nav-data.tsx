import { Icons } from "../ui";

export interface NavItemData {
  label: string;
  path: string;
  icon: React.ReactNode;
  isActive?: boolean;
}

export const navItems: NavItemData[] = [
  {
    label: "Home",
    path: "/",
    icon: <Icons.Home />,
    isActive: true,
  },
  {
    label: "Files",
    path: "/files",
    icon: <Icons.DocumentText />,
  },
  {
    label: "Wallet",
    path: "/wallet",
    icon: <Icons.Wallet />,
  },
  {
    label: "Notification",
    path: "/notification",
    icon: <Icons.Notification />,
  },
  {
    label: "Settings",
    path: "/settings",
    icon: <Icons.Setting />,
  },
];

export const footerNavItems: NavItemData[] = [
  {
    label: "Logout",
    path: "/logout",
    icon: <Icons.Logout />,
  },
];
