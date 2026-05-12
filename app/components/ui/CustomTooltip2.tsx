import React, { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Icons from "@/components/ui/icons";

interface InfoTooltipProps {
  children?: ReactNode;
  className?: string;
  iconSize?: number | string;
  iconColor?: string;
  showInfo?: boolean;
  tooltipContent?: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  disabled?: boolean;
}

const CustomTooltip2: React.FC<InfoTooltipProps> = ({
  children,
  className = "",
  iconSize = 4,
  iconColor = "text-grey-50",
  tooltipContent,
  showInfo,
  side = undefined,
  disabled = false,
}) => {
  if (disabled) {
    return (
      <div className={`inline-block ${className}`}>
        {children}
        {showInfo && (
          <Icons.QuestionCircle
            className={`size-${iconSize} ${iconColor} cursor-pointer`}
          />
        )}
      </div>
    );
  }

  return (
    <Tooltip.Provider>
      <Tooltip.Root delayDuration={200}>
        <Tooltip.Trigger asChild>
          <div className={`inline-block ${className}`}>
            {children}
            {showInfo && (
              <Icons.QuestionCircle
                className={`size-${iconSize} ${iconColor} cursor-pointer`}
              />
            )}
          </div>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={side}
            className="
              z-50 bg-white border border-grey-80 rounded-[0.5rem]
              px-2 py-2 text-[0.625rem] font-medium text-grey-40 shadow-lg
              max-w-[16.25rem] w-max whitespace-normal break-words
              transition-opacity duration-200
              data-[state=closed]:opacity-0 data-[state=open]:opacity-100
            "
            sideOffset={4}
          >
            {tooltipContent}
            <Tooltip.Arrow className="fill-white" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};

export default CustomTooltip2;
