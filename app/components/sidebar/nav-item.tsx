import Link from "next/link";
import cn from "@/app/lib/utils/cn";
import { Graphsheet } from "../ui";

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  href: string;
  active?: boolean;
  collapsed?: boolean;
  className?: string;
}

const NavItem: React.FC<NavItemProps> = ({
  icon,
  label,
  href,
  active,
  collapsed,
  className,
}) => {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center py-1.5 transition-all px-3.5 duration-300 h-8 relative group",
        {
          "bg-blue-50 text-primary-40": active,
          "hover:bg-gray-100 hover:text-primary-40 text-grey-70":
            !active && label !== "Logout",
          "hover:bg-gray-100 text-error-80": label === "Logout",
        },
        className
      )}
    >
      {active && (
        <Graphsheet
          majorCell={{
            lineColor: [31, 80, 189, 1.0],
            lineWidth: 2,
            cellDim: 40,
          }}
          minorCell={{
            lineColor: [49, 103, 211, 1.0],
            lineWidth: 1,
            cellDim: 5,
          }}
          className={"absolute w-full h-full top-0 bottom-0 left-0 opacity-20"}
        />
      )}

      <div
        className={cn(
          "absolute left-[3px] bg-primary-50 w-0.5 h-[22px] rounded-3xl",
          !active &&
            "opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        )}
      />
      <span className="size-4 flex-shrink-0">{icon}</span>
      {!collapsed && (
        <span className="text-sm font-medium whitespace-nowrap ml-1.5 overflow-hidden transition-opacity duration-300">
          {label}
        </span>
      )}
    </Link>
  );
};

export default NavItem;
