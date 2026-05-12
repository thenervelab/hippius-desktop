import React, { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

interface InfoTooltipProps {
  children: ReactNode;
  className?: string;
  learnMoreUrl?: string;
}

const InfoTooltip: React.FC<InfoTooltipProps> = ({
  children,
  className = "",
  learnMoreUrl,
}) => {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label="More information"
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-400 ${className}`}
          >
            <Info className="size-3.5" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="center"
            sideOffset={8}
            avoidCollisions
            collisionPadding={8}
            className="z-[9999] max-w-[260px] rounded-[8px] border border-grey-dark-100 bg-white px-3 py-[10px] text-[12px] font-medium leading-4 tracking-[-0.24px] text-[#52525c] shadow-[0px_4px_24px_0px_rgba(0,0,0,0.08)] dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-[#a3a3a3] dark:shadow-black/25"
          >
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
            <Tooltip.Arrow className="fill-white dark:fill-[#2c2c2c]" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};

export default InfoTooltip;
