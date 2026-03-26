import React, { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Icons from "./icons";

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
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`inline-flex items-center justify-center outline-none ${className}`}
          >
            <Icons.QuestionCircle
              className={`size-${iconSize} ${iconColor} cursor-pointer`}
            />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            align="center"
            sideOffset={8}
            className="
              z-[9999] max-w-[260px]
              bg-white border border-grey-80 rounded-[8px]
              px-2 py-2 text-[10px] font-medium text-grey-40 shadow-lg
              whitespace-normal break-words
              animate-in fade-in-0 zoom-in-95
              data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95
            "
          >
            {children}
            <Tooltip.Arrow className="fill-white" width={14} height={7} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};

export default InfoTooltip;
