"use client";

import Image from "next/image";
import Link from "next/link";
import { Home, FileText, Wallet, Bell, Settings, LogOut } from "lucide-react";
import { usePathname } from "next/navigation";

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
      className={`flex items-center space-x-3 px-4 py-2 my-1 rounded-lg ${
        active 
          ? "bg-blue-50 text-blue-600" 
          : "hover:bg-gray-100 text-gray-600"
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
    <div className="fixed top-0 left-0 bottom-0 w-[200px] bg-white border-r border-gray-200 flex flex-col p-4">
      <div className="flex items-center px-4 py-3">
        Logo
        <span className="font-bold text-lg">Hippius</span>
      </div>
      
      <div className="flex-1 mt-6">
        <NavItem icon={<Home size={18} />} label="Home" href="/" active={pathname === '/'} />
        <NavItem icon={<FileText size={18} />} label="Files" href="/files" active={pathname === '/files'} />
        <NavItem icon={<Wallet size={18} />} label="Wallet" href="/wallet" active={pathname === '/wallet'} />
        <NavItem icon={<Bell size={18} />} label="Notification" href="/notification" active={pathname === '/notification'} />
        <NavItem icon={<Settings size={18} />} label="Settings" href="/settings" active={pathname === '/settings'} />
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
