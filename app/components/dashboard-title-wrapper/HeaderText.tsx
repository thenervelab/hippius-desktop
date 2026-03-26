import { useAtomValue } from "jotai";
import { useRef, useState, useEffect, useCallback } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";

import { P } from "@/components/ui/typography";
import { dashboardPageHeaderAtom } from "./dashboardAtoms";

/**
 * Truncates text from the middle to fit a given character budget.
 */
function middleTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor((maxLen - 1) / 2);
  return text.slice(0, half) + "…" + text.slice(text.length - half);
}

/** Extract only the folder/page name portion (after " - " prefix like "Your Files - ") */
function extractFolderName(text: string): string {
  const dashIndex = text.indexOf(" - ");
  return dashIndex !== -1 ? text.slice(dashIndex + 3) : text;
}

const HeaderText = () => {
  const dashHeader = useAtomValue(dashboardPageHeaderAtom);
  const containerRef = useRef<HTMLDivElement>(null);
  const [displayText, setDisplayText] = useState(dashHeader.mainText);
  const [isTruncated, setIsTruncated] = useState(false);

  const headerTextKey = dashHeader.mainText + dashHeader.subText;

  const recalculate = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const fullText = dashHeader.mainText;
    // Measure available width vs character width using a temporary span
    const span = document.createElement("span");
    span.style.visibility = "hidden";
    span.style.position = "absolute";
    span.style.whiteSpace = "nowrap";
    span.style.font = getComputedStyle(container).font;
    span.textContent = "W"; // reference character
    container.appendChild(span);
    const charWidth = span.getBoundingClientRect().width;
    container.removeChild(span);

    const availableWidth = container.getBoundingClientRect().width;
    const maxChars = Math.floor(availableWidth / charWidth);
    const truncated = fullText.length > Math.max(maxChars, 10);

    setIsTruncated(truncated);
    setDisplayText(middleTruncate(fullText, Math.max(maxChars, 10)));
  }, [dashHeader.mainText]);

  useEffect(() => {
    recalculate();
    const observer = new ResizeObserver(recalculate);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [recalculate]);

  const titleElement = (
    <P
      size="xl"
      className="animate-fade-in-from-b-0.3 opacity-0 whitespace-nowrap"
      key={"t" + headerTextKey}
    >
      {displayText}
    </P>
  );

  return (
    <div className="min-w-0 flex-1" ref={containerRef}>
      <div className="flex items-center gap-x-2 min-w-0">
        {isTruncated ? (
          <Tooltip.Provider delayDuration={200}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <div className="min-w-0">{titleElement}</div>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  side="bottom"
                  className="z-50 bg-white border border-grey-80 rounded-[8px] px-3 py-2 text-sm font-medium text-grey-40 shadow-lg max-w-[400px] w-max whitespace-normal break-all transition-opacity duration-200 data-[state=closed]:opacity-0 data-[state=open]:opacity-100"
                  sideOffset={4}
                >
                  {extractFolderName(dashHeader.mainText)}
                  <Tooltip.Arrow className="fill-white" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        ) : (
          titleElement
        )}
        {dashHeader.infoTooltip && (
          <div className="animate-fade-in-from-b-0.3 opacity-0 flex items-center shrink-0">
            {dashHeader.infoTooltip}
          </div>
        )}
      </div>
      {dashHeader.subText && (
        <P
          style={{
            animationDelay: "0.2s",
          }}
          size="md"
          key={headerTextKey}
          className="mt-0.5 text-grey-50 animate-fade-in-from-b-0.3 opacity-0"
        >
          {dashHeader.subText}
        </P>
      )}
    </div>
  );
};
export default HeaderText;
