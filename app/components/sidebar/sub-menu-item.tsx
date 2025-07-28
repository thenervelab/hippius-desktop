import React from "react";
import Link from "next/link";
import cn from "@/app/lib/utils/cn";
import { SubMenuItemData } from "./nav-data";
import { Graphsheet, RevealTextLine } from "../ui";
import { ArrowRight } from "lucide-react";
import { useAtom } from "jotai";
import { activeSubMenuItemAtom } from "./sideBarAtoms";
interface Props extends SubMenuItemData {
  inView?: boolean;
  onItemClick?: () => void;
}

const SubMenuItem: React.FC<Props> = ({
  label,
  path,
  icon,
  comingSoon,
  inView = true,
  onItemClick,
}) => {
  const [activeSubMenuItem, setActiveSubMenuItem] = useAtom(
    activeSubMenuItemAtom
  );
  const active = activeSubMenuItem === label;

  const handleClick = () => {
    if (comingSoon) return;
    setActiveSubMenuItem(label);
    onItemClick?.();
  };
  const navContent = (
    <RevealTextLine
      reveal={inView}
      parentClassName="block"
      className="flex items-center py-1.5 px-3.5 h-8 "
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
          !active && "opacity-0 transition-opacity duration-300",
          !active && !comingSoon && "group-hover:opacity-100"
        )}
      />
      <ArrowRight className={"h-6 w-6 mr-2"} />

      {icon && (
        <span
          className={cn("size-4 flex-shrink-0", {
            "opacity-40": comingSoon,
          })}
        >
          {icon}
        </span>
      )}
      <div className="ml-1.5 flex items-center w-full">
        <span
          className={cn(
            "text-sm font-medium whitespace-nowrap overflow-hidden transition-opacity duration-300",
            comingSoon && "text-gray-400"
          )}
        >
          {label}
        </span>

        {comingSoon && (
          <span className="text-[9px] text-amber-700 px-1.5 py-0.5 rounded-sm whitespace-nowrap absolute right-0 -top-1">
            Coming Soon
          </span>
        )}
      </div>
    </RevealTextLine>
  );

  if (comingSoon) {
    return (
      <div
        className={cn(
          "transition-all duration-300 relative group cursor-not-allowed opacity-70"
        )}
      >
        {navContent}
      </div>
    );
  }

  return (
    <Link
      href={path}
      className={cn("transition-all duration-300 relative group", {
        "bg-blue-50 text-primary-40": active,
        "hover:bg-gray-100 hover:text-primary-40 text-grey-40": !active,
      })}
      onClick={handleClick}
    >
      {navContent}
    </Link>
  );
};

export default SubMenuItem;
