import React from "react";
import { CopyText } from "@/components/ui";
import { cn, shortenCopyAbleText } from "@/app/lib/utils";
import { useBreakpoint } from "@/app/lib/hooks";
import { openUrl } from "@tauri-apps/plugin-opener";

export const CopyableCell: React.FC<{
  copyAbleText: string;
  link?: string;
  title: string;
  toastMessage: string;
  forSmallScreen?: boolean;
  copyIconClassName?: string;
  checkIconClassName?: string;
  buttonClass?: string;
  textColor?: string;
  className?: string;
  isTable?: boolean;
  linkClass?: string;
}> = ({
  copyAbleText,
  link,
  title,
  toastMessage,
  forSmallScreen,
  copyIconClassName,
  buttonClass,
  textColor,
  checkIconClassName,
  className,
  isTable,
  linkClass,
}) => {
    const { isMobile, isLaptop, isDesktop, isLargeDesktop } = useBreakpoint();
    console.log("forSmallScreen", forSmallScreen)
    console.log("isTable", isTable)

    const display = forSmallScreen
      ? shortenCopyAbleText(copyAbleText)
      : shortenCopyAbleText(copyAbleText, {
        isMobile,
        isLaptop,
        isDesktop,
        isLargeDesktop,
        isTable,
      });
    return (
      <CopyText
        text={copyAbleText}
        title={title}
        toastMessage={toastMessage}
        copyIconClassName={copyIconClassName}
        buttonClass={buttonClass}
        checkIconClassName={checkIconClassName}
        className={className}
      >
        {link ? (
          <div
            className={cn("text-grey-20 hover:text-primary-50 cursor-pointer", linkClass)}
            onClick={async () => {
              try {
                await openUrl(link);
              } catch (error) {
                console.error("Failed to open Explorer:", error);
              }
            }}
          >
            {display}
          </div>
        ) : (
          <span
            onClick={(e) => e.stopPropagation()}
            className={cn(textColor ? textColor : "text-grey-20")}
          >
            {display}
          </span>
        )}
      </CopyText>
    );
  };
