import Link from "next/link";
import cn from "@/app/lib/utils/cn";
import { Graphsheet, RevealTextLine } from "../ui";

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  href: string;
  active?: boolean;
  collapsed?: boolean;
  className?: string;
  inView: boolean;
  comingSoon?: boolean;
}

const NavItem: React.FC<NavItemProps> = ({
  icon,
  label,
  href,
  active,
  collapsed,
  className,
  inView,
  comingSoon,
}) => {
  // Create the content of the navigation item
  const navContent = (
    <RevealTextLine
      reveal={inView}
      parentClassName="block"
      className="flex items-center py-1.5 px-3.5 h-8"
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
          !active && "opacity-0  transition-opacity duration-300",
          !active &&
            label !== "Logout" &&
            !comingSoon &&
            "group-hover:opacity-100"
        )}
      />

      <span
        className={cn("size-4 flex-shrink-0", {
          "opacity-40": comingSoon,
        })}
      >
        {icon}
      </span>
      {!collapsed && (
        <div className="ml-1.5 flex items-center">
          <span
            className={cn(
              "text-sm font-medium whitespace-nowrap overflow-hidden transition-opacity duration-300",
              comingSoon && "text-gray-400"
            )}
          >
            {label}
          </span>

          {comingSoon && !collapsed && (
            <span className=" text-[9px]  text-amber-700 px-1.5 py-0.5 rounded-sm whitespace-nowrap absolute right-0 -top-1">
              Coming Soon
            </span>
          )}
        </div>
      )}
    </RevealTextLine>
  );

  // If comingSoon is true, render a div instead of a Link
  if (comingSoon) {
    return (
      <div
        className={cn(
          "transition-all duration-300 relative group cursor-not-allowed opacity-70",
          className
        )}
      >
        {navContent}
      </div>
    );
  }

  // Otherwise, render a regular Link
  return (
    <Link
      href={href}
      className={cn(
        "transition-all duration-300 relative group",
        {
          "bg-blue-50 text-primary-40": active,
          "hover:bg-gray-100 hover:text-primary-40 text-grey-70":
            !active && label !== "Logout",
          "hover:bg-gray-100 hover:text-red-600 text-error-80":
            label === "Logout",
        },
        className
      )}
    >
      {navContent}
    </Link>
  );
};

export default NavItem;
