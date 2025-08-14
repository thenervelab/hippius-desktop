import React from "react";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { IconComponent } from "@/app/lib/types";
import InfoTooltip from "./InfoTooltip";
import cn from "@/app/lib/utils/cn";

interface SectionHeaderProps {
  Icon: IconComponent;
  title: string;
  subtitle: string;
  iconSize?: "small" | "large";
  info?: string;
}

const SectionHeader: React.FC<SectionHeaderProps> = ({
  Icon,
  title,
  subtitle,
  iconSize = "large",
  info = "",
}) => {
  const wrapperSize = iconSize === "small" ? "size-8" : "size-8 sm:size-10";
  const iconSizeClass = iconSize === "small" ? "size-4" : "size-5 sm:size-6";

  return (
    <div className="flex items-center gap-2">
      <AbstractIconWrapper className={cn(wrapperSize, "relative")}>
        <Icon className={cn("absolute", iconSizeClass, "text-primary-50")} />
      </AbstractIconWrapper>
      <div className="flex flex-col">
        <div className="flex gap-2 mb-0.5">
          <div className="text-[16px] leading-[18px] text-grey-10 font-medium">
            {title}
          </div>
          {info && (
            <div className="size-4  flex items-center justify-center">
              <InfoTooltip iconColor="text-grey-60">{info}</InfoTooltip>
            </div>
          )}
        </div>
        <div className="text-sm text-grey-60">{subtitle}</div>
      </div>
    </div>
  );
};

export default SectionHeader;
