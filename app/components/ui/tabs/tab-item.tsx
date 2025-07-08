/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { cn } from "@/lib/utils";
import ActiveTabBg from "./active-tab-bg";

export interface TabItemProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
}

const TabItem: React.FC<TabItemProps> = ({
  label,
  icon,
  isActive,
  onClick,
}) => {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 relative transition-all duration-300 cursor-pointer min-w-[148px] h-[36px]",
        isActive ? "text-primary-50" : "text-grey-70 "
      )}
      onClick={onClick}
    >
      {isActive && <ActiveTabBg mainGroup={true} />}
      <div
        className={cn(
          "relative z-10 flex items-center justify-center gap-2 w-full",
          isActive ? "text-primary-50" : "text-grey-70 hover:text-primary-50"
        )}
      >
        <span>
          {React.cloneElement(icon as React.ReactElement<any>, {
            className: "size-[18px]",
          })}
        </span>
        <span className={"font-medium text-[14px]"}>{label}</span>
      </div>
    </div>
  );
};

export default TabItem;
