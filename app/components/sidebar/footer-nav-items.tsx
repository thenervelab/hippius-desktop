import cn from "@/app/lib/utils/cn";
import { RevealTextLine } from "../ui";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

interface FooterNavItemProps {
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
  className?: string;
  inView: boolean;
}

const FooterNavItem: React.FC<FooterNavItemProps> = ({
  icon,
  label,
  collapsed,
  className,
  inView,
}) => {
  const { logout } = useWalletAuth();
  return (
    <div
      className={cn(
        " transition-all  duration-300  relative group cursor-pointer",
        "hover:bg-gray-100 hover:text-red-600 text-error-80",
        className
      )}
      onClick={() => logout()}
    >
      <RevealTextLine
        reveal={inView}
        parentClassName="block"
        className="flex items-center py-1.5 px-3.5 h-8"
      >
        <span className="size-4 flex-shrink-0">{icon}</span>
        {!collapsed && (
          <span className="text-sm font-medium whitespace-nowrap ml-1.5 overflow-hidden transition-opacity duration-300">
            {label}
          </span>
        )}
      </RevealTextLine>
    </div>
  );
};

export default FooterNavItem;
