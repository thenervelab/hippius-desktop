import React, { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Icons from "../../ui/icons";

interface InfoTooltipProps {
  children: ReactNode;
  className?: string;
  iconSize?: number | string;
  iconColor?: string;
}

const InfoTooltip: React.FC<InfoTooltipProps> = ({
  children,
  className = "",
  iconSize = 4,
  iconColor = "text-grey-50"
}) => {
  return (
    <Tooltip.Provider>
      <Tooltip.Root delayDuration={200}>
        <Tooltip.Trigger asChild>
          <div className={`inline-block ${className}`}>
            <Icons.InfoCircle
              className={`size-${iconSize} ${iconColor} cursor-pointer`}
            />
          </div>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="
              z-50 bg-white border border-grey-80 rounded-[8px]
              px-2 py-2 text-[10px] font-medium text-grey-40 shadow-lg
              max-w-[260px] w-max whitespace-normal break-words
              transition-opacity duration-200
              data-[state=closed]:opacity-0 data-[state=open]:opacity-100
            "
            sideOffset={8}
          >
            {children}
            <Tooltip.Arrow className="fill-white" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};

export default InfoTooltip;
