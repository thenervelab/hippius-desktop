import React from "react";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { IconComponent } from "@/app/lib/types";
import InfoTooltip from "./InfoTooltip";
import cn from "@/app/lib/utils/cn";
import { HelpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

interface SectionHeaderProps {
  Icon: IconComponent;
  title: string;
  subtitle: React.ReactNode;
  iconSize?: "small" | "large";
  info?: string;
  learnMoreUrl?: string;
  /** If true, shows only a help button that opens learnMoreUrl instead of tooltip */
  helpButtonOnly?: boolean;
}

const SectionHeader: React.FC<SectionHeaderProps> = ({
  Icon,
  title,
  subtitle,
  iconSize = "large",
  info = "",
  learnMoreUrl,
  helpButtonOnly = false,
}) => {
  const wrapperSize = iconSize === "small" ? "size-8" : "size-8 sm:size-10";
  const iconSizeClass = iconSize === "small" ? "size-4" : "size-5 sm:size-6";

  return (
    <div className="flex items-center gap-2">
      <AbstractIconWrapper className={cn(wrapperSize, "relative")}>
        <Icon className={cn("absolute", iconSizeClass, "text-primary-50")} />
      </AbstractIconWrapper>
      <div className="flex flex-col">
        <div className="flex gap-2 mb-0.5 items-center">
          <div className="text-[16px] leading-[18px] text-grey-10 font-medium">
            {title}
          </div>
          {helpButtonOnly && learnMoreUrl ? (
            <button
              onClick={() => openUrl(learnMoreUrl)}
              aria-label={`${title} documentation`}
              title={`${title} documentation`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50"
            >
              <HelpCircle className="size-3.5" />
            </button>
          ) : info ? (
            <div className="size-4 flex items-center justify-center">
              <InfoTooltip iconColor="text-grey-60" learnMoreUrl={learnMoreUrl}>
                {info}
              </InfoTooltip>
            </div>
          ) : null}
        </div>
        <div className="text-sm text-grey-60">{subtitle}</div>
      </div>
    </div>
  );
};

export default SectionHeader;
