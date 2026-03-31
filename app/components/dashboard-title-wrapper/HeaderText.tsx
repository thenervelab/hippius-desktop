import { useAtomValue } from "jotai";
import { useRef, useState, useCallback } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";

import { P } from "@/components/ui/typography";
import { dashboardPageHeaderAtom } from "./dashboardAtoms";

const HeaderText = () => {
  const dashHeader = useAtomValue(dashboardPageHeaderAtom);
  const headerTextKey = dashHeader.mainText + dashHeader.subText;
  const subTextRef = useRef<HTMLParagraphElement>(null);
  const [subTextTruncated, setSubTextTruncated] = useState(false);

  const checkSubTextTruncation = useCallback(() => {
    const el = subTextRef.current;
    if (el) {
      setSubTextTruncated(el.scrollWidth > el.clientWidth);
    }
  }, []);

  return (
    <div className="min-w-0 flex-1 basis-[12rem]">
      <div className="flex items-center gap-x-2 min-w-0">
        <Tooltip.Provider delayDuration={200}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <P
                size="xl"
                className="animate-fade-in-from-b-0.3 opacity-0 truncate"
                key={"t" + headerTextKey}
              >
                {dashHeader.mainText}
              </P>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="bottom"
                className="z-50 bg-white border border-grey-80 rounded-[0.5rem] px-3 py-2 text-sm font-medium text-grey-40 shadow-lg max-w-[25rem] w-max whitespace-normal break-all transition-opacity duration-200 data-[state=closed]:opacity-0 data-[state=open]:opacity-100"
                sideOffset={4}
              >
                {dashHeader.mainText}
                <Tooltip.Arrow className="fill-white" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
        {dashHeader.infoTooltip && (
          <div className="animate-fade-in-from-b-0.3 opacity-0 flex items-center shrink-0">
            {dashHeader.infoTooltip}
          </div>
        )}
      </div>
      {dashHeader.subText && (
        <Tooltip.Provider delayDuration={200}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <P
                ref={subTextRef}
                onMouseEnter={checkSubTextTruncation}
                style={{
                  animationDelay: "0.2s",
                }}
                size="md"
                key={headerTextKey}
                className="mt-0.5 text-grey-50 animate-fade-in-from-b-0.3 opacity-0 truncate"
              >
                {dashHeader.subText}
              </P>
            </Tooltip.Trigger>
            {subTextTruncated && (
              <Tooltip.Portal>
                <Tooltip.Content
                  side="bottom"
                  className="z-50 bg-white border border-grey-80 rounded-[0.5rem] px-3 py-2 text-sm font-medium text-grey-40 shadow-lg max-w-[25rem] w-max whitespace-normal break-words transition-opacity duration-200 data-[state=closed]:opacity-0 data-[state=open]:opacity-100"
                  sideOffset={4}
                >
                  {dashHeader.subText}
                  <Tooltip.Arrow className="fill-white" />
                </Tooltip.Content>
              </Tooltip.Portal>
            )}
          </Tooltip.Root>
        </Tooltip.Provider>
      )}
    </div>
  );
};
export default HeaderText;
