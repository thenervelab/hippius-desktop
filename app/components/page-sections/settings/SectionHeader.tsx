import React from "react";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { IconComponent } from "@/app/lib/types";

interface SectionHeaderProps {
  Icon: IconComponent;
  title: string;
  subtitle: string;
  iconSize?: "small" | "large";
}

const SectionHeader: React.FC<SectionHeaderProps> = ({
  Icon,
  title,
  subtitle,
  iconSize = "large", // Default to large
}) => {
  const wrapperSize = iconSize === "small" ? "size-8" : "size-8 sm:size-10";
  const iconSizeClass = iconSize === "small" ? "size-4" : "size-5 sm:size-6";

  return (
    <div className="flex items-center gap-2">
      <AbstractIconWrapper className={`${wrapperSize} bg-grey-10 relative`}>
        <Icon className={`absolute ${iconSizeClass} text-primary-50`} />
      </AbstractIconWrapper>
      <div className="flex flex-col">
        <h2 className="text-lg leading-6 text-grey-10 font-medium">{title}</h2>
        <div className="text-sm text-grey-60">{subtitle}</div>
      </div>
    </div>
  );
};

export default SectionHeader;
