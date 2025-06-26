"use client";

import Link from "next/link";
import { Home, FileText, Wallet, Bell, Settings, LogOut } from "lucide-react";
import { usePathname } from "next/navigation";
import { Icons } from "../ui";

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  href: string;
  active?: boolean;
}

const NavItem: React.FC<NavItemProps> = ({ icon, label, href, active }) => {
  return (
    <Link
      href={href}
      className={`flex items-center gap-1.5 px-3.5 py-1.5  rounded-lg ${
        active ? "bg-blue-50 text-blue-600" : "hover:bg-gray-100 text-gray-600"
      }`}
    >
      <span className="w-5 h-5">{icon}</span>
      <span className="text-sm font-medium">{label}</span>
    </Link>
  );
};

const Sidebar: React.FC = () => {
  const pathname = usePathname();

  return (
    <div className="fixed top-0 left-0 bottom-0 w-[145px] bg-white  flex flex-col ml-4 my-4 border border-grey-80 rounded">
      <Link
        className="flex text-lg items-center gap-x-2 hover:opacity-70 pt-2 px-2 duration-300 text-white"
        href="/"
      >
        <div className="block  rounded-lg bg-primary-50 ">
          <Icons.HippiusLogo className="size-8" />
        </div>

        <span className="font-medium text-grey-10 text-base">Hippius</span>
      </Link>
      <div className=" cursor-pointer p-1.5 border border-gray-80 rounded  self-start mx-2 my-4 ">
        <Icons.SideBarLeft className="size-4" />
      </div>

      <div className="flex gap-4 flex-col flex-1 pt-4 border-t border-gray-80">
        <NavItem
          icon={<Home size={18} />}
          label="Home"
          href="/"
          active={pathname === "/"}
        />
        <NavItem
          icon={<FileText size={18} />}
          label="Files"
          href="/files"
          active={pathname === "/files"}
        />
        <NavItem
          icon={<Wallet size={18} />}
          label="Wallet"
          href="/wallet"
          active={pathname === "/wallet"}
        />
        <NavItem
          icon={<Bell size={18} />}
          label="Notification"
          href="/notification"
          active={pathname === "/notification"}
        />
        <NavItem
          icon={<Settings size={18} />}
          label="Settings"
          href="/settings"
          active={pathname === "/settings"}
        />
      </div>

      <div className="pt-2 border-t border-gray-200 mt-2">
        <NavItem icon={<LogOut size={18} />} label="Logout" href="/logout" />

        <div className="flex items-center text-xs text-gray-400 mt-4 px-4">
          <span>VER</span>
          <span className="ml-2">0.1.10</span>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;
