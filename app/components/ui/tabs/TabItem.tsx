/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { cn } from "@/lib/utils";
import ActiveTabBg from "./ActiveTabBg";

export interface TabItemProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  width?: string;
  height?: string;
  isJustifyStart?: boolean;
}

const TabItem: React.FC<TabItemProps> = ({
  label,
  icon,
  isActive,
  onClick,
  width = "min-w-[148px]",
  height = "h-[36px]",
  isJustifyStart = false
}) => {
  return (
    <div
      className={cn(
        "flex items-center gap-2  relative transition-all duration-300 cursor-pointer",
        width,
        height,
        isActive ? "text-primary-50" : "text-grey-70",
        isJustifyStart ? "px-2" : "px-4"
      )}
      onClick={onClick}
    >
      {isActive && <ActiveTabBg mainGroup={true} />}
      <div
        className={cn(
          "relative z-10 flex items-center justify-center gap-2 w-full",
          isActive ? "text-primary-50" : "text-grey-70 hover:text-primary-50",
          isJustifyStart ? "justify-start" : "justify-center"
        )}
      >
        <span>
          {React.cloneElement(icon as React.ReactElement<any>, {
            className: "size-[18px]"
          })}
        </span>
        <span className="font-medium text-[14px]">{label}</span>
      </div>
    </div>
  );
};

export default TabItem;
