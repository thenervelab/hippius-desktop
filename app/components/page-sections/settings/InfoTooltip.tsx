import React, { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Icons from "@/components/ui/icons";
import { openUrl } from "@tauri-apps/plugin-opener";

interface InfoTooltipProps {
  children: ReactNode;
  className?: string;
  iconSize?: number | string;
  iconColor?: string;
  learnMoreUrl?: string;
}

const InfoTooltip: React.FC<InfoTooltipProps> = ({
  children,
  className = "",
  iconSize = 4,
  iconColor = "text-grey-50",
  learnMoreUrl,
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
            <div>
              {children}
              {learnMoreUrl && (
                <>
                  {" "}
                  <button
                    onClick={() => openUrl(learnMoreUrl)}
                    className="text-primary-50 hover:text-primary-40 font-semibold underline"
                  >
                    Learn More
                  </button>
                </>
              )}
            </div>
            <Tooltip.Arrow className="fill-white" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};

export default InfoTooltip;
