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
  showCopyAbleText?: boolean;
  isJustifyCenter?: boolean;
  numberOfCharactersFromStartAndEnd?: number;
}> = ({
  copyAbleText,
  link,
  title,
  toastMessage,
  forSmallScreen,
  copyIconClassName,
  showCopyAbleText = true,
  isJustifyCenter = false,
  buttonClass,
  textColor,
  checkIconClassName,
  className,
  isTable,
  linkClass,
  numberOfCharactersFromStartAndEnd,
}) => {
  const { isMobile, isTablet, isLaptop, isDesktop, isLargeDesktop } =
    useBreakpoint();
  console.log("forSmallScreen", forSmallScreen);
  console.log("isTable", isTable);

  let display;

  // For Arion hashes or similar long strings, use the truncation style provided
  if (numberOfCharactersFromStartAndEnd) {
    display = shortenCopyAbleText(copyAbleText, {
      style: "middle",
      startLen:
        numberOfCharactersFromStartAndEnd > 30 && isLargeDesktop
          ? numberOfCharactersFromStartAndEnd
          : isMobile
          ? 8
          : isTablet
          ? 10
          : isLaptop
          ? 12
          : 20,
      endLen:
        numberOfCharactersFromStartAndEnd > 30 && isLargeDesktop
          ? numberOfCharactersFromStartAndEnd
          : isMobile
          ? 5
          : isTablet
          ? 7
          : isLaptop
          ? 10
          : 15,
    });
  } else if (forSmallScreen) {
    display = shortenCopyAbleText(copyAbleText);
  } else {
    display = shortenCopyAbleText(copyAbleText, {
      isMobile,
      isLaptop,
      isDesktop,
      isLargeDesktop,
      isTable,
    });
  }
  return (
    <CopyText
      text={copyAbleText}
      title={title}
      toastMessage={toastMessage}
      copyIconClassName={copyIconClassName}
      buttonClass={buttonClass}
      checkIconClassName={checkIconClassName}
      className={className}
      isJustifyCenter={isJustifyCenter}
    >
      {link ? (
        <div
          className={cn(
            "text-grey-20 hover:text-primary-50 cursor-pointer",
            linkClass
          )}
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
        showCopyAbleText && (
          <span
            onClick={(e) => e.stopPropagation()}
            className={cn(textColor ? textColor : "text-grey-20")}
          >
            {display}
          </span>
        )
      )}
    </CopyText>
  );
};
